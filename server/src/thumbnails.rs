//! First-page thumbnails: rendered by the store (MuPDF) into the cache directory, one PNG per
//! item and width, drawn again whenever the PDF is newer than its PNG (a reader save, a rebuild).
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use percent_encoding::utf8_percent_encode;

use crate::config::{THUMBNAIL_WIDTHS, URI_COMPONENT};
use crate::error::{AppError, AppResult};
use crate::state::Shared;

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
    let directory = state.config.cache_dir.join("thumbnails");
    tokio::fs::create_dir_all(&directory).await?;
    let png = directory.join(format!(
        "{}-{width}.png",
        utf8_percent_encode(&key, URI_COMPONENT)
    ));
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
        let args = [
            "thumbnail".to_string(),
            "--".to_string(),
            state.config.root.to_string_lossy().into_owned(),
            key,
            png.to_string_lossy().into_owned(),
            width.to_string(),
        ];
        state.store.run(&args, None).await?;
    }
    Ok((
        [(header::CONTENT_TYPE, "image/png")],
        tokio::fs::read(&png).await?,
    ))
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/items/{key}/thumbnail", get(thumbnail))
}
