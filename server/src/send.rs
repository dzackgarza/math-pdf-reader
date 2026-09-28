//! The send action: the Zotero local write API makes or finds the Zotero item for the item's PDF
//! URL, then the send sets its URL and access date,
//! attach the stored PDF (the bucket's copy, with its annotations) and the extraction Markdown,
//! add each of the item's notes as a Zotero child note, and record the Zotero key in the filing
//! document after each step. Once every step is done the item leaves the bucket, since Zotero
//! holds it now, unless a collection holding it (or holding a collection that holds it) keeps
//! its items offline. Deleting an item moves its PDF to the desktop trash and drops its filing.
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};

use crate::app::origin;
use crate::contract::{
    ApiErrorErrorKind, Extraction, ItemNote, LibraryPayload, Organization, Provenance,
    SendResponse, SendResponsePerformedItem, SendStep, Timestamp, ZoteroRecord, ZoteroStatus,
    ZoteroStatusSentPendingItem,
};
use crate::error::{AppError, AppResult};
use crate::index::IndexedItem;
use crate::organization::{filing_of, kept_offline, non_empty, set_zotero_record};
use crate::reader::pdf_url_path;
use crate::state::Shared;
use crate::zotero::note_html;

/// A step of a send once the Zotero item exists.
#[derive(Clone, Copy)]
enum Step<'a> {
    Fields,
    Pdf,
    Markdown,
    Note(&'a ItemNote),
}

/// The steps as the contract lists them: one `notes` for all of an item's notes.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Fields,
    Pdf,
    Markdown,
    Notes,
}

impl Step<'_> {
    fn kind(self) -> Kind {
        match self {
            Step::Fields => Kind::Fields,
            Step::Pdf => Kind::Pdf,
            Step::Markdown => Kind::Markdown,
            Step::Note(_) => Kind::Notes,
        }
    }

    fn done_by(self, done: &SendStep) -> bool {
        match (self, done) {
            (Step::Fields, SendStep::Fields)
            | (Step::Pdf, SendStep::Pdf { .. })
            | (Step::Markdown, SendStep::Markdown { .. }) => true,
            (Step::Note(note), SendStep::Note { note_id, .. }) => note.id == *note_id,
            _ => false,
        }
    }
}

fn steps_owed<'a>(extraction: &Extraction, notes: &'a [ItemNote]) -> Vec<Step<'a>> {
    let mut steps = vec![Step::Fields, Step::Pdf];
    if let Extraction::Extracted { .. } = extraction {
        steps.push(Step::Markdown);
    }
    steps.extend(notes.iter().map(Step::Note));
    steps
}

fn pending_steps<'a>(
    record: &ZoteroRecord,
    extraction: &Extraction,
    notes: &'a [ItemNote],
) -> Vec<Step<'a>> {
    steps_owed(extraction, notes)
        .into_iter()
        .filter(|step| !record.steps.iter().any(|done| step.done_by(done)))
        .collect()
}

fn kinds(steps: &[Step]) -> Vec<Kind> {
    let mut kinds: Vec<Kind> = Vec::new();
    for kind in steps.iter().map(|step| step.kind()) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

pub fn zotero_status(
    record: Option<&ZoteroRecord>,
    extraction: &Extraction,
    notes: &[ItemNote],
) -> ZoteroStatus {
    match record {
        None => ZoteroStatus::Unsent,
        Some(record) => ZoteroStatus::Sent {
            pending: kinds(&pending_steps(record, extraction, notes))
                .into_iter()
                .map(|kind| match kind {
                    Kind::Fields => ZoteroStatusSentPendingItem::Fields,
                    Kind::Pdf => ZoteroStatusSentPendingItem::Pdf,
                    Kind::Markdown => ZoteroStatusSentPendingItem::Markdown,
                    Kind::Notes => ZoteroStatusSentPendingItem::Notes,
                })
                .collect(),
            record: record.clone(),
        },
    }
}

/// The page the item was captured from, which the Zotero item's URL field names: the linking
/// page, or the PDF itself for a capture with no linking page.
fn page_url(provenance: &Provenance) -> &str {
    provenance
        .source_url
        .as_deref()
        .unwrap_or(&provenance.pdf_url)
}

/// The URL the write API identifies the item by: its PDF URL, which names this one paper where
/// the page it was captured from may list many. A PDF with no web URL (a folder import's
/// `file:` URL) goes by the bucket's own URL for its stored copy.
pub fn import_url(origin: &str, provenance: &Provenance, key: &str) -> String {
    if provenance.pdf_url.starts_with("http://") || provenance.pdf_url.starts_with("https://") {
        return provenance.pdf_url.clone();
    }
    format!("{origin}{}", pdf_url_path(key))
}

async fn find_or_create(
    state: &Shared,
    origin: &str,
    indexed: &IndexedItem,
) -> AppResult<(ZoteroRecord, bool)> {
    let stored = &indexed.stored;
    let imported = state
        .zotero
        .import_from_url(&import_url(origin, &stored.provenance, &stored.key))
        .await?;
    let record = ZoteroRecord {
        item_key: non_empty(&imported.item_key),
        sent_at: Timestamp::now(),
        method: imported.method,
        steps: Vec::new(),
    };
    Ok((record, !imported.existing))
}

async fn perform(
    state: &Shared,
    step: Step<'_>,
    item_key: &str,
    indexed: &IndexedItem,
) -> AppResult<SendStep> {
    let key = indexed.stored.key.as_str();
    let provenance = &indexed.stored.provenance;
    let attached = |attachment: String| non_empty(&attachment);
    Ok(match step {
        Step::Fields => {
            state
                .zotero
                .set_url_and_access_date(item_key, page_url(provenance), &provenance.captured_at)
                .await?;
            SendStep::Fields
        }
        // The bucket's stored PDF, which carries the reader's annotations and the provenance.
        Step::Pdf => {
            let bytes = tokio::fs::read(&indexed.path).await?;
            let attachment = state
                .zotero
                .attach_bytes(item_key, &format!("{key}.pdf"), "Full Text PDF", &bytes)
                .await?;
            SendStep::Pdf {
                attachment_key: attached(attachment),
            }
        }
        // Named as the extraction loop names a Markdown child, which marks an item extracted.
        Step::Markdown => {
            let name = format!("{item_key}_extracted.md");
            let bytes = tokio::fs::read(state.config.root.join(format!("{key}.md"))).await?;
            let attachment = state
                .zotero
                .attach_bytes(item_key, &name, &name, &bytes)
                .await?;
            SendStep::Markdown {
                attachment_key: attached(attachment),
            }
        }
        Step::Note(note) => {
            let note_key = state
                .zotero
                .attach_note(item_key, &note_html(&note.note))
                .await?;
            SendStep::Note {
                note_id: note.id.clone(),
                note_key: non_empty(&note_key),
            }
        }
    })
}

async fn remove(state: &Shared, key: &str) -> AppResult<Organization> {
    state.remove(key).await
}

async fn save(state: &Shared, key: &str, record: &ZoteroRecord) -> AppResult<Organization> {
    let record = record.clone();
    state
        .organizations
        .update(|org| set_zotero_record(org, key, record, &Timestamp::now()))
        .await
}

async fn send_item(state: Shared, origin: String, key: String) -> AppResult<SendResponse> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    let indexed = state.require(&key).await?;
    let filed = filing_of(
        &state.organizations.read().await?,
        &key,
        &indexed.stored.provenance.captured_at,
    );
    let notes = filed.notes;
    let existing = filed.zotero;
    if let Some(record) = &existing {
        if pending_steps(record, &indexed.extraction, &notes).is_empty() {
            return Err(AppError::api(
                StatusCode::CONFLICT,
                ApiErrorErrorKind::AlreadySent,
                format!("{key} is already in Zotero as {}", *record.item_key),
            ));
        }
    }

    let (mut record, created) = match existing {
        Some(record) => (record, false),
        None => find_or_create(&state, &origin, &indexed).await?,
    };
    save(&state, &key, &record).await?;

    let mut performed = Vec::new();
    for step in pending_steps(&record, &indexed.extraction, &notes) {
        let done = perform(&state, step, &record.item_key, &indexed).await?;
        record.steps.push(done);
        save(&state, &key, &record).await?;
        performed.push(step);
    }
    let kept = kept_offline(&state.organizations.read().await?, &key);
    if !kept {
        remove(&state, &key).await?;
    }
    Ok(SendResponse {
        item_key: record.item_key,
        created,
        performed: kinds(&performed)
            .into_iter()
            .map(|kind| match kind {
                Kind::Fields => SendResponsePerformedItem::Fields,
                Kind::Pdf => SendResponsePerformedItem::Pdf,
                Kind::Markdown => SendResponsePerformedItem::Markdown,
                Kind::Notes => SendResponsePerformedItem::Notes,
            })
            .collect(),
        kept,
    })
}

/// The send runs as its own task: a client that disconnects mid-send drops only its wait for
/// the answer, and the send still records each step Zotero has done.
async fn send(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<SendResponse>> {
    let origin = origin(&headers)?;
    tokio::spawn(send_item(state, origin, key))
        .await
        .map_err(AppError::internal)?
        .map(Json)
}

async fn delete(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<LibraryPayload>> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    state.require(&key).await?;
    let organization = remove(&state, &key).await?;
    Ok(Json(state.payload_of(organization).await?))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/items/{key}/zotero", post(send))
        .route("/api/items/{key}", axum::routing::delete(delete))
}
