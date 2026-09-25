//! Reading sessions, kept in one JSON document under the bucket root beside the filing: a report
//! replaces the stored session with its id, with the item as it stands now. Like the filing
//! document, writes are serialized and land by rename.
use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::config::MIN_PAGE_SECONDS;
use crate::contract::{
    ReadingSession, ReadingSessionItem, ReadingSessionPagesItem, ReadingSessionReport, Sessions,
};
use crate::error::{AppError, AppResult};
use crate::organization::write_json;
use crate::state::{parse_body, Shared};

pub struct SessionStore {
    path: PathBuf,
    writes: Mutex<()>,
}

fn empty() -> Sessions {
    Sessions {
        version: 1.try_into().expect("1 is the sessions document's version"),
        sessions: Vec::new(),
    }
}

impl SessionStore {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("reading-sessions.json"),
            writes: Mutex::new(()),
        }
    }

    pub async fn read(&self) -> AppResult<Sessions> {
        if !tokio::fs::try_exists(&self.path).await? {
            return Ok(empty());
        }
        let text = tokio::fs::read_to_string(&self.path).await?;
        serde_json::from_str(&text).map_err(|error| {
            AppError::internal(format!("{} fails its schema: {error}", self.path.display()))
        })
    }

    pub async fn upsert(&self, session: ReadingSession) -> AppResult<()> {
        let _serialized = self.writes.lock().await;
        let mut current = self.read().await?;
        current.sessions.retain(|stored| stored.id != session.id);
        current.sessions.push(session);
        write_json(&self.path, &current).await
    }
}

#[derive(Serialize)]
struct Recorded {
    id: uuid::Uuid,
}

async fn list(State(state): State<Shared>) -> AppResult<Json<Vec<ReadingSession>>> {
    Ok(Json(state.sessions.read().await?.sessions))
}

async fn report(State(state): State<Shared>, body: Bytes) -> AppResult<Json<Recorded>> {
    let report: ReadingSessionReport = parse_body(&body)?;
    if report.pages.is_empty() {
        return Err(AppError::invalid("the session reports no page"));
    }
    if report
        .pages
        .iter()
        .any(|page| page.seconds < MIN_PAGE_SECONDS)
    {
        return Err(AppError::invalid(format!(
            "a page counts after {MIN_PAGE_SECONDS} seconds"
        )));
    }
    let indexed = state.require(&report.key).await?;
    let stored = indexed.stored;
    let session = ReadingSession {
        id: report.id,
        key: report.key,
        opened_at: report.opened_at,
        last_seen_at: report.last_seen_at,
        pages: report
            .pages
            .into_iter()
            .map(|page| ReadingSessionPagesItem {
                page: page.page,
                seconds: page.seconds,
            })
            .collect(),
        item: ReadingSessionItem {
            title: stored.title.text,
            authors: stored.authors,
            year: stored.year,
            abstract_: stored.abstract_,
            source_url: stored.provenance.source_url,
        },
    };
    state.sessions.upsert(session).await?;
    Ok(Json(Recorded { id: report.id }))
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/reading-sessions", get(list).post(report))
}
