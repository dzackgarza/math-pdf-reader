//! The send action: find or create the bucket item in Zotero, set its URL and access date,
//! attach the stored PDF (the bucket's copy, with its annotations) and the extraction Markdown,
//! add each of the item's notes as a Zotero child note, and record the Zotero key in the filing
//! document after each step. Once every step is done the item leaves the bucket, since Zotero
//! holds it now, unless a collection holding it (or holding a collection that holds it) keeps
//! its items offline. Deleting an item moves its PDF to the desktop trash and drops its filing.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use biblatex::{Bibliography, RetrievalError};

use crate::config::{ARXIV_PREFIX, ARXIV_URL, PDF_SUFFIX};
use crate::contract::{
    ApiErrorErrorKind, Extraction, ItemNote, LibraryPayload, Organization, Provenance,
    SendResponse, SendResponsePerformedItem, SendSource, SendStep, Timestamp, ZoteroRecord,
    ZoteroStatus, ZoteroStatusSentPendingItem,
};
use crate::error::{AppError, AppResult};
use crate::index::IndexedItem;
use crate::organization::{filing_of, kept_offline, non_empty, set_zotero_record};
use crate::state::Shared;
use crate::titles::{resolve, Resolution};
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

/// BibTeX's braced value ends at its balancing brace, and Zotero reads `\{` back as `{`.
fn braced(value: &str) -> String {
    value.replace('{', "\\{").replace('}', "\\}")
}

/// The Zotero item for a PDF with no identifier: a manuscript (BibTeX `@unpublished`, which
/// Zotero's BibTeX import maps to its manuscript type) that carries the title and the page URL;
/// the access date follows as the `fields` step. The URL is in the entry itself so that a send
/// Zotero finished but the bucket never recorded finds the item by it. Zotero's import keeps a
/// braced value as written apart from LaTeX markup, and a LaTeX-escaping writer's output does
/// not survive it (`\textunderscore{}` arrives as "‗"), so the values go in as written with only
/// their braces escaped.
pub fn manuscript_bibtex(title: &str, url: &str) -> String {
    format!(
        "@unpublished{{bucket,\n  title = {{{}}},\n  url = {{{}}},\n}}\n",
        braced(title),
        braced(url)
    )
}

/// The arXiv id in an arXiv id or arxiv.org URL, as the resolver manifest's patterns accept
/// them; the same three rewrites as the arXiv resolver plugin (src/resolvers/arxivId.ts). The
/// query and fragment go before the `.pdf` suffix, which is only a suffix without them.
pub fn arxiv_id(input: &str) -> String {
    let bare = input
        .split(['?', '#'])
        .next()
        .expect("split yields a first part");
    let id = ARXIV_PREFIX.replace(bare, "");
    let id = ARXIV_URL.replace(&id, "");
    PDF_SUFFIX.replace(&id, "").into_owned()
}

/// The DOI in the resolver's BibTeX entry, when it carries one.
fn bibtex_doi(bibtex: &str) -> AppResult<Option<String>> {
    let bibliography = Bibliography::parse(bibtex)
        .map_err(|error| AppError::internal(format!("resolver BibTeX does not parse: {error}")))?;
    let entry = bibliography
        .iter()
        .next()
        .ok_or_else(|| AppError::internal("resolver BibTeX holds no entry"))?;
    match entry.doi() {
        Ok(doi) => Ok(Some(doi)),
        Err(RetrievalError::Missing(_)) => Ok(None),
        Err(error) => Err(AppError::internal(format!(
            "resolver BibTeX has a malformed doi: {error}"
        ))),
    }
}

/// How the item gets into Zotero once no existing item matches it.
enum Import {
    Identifier(String),
    Bibtex(String),
}

// Zotero's BibTeX import maps `@misc` to `document` and maps no entry type to `preprint`, so
// an arXiv item goes through Zotero's own arXiv translator instead; the resolver has already
// confirmed the id against arXiv. DOI, ISBN and zbMATH BibTeX map to their right types.
//
// Before importing, the send looks for the item in Zotero by the entry's DOI and by the page
// URL: a send that Zotero finished but the bucket never recorded (the process stopped between
// the two) goes on with that item instead of making a second one, and so does a work the
// library already holds.
async fn find_or_create(state: &Shared, indexed: &IndexedItem) -> AppResult<(ZoteroRecord, bool)> {
    let stored = &indexed.stored;
    let resolution = resolve(state, &stored.key).await?;
    let url = page_url(&stored.provenance);
    let (source, doi, import) = match resolution {
        Resolution::Failed {
            plugin_id,
            identifier,
            message,
        } => {
            return Err(AppError::api(
                StatusCode::BAD_GATEWAY,
                ApiErrorErrorKind::ResolverFailed,
                format!(
                    "resolver {} failed on {}: {}",
                    *plugin_id, *identifier, *message
                ),
            ));
        }
        Resolution::Resolved {
            plugin_id,
            identifier,
            bibtex,
            ..
        } => {
            let doi = bibtex_doi(&bibtex)?;
            let import = if plugin_id.as_str() == "arxiv" {
                Import::Identifier(format!("arXiv:{}", arxiv_id(&identifier)))
            } else {
                Import::Bibtex(bibtex)
            };
            let source = SendSource::Resolver {
                plugin_id,
                identifier,
            };
            (source, doi, import)
        }
        Resolution::Unidentified => (
            SendSource::Manuscript,
            None,
            Import::Bibtex(manuscript_bibtex(&stored.title.text, url)),
        ),
    };
    let existing = match &doi {
        Some(doi) => state.zotero.item_with_doi(doi).await?,
        None => None,
    };
    let existing = match existing {
        Some(key) => Some(key),
        None => state.zotero.item_with_url(url).await?,
    };
    let (item_key, created) = match existing {
        Some(key) => (key, false),
        None => (
            match import {
                Import::Identifier(identifier) => {
                    state.zotero.import_by_identifier(&identifier).await?
                }
                Import::Bibtex(bibtex) => state.zotero.import_bibtex(&bibtex).await?,
            },
            true,
        ),
    };
    let record = ZoteroRecord {
        item_key: non_empty(&item_key),
        sent_at: Timestamp::now(),
        source,
        steps: Vec::new(),
    };
    Ok((record, created))
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

async fn send_item(state: Shared, key: String) -> AppResult<SendResponse> {
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
        None => find_or_create(&state, &indexed).await?,
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
) -> AppResult<Json<SendResponse>> {
    tokio::spawn(send_item(state, key))
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

#[cfg(test)]
mod tests {
    use super::{arxiv_id, manuscript_bibtex};

    #[test]
    fn arxiv_ids_come_out_of_every_form_the_resolver_accepts() {
        assert_eq!(arxiv_id("arXiv:2609.21174v1"), "2609.21174v1");
        assert_eq!(
            arxiv_id("https://arxiv.org/abs/2609.21174v1"),
            "2609.21174v1"
        );
        assert_eq!(
            arxiv_id("https://arxiv.org/pdf/2609.21174v1.pdf"),
            "2609.21174v1"
        );
        assert_eq!(
            arxiv_id("https://arxiv.org/pdf/2609.21174?download=1"),
            "2609.21174"
        );
        assert_eq!(arxiv_id("math/0601001"), "math/0601001");
    }

    #[test]
    fn a_manuscript_entry_carries_the_title_and_page_url_with_braces_escaped() {
        assert_eq!(
            manuscript_bibtex("Sets {A} and B", "https://example.edu/notes.html"),
            "@unpublished{bucket,\n  title = {Sets \\{A\\} and B},\n  url = {https://example.edu/notes.html},\n}\n"
        );
    }
}
