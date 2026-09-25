//! Reading sessions, kept in one JSON document under the bucket root beside the filing: a report
//! replaces the stored session with its id, with the item as it stands now. Like the filing
//! document, writes are serialized and land by rename, and each one wakes the index export,
//! which carries the sessions.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::{Mutex, Notify};

use crate::contract::{
    ReadingSession, ReadingSessionItem, ReadingSessionPagesItem, ReadingSessionReport, Sessions,
};
use crate::error::AppResult;
use crate::organization::{read_document, write_json};
use crate::state::{parse_body, Shared};

pub struct SessionStore {
    path: PathBuf,
    writes: Mutex<()>,
    changed: Arc<Notify>,
}

pub fn empty_sessions() -> Sessions {
    Sessions {
        version: 1.try_into().expect("1 is the sessions document's version"),
        sessions: Vec::new(),
    }
}

pub fn sessions_file(root: &Path) -> PathBuf {
    root.join("reading-sessions.json")
}

impl SessionStore {
    /// CHANGED is notified after every write that landed.
    pub fn new(root: &Path, changed: Arc<Notify>) -> Self {
        Self {
            path: sessions_file(root),
            writes: Mutex::new(()),
            changed,
        }
    }

    pub async fn read(&self) -> AppResult<Sessions> {
        Ok(read_document(&self.path)
            .await?
            .unwrap_or_else(empty_sessions))
    }

    pub async fn upsert(&self, session: ReadingSession) -> AppResult<()> {
        let _serialized = self.writes.lock().await;
        let mut current = self.read().await?;
        current.sessions.retain(|stored| stored.id != session.id);
        current.sessions.push(session);
        write_json(&self.path, &current).await?;
        self.changed.notify_one();
        Ok(())
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
