//! First-page thumbnails: rendered by the store (MuPDF) into the cache directory, one PNG per
//! item and width, drawn again whenever the PDF is newer than its PNG (a reader save, a rebuild).
//! A PNG is named after the SHA-256 of its key, so every name fits NAME_MAX whatever the key.
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;

use crate::config::THUMBNAIL_WIDTHS;
use crate::error::{AppError, AppResult};
use crate::sources::sha256;
use crate::state::Shared;
use crate::store::write_file;

async fn thumbnail(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<impl IntoResponse> {
    let width: u32 = query
        .get("width")
        .ok_or_else(|| AppError::invalid("width is required"))?
        .parse()
        .map_err(|error| AppError::invalid(format!("width is not a whole number: {error}")))?;
    if !THUMBNAIL_WIDTHS.contains(&width) {
        return Err(AppError::invalid(format!(
            "width lies outside {}..={}",
            THUMBNAIL_WIDTHS.start(),
            THUMBNAIL_WIDTHS.end()
        )));
    }
    let pdf = state
        .store
        .pdf_path(&key)
        .ok_or_else(|| AppError::unknown_item(&key))?;
    let png = state
        .config
        .cache_dir
        .join("thumbnails")
        .join(format!("{}-{width}.png", sha256(key.as_bytes())));
    let stale = match tokio::fs::metadata(&png).await {
        Ok(drawn) => drawn.modified()? < tokio::fs::metadata(&pdf).await?.modified()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    if stale {
        let _slot = state
            .renders
            .acquire()
            .await
            .expect("the semaphore stays open");
        let drawn = state.store.thumbnail(&key, width).await?;
        write_file(png.clone(), drawn).await?;
    }
    Ok((
        [(header::CONTENT_TYPE, "image/png")],
        tokio::fs::read(&png).await?,
    ))
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/items/{key}/thumbnail", get(thumbnail))
}
