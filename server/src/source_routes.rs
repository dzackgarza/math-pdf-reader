//! Routes for an item's sources: its mirrors, checking its PDF URL and mirrors, and rebuilding a
//! PDF the store has lost.
use std::collections::{BTreeMap, HashMap};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use futures::future::{join_all, try_join_all};
use url::Url;

use crate::contract::{
    ApiErrorErrorKind, ExportedItem, LibraryPayload, MirrorRequest, RebuildOutcome, Timestamp,
};
use crate::error::{AppError, AppResult};
use crate::export::recoverable;
use crate::index::IndexedItem;
use crate::organization::{add_mirror, filing, record_source_checks, remove_mirror};
use crate::sources::{check_source, rebuild_item};
use crate::state::{parse_body, Shared};

type Payload = AppResult<Json<LibraryPayload>>;

async fn checked(state: &Shared, url: &str, original_sha256: &str) -> crate::contract::SourceCheck {
    let _slot = state
        .downloads
        .acquire()
        .await
        .expect("the semaphore stays open");
    check_source(url, original_sha256, &state.config.app.rebuild).await
}

// Checks the PDF URL and every mirror, each download taking a slot of the shared limit.
async fn verify_item(state: &Shared, indexed: &IndexedItem) -> AppResult<()> {
    let key = indexed.stored.key.to_string();
    let provenance = &indexed.stored.provenance;
    let mirrors: Vec<String> = match filing(&state.organizations.read().await?, &key) {
        Some(filed) => filed
            .mirrors
            .iter()
            .map(|mirror| mirror.url.clone())
            .collect(),
        None => Vec::new(),
    };
    let (source_check, mirror_checks) = futures::join!(
        checked(state, &provenance.pdf_url, &provenance.original_sha256),
        join_all(mirrors.iter().map(|url| async {
            (
                url.clone(),
                checked(state, url, &provenance.original_sha256).await,
            )
        })),
    );
    let by_url: BTreeMap<String, _> = mirror_checks.into_iter().collect();
    let captured_at = provenance.captured_at.clone();
    state
        .organizations
        .update(|org| record_source_checks(org, &key, &captured_at, source_check, &by_url))
        .await?;
    Ok(())
}

async fn verify(State(state): State<Shared>, Path(key): Path<String>) -> Payload {
    let indexed = state.require(&key).await?;
    verify_item(&state, &indexed).await?;
    Ok(Json(state.payload().await?))
}

async fn verify_all(State(state): State<Shared>) -> Payload {
    let indexed = state.store.items().await?;
    try_join_all(indexed.iter().map(|item| verify_item(&state, item))).await?;
    Ok(Json(state.payload().await?))
}

async fn add(State(state): State<Shared>, Path(key): Path<String>, body: Bytes) -> Payload {
    let request: MirrorRequest = parse_body(&body)?;
    match Url::parse(&request.url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {}
        Ok(_) => {
            return Err(AppError::invalid(format!(
                "{} is not an http or https URL",
                request.url
            )));
        }
        Err(error) => return Err(AppError::invalid(format!("{}: {error}", request.url))),
    }
    state.require(&key).await?;
    state
        .change(|org| add_mirror(org, &key, &request.url, &Timestamp::now()))
        .await
}

fn unknown_mirror(key: &str, url: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownMirror,
        format!("item {key} has no mirror {url}"),
    )
}

async fn remove(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Payload {
    let org = state.organizations.read().await?;
    let mirrored = |url: &String| {
        filing(&org, &key)
            .is_some_and(|filed| filed.mirrors.iter().any(|mirror| &mirror.url == url))
    };
    let url = match query.get("url") {
        Some(url) if mirrored(url) => url.clone(),
        Some(url) => return Err(unknown_mirror(&key, url)),
        None => return Err(unknown_mirror(&key, "(none named)")),
    };
    state
        .change(|org| remove_mirror(org, &key, &url, &Timestamp::now()))
        .await
}

/// The items the index export holds whose PDF the store has lost, read once.
async fn lost(state: &Shared) -> AppResult<Vec<ExportedItem>> {
    let indexed = state.store.items().await?;
    Ok(state
        .missing(&indexed)
        .await?
        .into_iter()
        .map(|(item, _)| item)
        .collect())
}

// Rebuilds one lost item; a restored PDF rewrites the index export.
async fn rebuild_lost(state: &Shared, item: &ExportedItem) -> RebuildOutcome {
    let outcome = rebuild_item(&state.store, &recoverable(item), &state.config.app.rebuild).await;
    if let RebuildOutcome::Restored { .. } = outcome {
        state.stored();
    }
    outcome
}

async fn rebuild(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<RebuildOutcome>> {
    let lost = lost(&state).await?;
    let Some(item) = lost.iter().find(|item| *item.key == key) else {
        return Err(AppError::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownItem,
            format!("the index export lists no lost PDF with key {key}"),
        ));
    };
    Ok(Json(rebuild_lost(&state, item).await))
}

/// Every lost item's outcome, each download taking a slot of the shared limit; one item's
/// failure is that item's outcome and leaves the others'.
async fn rebuild_all(State(state): State<Shared>) -> AppResult<Json<Vec<RebuildOutcome>>> {
    let lost = lost(&state).await?;
    let outcomes = join_all(lost.iter().map(|item| async {
        let _slot = state
            .downloads
            .acquire()
            .await
            .expect("the semaphore stays open");
        rebuild_lost(&state, item).await
    }))
    .await;
    Ok(Json(outcomes))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/items/{key}/verify", post(verify))
        .route("/api/verify", post(verify_all))
        .route("/api/items/{key}/mirrors", post(add).delete(remove))
        .route("/api/items/{key}/rebuild", post(rebuild))
        .route("/api/rebuild", post(rebuild_all))
}
