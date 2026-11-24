//! Extraction plugins: the manifest listing, and runs on stored items. A run checks the PDF
//! against the plugin's limits, runs the plugin's command with `$pdf` and `$output` replaced by
//! the stored PDF and an empty output directory staged in the root, kills it at the configured
//! time limit, checks what it wrote, and has the store place `<key>.md` and `<key>.extraction/`
//! beside the PDF. A plugin that fails, is rejected or runs too long places nothing.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use walkdir::WalkDir;

use crate::config::{EXTRACTION_ARTIFACTS, EXTRACTION_MARKDOWN, EXTRACTION_METADATA};
use crate::contract::{
    ApiErrorErrorKind, ExtractionManifest, ExtractionManifestPluginsItem, ExtractionOutcome,
    ExtractionOutcomeRejectedViolationsItem, ExtractionOutcomeRejectedViolationsItemObserved,
    ExtractionOutcomeSucceededArtifactsItem, ExtractionOutcomeSucceededMarkdown,
    ExtractionPluginsResponse, ExtractionPluginsResponsePluginsItem, ExtractionSource,
    ExtractionSourceKind, NonEmpty, PdfLimit,
};
use crate::error::{AppError, AppResult};
use crate::index::IndexedItem;
use crate::layout::{self, Key};
use crate::python::{exit_code, within};
use crate::sources::sha256;
use crate::state::Shared;

async fn manifest(state: &Shared) -> AppResult<ExtractionManifest> {
    let path = &state.config.extractions_manifest;
    let text = tokio::fs::read_to_string(path).await?;
    let manifest: ExtractionManifest = serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!("{} fails its schema: {error}", path.display()))
    })?;
    if let Some(plugin) = manifest.plugins.iter().find(|plugin| {
        plugin.command.join(" ").split_whitespace().any(|word| {
            matches!(
                word.to_ascii_lowercase().as_str(),
                "pdftotext" | "pymupdf" | "fitz"
            )
        })
    }) {
        return Err(AppError::internal(format!(
            "plugin {} is a generic PDF text command, not a structured extraction provider",
            *plugin.id
        )));
    }
    Ok(manifest)
}

async fn plugins(State(state): State<Shared>) -> AppResult<Json<ExtractionPluginsResponse>> {
    Ok(Json(ExtractionPluginsResponse {
        plugins: manifest(&state)
            .await?
            .plugins
            .into_iter()
            .map(|plugin| ExtractionPluginsResponsePluginsItem {
                id: plugin.id,
                name: plugin.name,
                source_kind: plugin.source_kind,
                authoritative: plugin.authoritative,
                accepted_inputs: plugin.accepted_inputs,
            })
            .collect(),
    }))
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("the text is never empty")
}

fn source_matches_url(source: &ExtractionSource, pdf_url: &str) -> bool {
    let Ok(url) = url::Url::parse(pdf_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    match source {
        ExtractionSource::Arxiv => {
            (host == "arxiv.org" || host.ends_with(".arxiv.org"))
                && regex::Regex::new(
                    r"(?i)^/(?:pdf|abs|e-print)/(?:(?:[a-z-]+(?:\.[a-z]{2})?/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?/?$",
                )
                .expect("the arXiv URL pattern is valid")
                .is_match(url.path())
        }
    }
}

/// Every limit of an accepted input that the stored PDF violates. An input with no violations
/// accepts the PDF; a plugin with several inputs accepts it if any one input does.
fn violations(
    plugin: &ExtractionManifestPluginsItem,
    indexed: &IndexedItem,
) -> Vec<ExtractionOutcomeRejectedViolationsItem> {
    let failures: Vec<Vec<_>> = plugin
        .accepted_inputs
        .iter()
        .flat_map(|input| {
            let failed: Vec<_> = input
                .limits
                .iter()
                .filter_map(|limit| {
                    let observed = match limit {
                        PdfLimit::MaxPages(pages) => (indexed.pages > pages.get()).then(|| {
                            ExtractionOutcomeRejectedViolationsItemObserved::Integer(
                                i64::try_from(indexed.pages).expect("a page count fits i64"),
                            )
                        }),
                        PdfLimit::MaxBytes(bytes) => {
                            (indexed.size_bytes > bytes.get()).then(|| {
                                ExtractionOutcomeRejectedViolationsItemObserved::Integer(
                                    i64::try_from(indexed.size_bytes)
                                        .expect("a byte count fits i64"),
                                )
                            })
                        }
                        PdfLimit::Source(source) => {
                            (!source_matches_url(source, &indexed.stored.provenance.pdf_url)).then(
                                || {
                                    ExtractionOutcomeRejectedViolationsItemObserved::String(
                                        indexed.stored.provenance.pdf_url.clone(),
                                    )
                                },
                            )
                        }
                    };
                    observed.map(|observed| ExtractionOutcomeRejectedViolationsItem {
                        limit: limit.clone(),
                        observed,
                    })
                })
                .collect();
            std::iter::once(failed)
        })
        .collect();
    if failures.iter().any(Vec::is_empty) {
        Vec::new()
    } else {
        failures.into_iter().flatten().collect()
    }
}

/// The plugin's command with `$pdf` and `$output` replaced, as Python's `string.Template`
/// substitutes the two names the plugin contract defines.
fn arguments(plugin: &ExtractionManifestPluginsItem, pdf: &Path, output: &Path) -> Vec<String> {
    plugin
        .command
        .iter()
        .map(|argument| {
            argument
                .replace("$output", &output.to_string_lossy())
                .replace("$pdf", &pdf.to_string_lossy())
        })
        .collect()
}

/// Whether a successful plugin wrote an `artifacts/` directory; a plugin that broke the contract
/// (no non-blank `extraction.md`, or anything beside it and `artifacts/`) is a 502.
fn broken(message: String) -> AppError {
    AppError::api(
        StatusCode::BAD_GATEWAY,
        ApiErrorErrorKind::PluginContractBroken,
        message,
    )
}

fn produced(plugin_id: &str, output: &Path) -> AppResult<bool> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(output)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    let kept = names
        .iter()
        .all(|name| name == EXTRACTION_MARKDOWN || name == EXTRACTION_ARTIFACTS)
        && names.iter().any(|name| name == EXTRACTION_MARKDOWN);
    if !kept {
        return Err(broken(format!(
            "plugin {plugin_id} wrote {names:?}, not {EXTRACTION_MARKDOWN} and {EXTRACTION_ARTIFACTS}/"
        )));
    }
    if std::fs::read_to_string(output.join(EXTRACTION_MARKDOWN))?
        .trim()
        .is_empty()
    {
        return Err(broken(format!(
            "plugin {plugin_id} wrote an empty {EXTRACTION_MARKDOWN}"
        )));
    }
    Ok(names.iter().any(|name| name == EXTRACTION_ARTIFACTS))
}

fn artifact(path: &Path, relative: &Path) -> AppResult<(NonEmpty, crate::contract::Sha256, i64)> {
    if !path.symlink_metadata()?.is_file() {
        return Err(broken(format!(
            "expected a regular file at {}",
            path.display()
        )));
    }
    let bytes = std::fs::read(path)?;
    Ok((
        nonempty(relative.to_string_lossy().into_owned()),
        sha256(&bytes)
            .try_into()
            .expect("a SHA-256 digest is 64 hex digits"),
        i64::try_from(bytes.len()).map_err(AppError::internal)?,
    ))
}

// Read every result while it is staged. A bad artifact must fail the run before publication.
fn staged_result(
    output: &Path,
    key: &str,
    plugin: &ExtractionManifestPluginsItem,
) -> AppResult<ExtractionOutcome> {
    let parsed = Key::parse(key).expect("an indexed key is a key");
    let root = Path::new("");
    let document = layout::document_dir(root, &parsed);
    let public_markdown = layout::markdown_path(root, &parsed);
    let (path, sha256, size) = artifact(
        &output.join(EXTRACTION_MARKDOWN),
        public_markdown
            .strip_prefix(&document)
            .expect("Markdown belongs to the paper"),
    )?;
    let mut artifacts = Vec::new();
    let public_artifacts = layout::extraction_dir(root, &parsed);
    let public_artifacts = public_artifacts
        .strip_prefix(&document)
        .expect("artifacts belong to the paper");
    let directory = output.join(EXTRACTION_ARTIFACTS);
    if directory.is_dir() {
        for entry in WalkDir::new(&directory).sort_by_file_name() {
            let entry = entry.map_err(AppError::internal)?;
            if !entry.file_type().is_dir()
                && entry.file_name().to_string_lossy() != EXTRACTION_METADATA
            {
                let relative = entry
                    .path()
                    .strip_prefix(&directory)
                    .expect("walked staged artifact");
                let (path, sha256, size) =
                    artifact(entry.path(), &public_artifacts.join(relative))?;
                artifacts.push(ExtractionOutcomeSucceededArtifactsItem { path, sha256, size });
            }
        }
    }
    Ok(ExtractionOutcome::Succeeded {
        key: nonempty(key.to_string()),
        plugin_id: plugin.id.clone(),
        source_kind: plugin.source_kind,
        authoritative: plugin.authoritative,
        markdown: ExtractionOutcomeSucceededMarkdown { path, sha256, size },
        artifacts,
    })
}

async fn run(
    state: &Shared,
    plugin: &ExtractionManifestPluginsItem,
    indexed: &IndexedItem,
) -> AppResult<ExtractionOutcome> {
    let key = indexed.stored.key.to_string();
    let staging = tempfile::Builder::new()
        .prefix(".extracting-")
        .tempdir_in(&state.config.root)?;
    let output = staging.path().join("output");
    std::fs::create_dir(&output)?;
    let arguments = arguments(plugin, &indexed.path, &output);
    let (program, rest) = arguments
        .split_first()
        .expect("the manifest schema requires a command");
    let child = state
        .store
        .python()
        .command(program)
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::internal(format!("plugin {} did not start: {error}", *plugin.id))
        })?;
    let seconds = state.config.app.plugins.extraction_timeout_seconds;
    let limit = Duration::from_secs(seconds.get());
    let group = child.id();
    let Some(finished) = within(group, limit, child.wait_with_output()).await? else {
        return Ok(ExtractionOutcome::TimedOut {
            key: nonempty(key),
            plugin_id: plugin.id.clone(),
            seconds,
        });
    };
    let finished = finished?;
    if !finished.status.success() {
        return Ok(ExtractionOutcome::Failed {
            key: nonempty(key),
            plugin_id: plugin.id.clone(),
            exit_code: exit_code(finished.status),
            stderr: String::from_utf8_lossy(&finished.stderr).into_owned(),
        });
    }
    let with_artifacts = produced(&plugin.id, &output)?;
    if !plugin.authoritative {
        return Err(broken(format!(
            "plugin {} is not marked authoritative",
            *plugin.id
        )));
    }
    let artifacts = output.join(EXTRACTION_ARTIFACTS);
    if matches!(plugin.source_kind, ExtractionSourceKind::ArxivLatex) {
        for name in ["source.eprint", "source.tex"] {
            let path = artifacts.join(name);
            if !path.is_file() || std::fs::metadata(&path)?.len() == 0 {
                return Err(broken(format!(
                    "plugin {} did not produce required source artifact {name}",
                    *plugin.id
                )));
            }
        }
    }
    if !with_artifacts {
        std::fs::create_dir(&artifacts)?;
    }
    std::fs::write(
        artifacts.join(EXTRACTION_METADATA),
        serde_json::json!({
            "sourceKind": plugin.source_kind,
            "authoritative": plugin.authoritative,
        })
        .to_string(),
    )?;
    let outcome = staged_result(&output, &key, plugin)?;
    state
        .store
        .place_extraction(
            &key,
            &indexed.stored.provenance,
            output.join(EXTRACTION_MARKDOWN),
            Some(artifacts),
        )
        .await?;
    state.stored();
    Ok(outcome)
}

/// Runs the manifest's plugin PLUGIN_ID on the stored item KEY.
async fn extract_with(state: &Shared, key: &str, plugin_id: &str) -> AppResult<ExtractionOutcome> {
    let indexed = state.require(key).await?;
    let manifest = manifest(state).await?;
    let Some(plugin) = manifest
        .plugins
        .iter()
        .find(|plugin| *plugin.id == plugin_id)
    else {
        return Err(AppError::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownPlugin,
            format!("no extraction plugin has id {plugin_id}"),
        ));
    };
    let violations = violations(plugin, &indexed);
    if !violations.is_empty() {
        return Ok(ExtractionOutcome::Rejected {
            key: indexed.stored.key.clone(),
            plugin_id: plugin.id.clone(),
            violations,
        });
    }
    run(state, plugin, &indexed).await
}

/// Runs the plugins of `plugins.send_extraction_chain` on KEY in order, up to the first that
/// extracts it; answers each run's outcome.
pub async fn extract_by_chain(state: &Shared, key: &str) -> AppResult<Vec<ExtractionOutcome>> {
    let mut outcomes = Vec::new();
    for plugin_id in &state.config.app.plugins.send_extraction_chain {
        let outcome = extract_with(state, key, plugin_id).await?;
        let extracted = matches!(outcome, ExtractionOutcome::Succeeded { .. });
        outcomes.push(outcome);
        if extracted {
            break;
        }
    }
    Ok(outcomes)
}

async fn extract(
    State(state): State<Shared>,
    UrlPath((key, plugin_id)): UrlPath<(String, String)>,
) -> AppResult<(StatusCode, Json<ExtractionOutcome>)> {
    let outcome = extract_with(&state, &key, &plugin_id).await?;
    // A plugin that exits non-zero is a failed upstream, one past its time limit a timed-out
    // upstream; a PDF outside its limits is unprocessable.
    let status = match outcome {
        ExtractionOutcome::Succeeded { .. } => StatusCode::OK,
        ExtractionOutcome::Failed { .. } => StatusCode::BAD_GATEWAY,
        ExtractionOutcome::Rejected { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        ExtractionOutcome::TimedOut { .. } => StatusCode::GATEWAY_TIMEOUT,
    };
    Ok((status, Json(outcome)))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/plugins/extractions", get(plugins))
        .route("/api/items/{key}/extractions/{plugin_id}", post(extract))
}
