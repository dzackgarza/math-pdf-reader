//! Item titles and authors from the identifier resolvers ("Retrieve metadata", as Zotero names
//! it): the store finds an identifier for the item and runs the resolver plugin that accepts
//! it; the title, authors, year and abstract in the BibTeX the resolver prints become the
//! item's, recorded inside the PDF. Without a resolver the store reads them from the PDF itself.
use std::path::Path;

use biblatex::{Bibliography, ChunksRef, DateValue, PermissiveType, Person, RetrievalError};

use crate::contract::{NonEmpty, Resolution, RetrieveMetadataOutcome, TitleSource};
use crate::error::{AppError, AppResult};
use crate::store::{ResolvedMetadata, Store};

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

pub async fn retrieve_metadata(
    store: &Store,
    key: &str,
    resolvers_manifest: &Path,
) -> AppResult<RetrieveMetadataOutcome> {
    match store.resolve(key, resolvers_manifest).await? {
        Resolution::Unidentified { .. } => Ok(RetrieveMetadataOutcome::Unidentified),
        Resolution::Failed {
            plugin_id,
            identifier,
            exit_code,
            stderr,
            ..
        } => Ok(RetrieveMetadataOutcome::Failed {
            plugin_id,
            identifier,
            message: NonEmpty::try_from(format!("exit {exit_code}: {}", stderr.trim()))
                .expect("the message names the exit code"),
        }),
        Resolution::Resolved {
            plugin_id,
            identifier,
            bibtex,
            ..
        } => {
            let metadata = bibtex_metadata(&bibtex)?;
            store
                .record_metadata(key, TitleSource::Resolver, &metadata)
                .await?;
            Ok(RetrieveMetadataOutcome::Resolved {
                plugin_id,
                identifier,
                title: NonEmpty::try_from(metadata.title).expect("a resolved title is not empty"),
            })
        }
    }
}
