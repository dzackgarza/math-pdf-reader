//! The send action: the Zotero local write API makes or finds the Zotero item for the item's PDF
//! URL, then the send sets its URL and access date,
//! leaves the item one PDF (the bucket's copy, with its annotations, or the item's own PDF when that
//! has as many annotations), attaches the extraction Markdown,
//! adds each of the item's notes as a Zotero child note, and records the Zotero key in the filing
//! document after each step. Once every step is done the item leaves the bucket, since Zotero
//! holds it now, unless a collection holding it (or holding a collection that holds it) keeps
//! its items offline. "Send to Zotero and Extract" sends, then runs the configured chain of
//! extraction plugins and attaches the Markdown the first success places. "Send PDF Only" puts
//! the stored PDF in Zotero as a standalone attachment, for a PDF Zotero cannot identify by its
//! URL. Deleting an item moves its PDF to the desktop trash and drops its filing.
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};

use crate::app::origin;
use crate::contract::{
    ApiErrorErrorKind, Extraction, ExtractionOutcome, ImportMethod, ItemNote, LibraryPayload,
    Organization, Provenance, SendAndExtractResponse, SendMethod, SendResponse,
    SendResponsePerformedItem, SendStep, Timestamp, ZoteroRecord, ZoteroStatus,
    ZoteroStatusSentPendingItem,
};
use crate::error::{AppError, AppResult};
use crate::extractions::extract_by_chain;
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

/// A standalone PDF in Zotero owes only its PDF; an item under a Zotero item owes its fields, its
/// PDF, its Markdown once extracted, and each of its notes.
fn steps_owed<'a>(
    method: SendMethod,
    extraction: &Extraction,
    notes: &'a [ItemNote],
) -> Vec<Step<'a>> {
    if method == SendMethod::StandaloneAttachment {
        return vec![Step::Pdf];
    }
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
    steps_owed(record.method, extraction, notes)
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
        method: match imported.method {
            ImportMethod::WebTranslator => SendMethod::WebTranslator,
            ImportMethod::PageMetadata => SendMethod::PageMetadata,
            ImportMethod::Identifier => SendMethod::Identifier,
            ImportMethod::PublishedBibtex => SendMethod::PublishedBibtex,
            ImportMethod::ExternalService => SendMethod::ExternalService,
            ImportMethod::PdfRecognition => SendMethod::PdfRecognition,
        },
        steps: Vec::new(),
    };
    Ok((record, !imported.existing))
}

/// Attaches the bucket's stored PDF, which carries the reader's annotations and the provenance,
/// to the item; answers the attachment's key.
async fn attach_copy(state: &Shared, item_key: &str, indexed: &IndexedItem) -> AppResult<String> {
    let bytes = tokio::fs::read(&indexed.path).await?;
    let name = format!("{}.pdf", indexed.stored.key.as_str());
    state
        .zotero
        .attach_bytes(item_key, &name, "Full Text PDF", &bytes)
        .await
}

/// The annotations on a Zotero PDF: the larger of its annotation items and the annotations in
/// its file. Zotero's reader imports a file's annotations as items when it opens the PDF
/// (zotero/zotero, reader.js, `Zotero.PDFWorker.import`), so the items include the file's once
/// the PDF was opened, and the file holds all of them until it is.
async fn zotero_annotations(state: &Shared, attachment_key: &str) -> AppResult<u64> {
    let items = state.zotero.annotation_items(attachment_key).await?;
    let file = state.zotero.attachment_file(attachment_key).await?;
    Ok(items.max(state.store.annotations(&file).await?))
}

/// Leaves the Zotero item one PDF, as a work holds one: the bucket's copy when the item holds
/// none, or when it has more annotations than the item's PDF, which then goes to Zotero's trash;
/// otherwise the item's own PDF. An item with several PDFs is refused. Answers the kept PDF's
/// attachment key.
async fn one_pdf(state: &Shared, item_key: &str, indexed: &IndexedItem) -> AppResult<String> {
    let held = state.zotero.pdfs(item_key).await?;
    let zotero_pdf = match held.as_slice() {
        [] => return attach_copy(state, item_key, indexed).await,
        [one] => one,
        several => {
            return Err(AppError::Zotero(format!(
                "Zotero's item {item_key} holds {} PDFs where a work holds one: keep one, then send again",
                several.len()
            )))
        }
    };
    let ours = state.store.annotations(&indexed.path).await?;
    if ours <= zotero_annotations(state, zotero_pdf).await? {
        return Ok(zotero_pdf.clone());
    }
    let attachment = attach_copy(state, item_key, indexed).await?;
    state.zotero.trash_item(zotero_pdf).await?;
    Ok(attachment)
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
                .set_url_and_access_date(item_key, &provenance.pdf_url, &provenance.captured_at)
                .await?;
            SendStep::Fields
        }
        Step::Pdf => SendStep::Pdf {
            attachment_key: attached(one_pdf(state, item_key, indexed).await?),
        },
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

/// What `send_steps` did: the Zotero record, whether it made the Zotero item, and the steps.
struct Sent {
    record: ZoteroRecord,
    created: bool,
    performed: Vec<Kind>,
}

/// Does the item's pending steps on its Zotero item, finding or making the item first when the
/// item has none, and records each step in the filing document as it is done. The caller holds
/// the item's send lock.
async fn send_steps(state: &Shared, origin: &str, key: &str) -> AppResult<Sent> {
    let indexed = state.require(key).await?;
    let filed = filing_of(
        &state.organizations.read().await?,
        key,
        &indexed.stored.provenance.captured_at,
    );
    let notes = filed.notes;
    state.zotero.require_ready().await?;
    let (mut record, created) = match filed.zotero {
        Some(record) => (record, false),
        None => find_or_create(state, origin, &indexed).await?,
    };
    save(state, key, &record).await?;

    let mut performed = Vec::new();
    for step in pending_steps(&record, &indexed.extraction, &notes) {
        let done = perform(state, step, &record.item_key, &indexed).await?;
        record.steps.push(done);
        save(state, key, &record).await?;
        performed.push(step);
    }
    Ok(Sent {
        record,
        created,
        performed: kinds(&performed),
    })
}

fn performed_steps(kinds: &[Kind]) -> Vec<SendResponsePerformedItem> {
    kinds
        .iter()
        .map(|kind| match kind {
            Kind::Fields => SendResponsePerformedItem::Fields,
            Kind::Pdf => SendResponsePerformedItem::Pdf,
            Kind::Markdown => SendResponsePerformedItem::Markdown,
            Kind::Notes => SendResponsePerformedItem::Notes,
        })
        .collect()
}

/// The item leaves the bucket, since Zotero holds it now, unless a collection keeps it offline;
/// answers whether it stays.
async fn leave(state: &Shared, key: &str) -> AppResult<bool> {
    let kept = kept_offline(&state.organizations.read().await?, key);
    if !kept {
        remove(state, key).await?;
    }
    Ok(kept)
}

async fn send_item(state: Shared, origin: String, key: String) -> AppResult<SendResponse> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    let indexed = state.require(&key).await?;
    let filed = filing_of(
        &state.organizations.read().await?,
        &key,
        &indexed.stored.provenance.captured_at,
    );
    if let Some(record) = &filed.zotero {
        if pending_steps(record, &indexed.extraction, &filed.notes).is_empty() {
            return Err(AppError::api(
                StatusCode::CONFLICT,
                ApiErrorErrorKind::AlreadySent,
                format!("{key} is already in Zotero as {}", *record.item_key),
            ));
        }
    }
    let sent = send_steps(&state, &origin, &key).await?;
    let kept = leave(&state, &key).await?;
    Ok(SendResponse {
        item_key: sent.record.item_key,
        created: sent.created,
        performed: performed_steps(&sent.performed),
        kept,
    })
}

/// "Send to Zotero and Extract": the send first, so the PDF is in Zotero whatever the plugins
/// do; then, unless the item already has Markdown, the configured chain of plugins; then the
/// Markdown the chain placed, if it placed any. The item stays in the bucket until the chain
/// ends. A send standalone attachment holds no Markdown, so it is refused.
async fn send_and_extract_item(
    state: Shared,
    origin: String,
    key: String,
) -> AppResult<SendAndExtractResponse> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    let indexed = state.require(&key).await?;
    let filed = filing_of(
        &state.organizations.read().await?,
        &key,
        &indexed.stored.provenance.captured_at,
    );
    if let Some(record) = &filed.zotero {
        if record.method == SendMethod::StandaloneAttachment {
            return Err(AppError::api(
                StatusCode::CONFLICT,
                ApiErrorErrorKind::AlreadySent,
                format!(
                    "{key} is already in Zotero as the standalone PDF {}",
                    *record.item_key
                ),
            ));
        }
    }
    let mut sent = send_steps(&state, &origin, &key).await?;
    let extractions = match indexed.extraction {
        Extraction::Extracted { .. } => Vec::new(),
        Extraction::None => extract_by_chain(&state, &key).await?,
    };
    if extractions
        .iter()
        .any(|outcome| matches!(outcome, ExtractionOutcome::Succeeded { .. }))
    {
        let markdown = send_steps(&state, &origin, &key).await?;
        sent.record = markdown.record;
        sent.performed.extend(markdown.performed);
    }
    let kept = leave(&state, &key).await?;
    Ok(SendAndExtractResponse {
        send: SendResponse {
            item_key: sent.record.item_key,
            created: sent.created,
            performed: performed_steps(&sent.performed),
            kept,
        },
        extractions,
    })
}

/// "Send PDF Only": the stored PDF as a standalone attachment in Zotero, with no parent item,
/// for a PDF whose URL Zotero cannot identify; the user files it under an item in Zotero. An
/// item with notes or Markdown is refused, since an attachment holds neither.
async fn send_pdf_only_item(state: Shared, key: String) -> AppResult<SendResponse> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    let indexed = state.require(&key).await?;
    let filed = filing_of(
        &state.organizations.read().await?,
        &key,
        &indexed.stored.provenance.captured_at,
    );
    if let Some(record) = &filed.zotero {
        return Err(AppError::api(
            StatusCode::CONFLICT,
            ApiErrorErrorKind::AlreadySent,
            format!("{key} is already in Zotero as {}", *record.item_key),
        ));
    }
    let mut held = Vec::new();
    match filed.notes.len() {
        0 => {}
        1 => held.push("a note".to_string()),
        count => held.push(format!("{count} notes")),
    }
    if let Extraction::Extracted { .. } = indexed.extraction {
        held.push("an extraction's Markdown".to_string());
    }
    if !held.is_empty() {
        return Err(AppError::api(
            StatusCode::CONFLICT,
            ApiErrorErrorKind::PdfOnlyRefused,
            format!(
                "{key} has {}, which a standalone PDF in Zotero cannot hold: send it to a Zotero item",
                held.join(" and ")
            ),
        ));
    }
    state.zotero.require_ready().await?;
    let bytes = tokio::fs::read(&indexed.path).await?;
    let attachment = non_empty(
        &state
            .zotero
            .attach_standalone(&format!("{key}.pdf"), &indexed.stored.title.text, &bytes)
            .await?,
    );
    let record = ZoteroRecord {
        item_key: attachment.clone(),
        sent_at: Timestamp::now(),
        method: SendMethod::StandaloneAttachment,
        steps: vec![SendStep::Pdf {
            attachment_key: attachment.clone(),
        }],
    };
    save(&state, &key, &record).await?;
    let kept = leave(&state, &key).await?;
    Ok(SendResponse {
        item_key: attachment,
        created: true,
        performed: vec![SendResponsePerformedItem::Pdf],
        kept,
    })
}

/// Each send runs as its own task: a client that disconnects mid-send drops only its wait for
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

async fn send_and_extract(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<SendAndExtractResponse>> {
    let origin = origin(&headers)?;
    tokio::spawn(send_and_extract_item(state, origin, key))
        .await
        .map_err(AppError::internal)?
        .map(Json)
}

async fn send_pdf_only(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<SendResponse>> {
    tokio::spawn(send_pdf_only_item(state, key))
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
        .route("/api/items/{key}/zotero/extracted", post(send_and_extract))
        .route("/api/items/{key}/zotero/pdf-only", post(send_pdf_only))
        .route("/api/items/{key}", axum::routing::delete(delete))
}
