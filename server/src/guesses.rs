//! Metadata inference: one structured model command reads a stored PDF and its provenance, then
//! the store records its required title, authors, and year inside the PDF.
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};

use crate::contract::{
    from_json, ApiErrorErrorKind, GuessMetadataResponse, GuessMetadataResult, TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::state::{bucket_item, Shared};
use crate::store::ResolvedMetadata;

const INFERENCE_TIMEOUT: Duration = Duration::from_secs(600);

async fn guess(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<GuessMetadataResponse>> {
    let indexed = state.require(&key).await?;
    let provenance = &indexed.stored.provenance;
    let mut args = vec![
        "guess-metadata".to_string(),
        format!("--pdf-url={}", provenance.pdf_url),
        format!("--title-hint={}", *provenance.title_hint),
    ];
    if let Some(source_url) = &provenance.source_url {
        args.push(format!("--source-url={source_url}"));
    }
    args.extend([
        "--".to_string(),
        indexed.path.to_string_lossy().into_owned(),
    ]);

    let output = state
        .store
        .python()
        .run_with_timeout(&args, None, INFERENCE_TIMEOUT)
        .await
        .map_err(|error| {
            AppError::api(
                StatusCode::BAD_GATEWAY,
                ApiErrorErrorKind::MetadataGuessFailed,
                error.to_string(),
            )
        })?;
    let result: GuessMetadataResult = from_json(&output).map_err(|error| {
        AppError::api(
            StatusCode::BAD_GATEWAY,
            ApiErrorErrorKind::MetadataGuessFailed,
            format!("the metadata command returned an invalid structured response: {error}"),
        )
    })?;
    let recorded = ResolvedMetadata {
        title: String::from(result.metadata.title.clone()),
        authors: result
            .metadata
            .authors
            .iter()
            .map(|author| String::from(author.clone()))
            .collect(),
        year: Some(result.metadata.year),
        abstract_: indexed
            .stored
            .abstract_
            .as_ref()
            .map(|abstract_| String::from(abstract_.clone())),
    };
    state
        .store
        .record_metadata(&key, TitleSource::Guess, &recorded)
        .await?;
    state.stored();
    let refreshed = state.indexed(&key).await?.ok_or_else(|| {
        AppError::internal(format!(
            "{key} left the store while its metadata was guessed"
        ))
    })?;
    let item = bucket_item(&refreshed, &state.organizations.read().await?)?;
    Ok(Json(GuessMetadataResponse {
        provider: result.provider,
        model: result.model,
        metadata: result.metadata,
        item,
    }))
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/items/{key}/guess-metadata", post(guess))
}
