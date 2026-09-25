//! Extraction plugins: the manifest listing, and runs on stored items through the Python runner
//! (`pdfbucket extract`), which places `<key>.md` and `<key>.extraction/` beside the PDF.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::contract::{
    ApiErrorErrorKind, ExtractionOutcome, ExtractionPluginsResponse,
    ExtractionPluginsResponsePluginsItem, PluginManifest,
};
use crate::error::{AppError, AppResult};
use crate::state::Shared;

async fn manifest(state: &Shared) -> AppResult<PluginManifest> {
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

async fn extract(
    State(state): State<Shared>,
    Path((key, plugin_id)): Path<(String, String)>,
) -> AppResult<(StatusCode, Json<ExtractionOutcome>)> {
    if state.store.pdf_path(&key).is_none() {
        return Err(AppError::unknown_item(&key));
    }
    if !manifest(&state)
        .await?
        .plugins
        .iter()
        .any(|plugin| *plugin.id == plugin_id)
    {
        return Err(AppError::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownPlugin,
            format!("no extraction plugin has id {plugin_id}"),
        ));
    }
    let args = [
        "extract".to_string(),
        state.config.root.to_string_lossy().into_owned(),
        key,
        state
            .config
            .extractions_manifest
            .to_string_lossy()
            .into_owned(),
        plugin_id,
    ];
    let stdout = state.store.run(&args, None).await?;
    let outcome: ExtractionOutcome = serde_json::from_str(&stdout)?;
    // A plugin that exits non-zero is a failed upstream; a PDF outside its limits is
    // unprocessable.
    let status = match outcome {
        ExtractionOutcome::Succeeded { .. } => StatusCode::OK,
        ExtractionOutcome::Failed { .. } => StatusCode::BAD_GATEWAY,
        ExtractionOutcome::Rejected { .. } => StatusCode::UNPROCESSABLE_ENTITY,
    };
    Ok((status, Json(outcome)))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/plugins/extractions", get(plugins))
        .route("/api/items/{key}/extractions/{plugin_id}", post(extract))
}
