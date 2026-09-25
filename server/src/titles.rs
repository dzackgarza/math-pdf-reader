//! Item titles and authors from the identifier resolvers ("Retrieve metadata", as Zotero names
//! it): the server finds an identifier for the item and runs the resolver plugin that accepts
//! it; the title, authors, year and abstract in the BibTeX the resolver prints become the
//! item's, recorded inside the PDF. Without a resolver the store reads them from the PDF itself.
//!
//! The candidates, in order, are the item's source page URL and PDF URL from its provenance,
//! then the identifiers the publisher embedded in the file. The first candidate that a resolver
//! manifest plugin's identifier pattern accepts (without regard to case) is resolved by that
//! plugin: the identifier on its stdin, one BibTeX entry on its stdout, run in the manifest's
//! directory so relative paths in its command resolve there, and killed at the configured time
//! limit.
use std::process::Stdio;
use std::time::Duration;

use biblatex::{Bibliography, ChunksRef, DateValue, PermissiveType, Person, RetrievalError};
use tokio::io::AsyncWriteExt;

use crate::contract::{
    NonEmpty, ResolverManifest, ResolverManifestPluginsItem, RetrieveMetadataOutcome, TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::python::{exit_code, within};
use crate::state::AppState;
use crate::store::ResolvedMetadata;

// A field's text: braces and math delimiters dropped, as a reader sees it.
fn text(chunks: ChunksRef) -> String {
    chunks.iter().map(|chunk| chunk.v.get()).collect::<String>()
}

// A name as it is written in running text: given names, particle, family name, suffix.
fn written(person: &Person) -> String {
    let name = [&person.given_name, &person.prefix, &person.name]
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    if person.suffix.is_empty() {
        name
    } else {
        format!("{name}, {}", person.suffix)
    }
}

fn malformed(field: &str, error: RetrievalError) -> AppError {
    AppError::internal(format!("resolver BibTeX has a malformed {field}: {error}"))
}

/// Parses one BibTeX entry, turning its LaTeX into text and splitting `author` into names.
pub fn bibtex_metadata(bibtex: &str) -> AppResult<ResolvedMetadata> {
    let bibliography = Bibliography::parse(bibtex)
        .map_err(|error| AppError::internal(format!("resolver BibTeX does not parse: {error}")))?;
    let entry = bibliography
        .iter()
        .next()
        .ok_or_else(|| AppError::internal("resolver BibTeX holds no entry"))?;
    let title = text(entry.title().map_err(|error| malformed("title", error))?)
        .trim()
        .to_string();
    if title.is_empty() {
        return Err(AppError::internal(format!(
            "resolver BibTeX carries no title: {}",
            bibtex.chars().take(200).collect::<String>()
        )));
    }
    let authors = match entry.author() {
        Ok(people) => people.iter().map(written).collect(),
        Err(RetrievalError::Missing(_)) => Vec::new(),
        Err(error) => return Err(malformed("author", error)),
    };
    let year = match entry.date() {
        Ok(PermissiveType::Typed(date)) => Some(i64::from(match date.value {
            DateValue::At(start) | DateValue::After(start) | DateValue::Between(start, _) => {
                start.year
            }
            DateValue::Before(end) => end.year,
        })),
        Ok(PermissiveType::Chunks(_)) | Err(RetrievalError::Missing(_)) => None,
        Err(error) => return Err(malformed("date", error)),
    };
    let abstract_ = match entry.abstract_() {
        Ok(chunks) => Some(text(chunks).trim().to_string()).filter(|text| !text.is_empty()),
        Err(RetrievalError::Missing(_)) => None,
        Err(error) => return Err(malformed("abstract", error)),
    };
    Ok(ResolvedMetadata {
        title,
        authors,
        year,
        abstract_,
    })
}

/// What the resolvers made of an item: the plugin that answered with its BibTeX; no candidate
/// a plugin accepts; or the plugin that failed, ran past its time limit or printed no BibTeX.
pub enum Resolution {
    Resolved {
        plugin_id: NonEmpty,
        identifier: NonEmpty,
        bibtex: String,
    },
    Unidentified,
    Failed {
        plugin_id: NonEmpty,
        identifier: NonEmpty,
        message: NonEmpty,
    },
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("the text names what happened")
}

async fn manifest(state: &AppState) -> AppResult<ResolverManifest> {
    let path = &state.config.resolvers_manifest;
    let text = tokio::fs::read_to_string(path).await?;
    serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!("{} fails its schema: {error}", path.display()))
    })
}

// Whether one of PLUGIN's identifier patterns matches CANDIDATE from its start.
fn accepts(plugin: &ResolverManifestPluginsItem, candidate: &str) -> AppResult<bool> {
    for input in &plugin.accepted_inputs {
        let pattern = regress::Regex::with_flags(&input.pattern, "i").map_err(|error| {
            AppError::internal(format!(
                "resolver {} has an invalid pattern: {error}",
                *plugin.id
            ))
        })?;
        if pattern
            .find(candidate)
            .is_some_and(|found| found.start() == 0)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The item's identifier candidates, in order and each once.
async fn candidates(state: &AppState, key: &str) -> AppResult<Vec<String>> {
    let provenance = state.require(key).await?.stored.provenance;
    let mut all: Vec<String> = provenance.source_url.into_iter().collect();
    all.push(provenance.pdf_url);
    all.extend(state.store.embedded_identifiers(key).await?);
    let mut unique: Vec<String> = Vec::new();
    for candidate in all.iter().map(|candidate| candidate.trim()) {
        if !candidate.is_empty() && !unique.iter().any(|seen| seen == candidate) {
            unique.push(candidate.to_string());
        }
    }
    Ok(unique)
}

// Runs the resolver PLUGIN on IDENTIFIER.
async fn run(
    state: &AppState,
    plugin: &ResolverManifestPluginsItem,
    identifier: &str,
) -> AppResult<Resolution> {
    let failed = |message: String| Resolution::Failed {
        plugin_id: plugin.id.clone(),
        identifier: nonempty(identifier.to_string()),
        message: nonempty(message),
    };
    let (program, arguments) = plugin
        .command
        .split_first()
        .expect("the manifest schema requires a command");
    let directory = state
        .config
        .resolvers_manifest
        .parent()
        .expect("the manifest lies in a directory");
    let mut child = state
        .store
        .python()
        .command(program)
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::internal(format!("resolver {} did not start: {error}", *plugin.id))
        })?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let write = async move { stdin.write_all(identifier.as_bytes()).await };
    let limit = Duration::from_secs(state.config.app.plugins.resolver_timeout_seconds.get());
    let group = child.id();
    let finished = async { tokio::join!(write, child.wait_with_output()) };
    let Some((written, output)) = within(group, limit, finished).await? else {
        return Ok(failed(format!(
            "timed out after {} s and was killed",
            limit.as_secs()
        )));
    };
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(failed(format!(
            "exit {}: {}",
            exit_code(output.status),
            stderr.trim()
        )));
    }
    written?;
    let bibtex = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !bibtex.starts_with('@') {
        return Ok(failed(format!(
            "printed no BibTeX entry: {}",
            bibtex.chars().take(200).collect::<String>()
        )));
    }
    Ok(Resolution::Resolved {
        plugin_id: plugin.id.clone(),
        identifier: nonempty(identifier.to_string()),
        bibtex,
    })
}

/// Finds an identifier for KEY and resolves it with the first plugin that accepts it.
pub async fn resolve(state: &AppState, key: &str) -> AppResult<Resolution> {
    let manifest = manifest(state).await?;
    for candidate in candidates(state, key).await? {
        for plugin in &manifest.plugins {
            if accepts(plugin, &candidate)? {
                return run(state, plugin, &candidate).await;
            }
        }
    }
    Ok(Resolution::Unidentified)
}

async fn retrieve(state: &AppState, key: &str) -> AppResult<RetrieveMetadataOutcome> {
    Ok(match resolve(state, key).await? {
        Resolution::Unidentified => RetrieveMetadataOutcome::Unidentified,
        Resolution::Failed {
            plugin_id,
            identifier,
            message,
        } => RetrieveMetadataOutcome::Failed {
            plugin_id,
            identifier,
            message,
        },
        Resolution::Resolved {
            plugin_id,
            identifier,
            bibtex,
        } => {
            let metadata = bibtex_metadata(&bibtex)?;
            state
                .store
                .record_metadata(key, TitleSource::Resolver, &metadata)
                .await?;
            RetrieveMetadataOutcome::Resolved {
                plugin_id,
                identifier,
                title: nonempty(metadata.title),
            }
        }
    })
}

/// "Retrieve metadata" on KEY. A retrieval that failed in the bucket itself (a BibTeX entry
/// that does not parse, a store failure) is its `error` outcome; the item's title then stays as
/// it was.
pub async fn retrieve_metadata(state: &AppState, key: &str) -> RetrieveMetadataOutcome {
    match retrieve(state, key).await {
        Ok(outcome) => outcome,
        Err(error) => RetrieveMetadataOutcome::Error {
            message: nonempty(error.to_string()),
        },
    }
}
