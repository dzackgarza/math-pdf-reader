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

use crate::config::{EXTRACTION_ARTIFACTS, EXTRACTION_MARKDOWN};
use crate::contract::{
    ApiErrorErrorKind, ExtractionManifest, ExtractionManifestPluginsItem, ExtractionOutcome,
    ExtractionOutcomeRejectedViolationsItem, ExtractionOutcomeSucceededArtifactsItem,
    ExtractionOutcomeSucceededMarkdown, ExtractionPluginsResponse,
    ExtractionPluginsResponsePluginsItem, NonEmpty, PdfLimit,
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
    serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!("{} fails its schema: {error}", path.display()))
    })
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
                accepted_inputs: plugin.accepted_inputs,
            })
            .collect(),
    }))
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("the text is never empty")
}

/// Every limit of the plugin's accepted inputs the stored PDF exceeds.
fn violations(
    plugin: &ExtractionManifestPluginsItem,
    indexed: &IndexedItem,
) -> Vec<ExtractionOutcomeRejectedViolationsItem> {
    plugin
        .accepted_inputs
        .iter()
        .flat_map(|input| &input.limits)
        .filter_map(|limit| {
            let (bound, observed) = match limit {
                PdfLimit::MaxPages(pages) => (pages.get(), indexed.pages),
                PdfLimit::MaxBytes(bytes) => (bytes.get(), indexed.size_bytes),
            };
            (observed > bound).then(|| ExtractionOutcomeRejectedViolationsItem {
                limit: limit.clone(),
                observed: i64::try_from(observed).expect("a page or byte count fits i64"),
            })
        })
        .collect()
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

fn artifact(root: &Path, path: &Path) -> AppResult<(NonEmpty, crate::contract::Sha256, i64)> {
    let bytes = std::fs::read(path)?;
    let relative = path
        .strip_prefix(root)
        .expect("an artifact lies in the root")
        .to_string_lossy()
        .into_owned();
    Ok((
        nonempty(relative),
        sha256(&bytes)
            .try_into()
            .expect("a SHA-256 digest is 64 hex digits"),
        i64::try_from(bytes.len()).map_err(AppError::internal)?,
    ))
}

// The placed Markdown and artifacts, with their hashes.
fn placed(state: &Shared, key: &str, plugin_id: NonEmpty) -> AppResult<ExtractionOutcome> {
    let root = &state.config.root;
    let parsed = Key::parse(key).expect("an indexed key is a key");
    let (path, sha256, size) = artifact(root, &layout::markdown_path(root, &parsed))?;
    let mut artifacts = Vec::new();
    let directory = layout::extraction_dir(root, &parsed);
    if directory.is_dir() {
        for entry in WalkDir::new(&directory).sort_by_file_name() {
            let entry = entry.map_err(AppError::internal)?;
            if entry.file_type().is_file() {
                let (path, sha256, size) = artifact(root, entry.path())?;
                artifacts.push(ExtractionOutcomeSucceededArtifactsItem { path, sha256, size });
            }
        }
    }
    Ok(ExtractionOutcome::Succeeded {
        key: nonempty(key.to_string()),
        plugin_id,
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
    state
        .store
        .place_extraction(
            &key,
            output.join(EXTRACTION_MARKDOWN),
            with_artifacts.then(|| output.join(EXTRACTION_ARTIFACTS)),
        )
        .await?;
    placed(state, &key, plugin.id.clone())
}

async fn extract(
    State(state): State<Shared>,
    UrlPath((key, plugin_id)): UrlPath<(String, String)>,
) -> AppResult<(StatusCode, Json<ExtractionOutcome>)> {
    let indexed = state.require(&key).await?;
    let manifest = manifest(&state).await?;
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
    let outcome = if violations.is_empty() {
        run(&state, plugin, &indexed).await?
    } else {
        ExtractionOutcome::Rejected {
            key: indexed.stored.key.clone(),
            plugin_id: plugin.id.clone(),
            violations,
        }
    };
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
