//! The send action: create the bucket item in Zotero, set its URL and access date, attach the
//! stored PDF and the extraction Markdown, and record the Zotero key in the filing document
//! after each step. Once every step is done the item leaves the bucket, since Zotero holds it
//! now, unless a collection holding it (or holding a collection that holds it) keeps its items
//! offline. Deleting an item moves its PDF to the desktop trash and drops its filing.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};

use crate::config::{ARXIV_PREFIX, ARXIV_URL, PDF_SUFFIX};
use crate::contract::{
    ApiErrorErrorKind, Extraction, LibraryPayload, Organization, Resolution, SendResponse,
    SendResponsePerformedItem, SendSource, SendStep, Timestamp, ZoteroRecord, ZoteroStatus,
    ZoteroStatusSentPendingItem,
};
use crate::error::{AppError, AppResult};
use crate::index::IndexedItem;
use crate::organization::{filing, kept_offline, non_empty, remove_item, set_zotero_record};
use crate::state::Shared;
use crate::zotero::ExistingPdf;

/// A step of a send after Zotero has created the item.
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Fields,
    Pdf,
    Markdown,
}

fn step_of(done: &SendStep) -> Step {
    match done {
        SendStep::Fields => Step::Fields,
        SendStep::Pdf(_) => Step::Pdf,
        SendStep::Markdown(_) => Step::Markdown,
    }
}

fn steps_owed(extraction: &Extraction) -> Vec<Step> {
    match extraction {
        Extraction::Extracted { .. } => vec![Step::Fields, Step::Pdf, Step::Markdown],
        Extraction::None => vec![Step::Fields, Step::Pdf],
    }
}

fn pending_steps(record: &ZoteroRecord, extraction: &Extraction) -> Vec<Step> {
    let done: Vec<Step> = record.steps.iter().map(step_of).collect();
    steps_owed(extraction)
        .into_iter()
        .filter(|step| !done.contains(step))
        .collect()
}

pub fn zotero_status(record: Option<&ZoteroRecord>, extraction: &Extraction) -> ZoteroStatus {
    match record {
        None => ZoteroStatus::Unsent,
        Some(record) => ZoteroStatus::Sent {
            pending: pending_steps(record, extraction)
                .into_iter()
                .map(|step| match step {
                    Step::Fields => ZoteroStatusSentPendingItem::Fields,
                    Step::Pdf => ZoteroStatusSentPendingItem::Pdf,
                    Step::Markdown => ZoteroStatusSentPendingItem::Markdown,
                })
                .collect(),
            record: record.clone(),
        },
    }
}

/// The Zotero item for a PDF with no identifier: a manuscript (BibTeX `@unpublished`, which
/// Zotero's BibTeX import maps to its manuscript type) that carries only the title; the URL and
/// access date follow as the `fields` step. Zotero's import keeps a braced value as written
/// apart from LaTeX markup, and a LaTeX-escaping writer's output does not survive it
/// (`\textunderscore{}` arrives as "‗"), so the title goes in as written with only its braces
/// escaped: BibTeX ends a value at its balancing brace, and Zotero reads `\{` back as `{`.
pub fn manuscript_bibtex(title: &str) -> String {
    let value = title.replace('{', "\\{").replace('}', "\\}");
    format!("@unpublished{{bucket,\n  title = {{{value}}},\n}}\n")
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

fn resolver_failure(resolution: &Resolution) -> Option<AppError> {
    match resolution {
        Resolution::Failed {
            plugin_id,
            identifier,
            exit_code,
            stderr,
            ..
        } => Some(AppError::api(
            StatusCode::BAD_GATEWAY,
            ApiErrorErrorKind::ResolverFailed,
            format!(
                "resolver {} failed on {} (exit {exit_code}): {}",
                **plugin_id,
                **identifier,
                stderr.trim()
            ),
        )),
        _ => None,
    }
}

// Zotero's BibTeX import maps `@misc` to `document` and maps no entry type to `preprint`, so
// an arXiv item goes through Zotero's own arXiv translator instead; the resolver has already
// confirmed the id against arXiv. DOI, ISBN and zbMATH BibTeX map to their right types.
async fn create(state: &Shared, indexed: &IndexedItem) -> AppResult<ZoteroRecord> {
    let key = indexed.stored.key.as_str();
    let resolution = state
        .store
        .resolve(key, &state.config.resolvers_manifest)
        .await?;
    if let Some(error) = resolver_failure(&resolution) {
        return Err(error);
    }
    let (source, item_key) = match resolution {
        Resolution::Resolved {
            plugin_id,
            identifier,
            bibtex,
            ..
        } => {
            let item_key = if plugin_id.as_str() == "arxiv" {
                let arxiv = format!("arXiv:{}", arxiv_id(&identifier));
                state.zotero.import_by_identifier(&arxiv).await?
            } else {
                state.zotero.import_bibtex(&bibtex).await?
            };
            (
                SendSource::Resolver {
                    plugin_id,
                    identifier,
                },
                item_key,
            )
        }
        _ => {
            let bibtex = manuscript_bibtex(&indexed.stored.provenance.title_hint);
            (
                SendSource::Manuscript,
                state.zotero.import_bibtex(&bibtex).await?,
            )
        }
    };
    Ok(ZoteroRecord {
        item_key: non_empty(&item_key),
        sent_at: Timestamp::now(),
        source,
        steps: Vec::new(),
    })
}

async fn perform(
    state: &Shared,
    step: Step,
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
                .set_url_and_access_date(item_key, &provenance.source_url, &provenance.captured_at)
                .await?;
            SendStep::Fields
        }
        // The captured PDF once: Zotero's own copy when its import downloaded the same bytes,
        // otherwise the bucket's stored file.
        Step::Pdf => match state
            .zotero
            .pdf_with_hash(item_key, &provenance.original_sha256)
            .await?
        {
            ExistingPdf::Found(attachment) => SendStep::Pdf(attached(attachment)),
            ExistingPdf::Absent => {
                let bytes = tokio::fs::read(&indexed.path).await?;
                let attachment = state
                    .zotero
                    .attach_bytes(item_key, &format!("{key}.pdf"), "Full Text PDF", &bytes)
                    .await?;
                SendStep::Pdf(attached(attachment))
            }
        },
        // Named as the extraction loop names a Markdown child, which marks an item extracted.
        Step::Markdown => {
            let name = format!("{item_key}_extracted.md");
            let bytes = tokio::fs::read(state.config.root.join(format!("{key}.md"))).await?;
            let attachment = state
                .zotero
                .attach_bytes(item_key, &name, &name, &bytes)
                .await?;
            SendStep::Markdown(attached(attachment))
        }
    })
}

/// The export hears of the removal first, so the export that the filing write starts drops the
/// item instead of refusing to lose it.
async fn remove(state: &Shared, key: &str) -> AppResult<Organization> {
    state.removed(&[key.to_string()]);
    state.store.remove(key).await?;
    state
        .organizations
        .update(|org| remove_item(org, key))
        .await
}

async fn save(state: &Shared, key: &str, record: &ZoteroRecord) -> AppResult<Organization> {
    let record = record.clone();
    state
        .organizations
        .update(|org| set_zotero_record(org, key, record, &Timestamp::now()))
        .await
}

async fn send(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<SendResponse>> {
    let _one_at_a_time = state.sends.lock().await;
    let indexed = state.require(&key).await?;
    let existing =
        filing(&state.organizations.read().await?, &key).and_then(|filed| filed.zotero.clone());
    if let Some(record) = &existing {
        if pending_steps(record, &indexed.extraction).is_empty() {
            return Err(AppError::api(
                StatusCode::CONFLICT,
                ApiErrorErrorKind::AlreadySent,
                format!("{key} is already in Zotero as {}", *record.item_key),
            ));
        }
    }

    let created = existing.is_none();
    let mut record = match existing {
        Some(record) => record,
        None => create(&state, &indexed).await?,
    };
    save(&state, &key, &record).await?;

    let mut performed = Vec::new();
    for step in pending_steps(&record, &indexed.extraction) {
        let done = perform(&state, step, &record.item_key, &indexed).await?;
        record.steps.push(done);
        save(&state, &key, &record).await?;
        performed.push(match step {
            Step::Fields => SendResponsePerformedItem::Fields,
            Step::Pdf => SendResponsePerformedItem::Pdf,
            Step::Markdown => SendResponsePerformedItem::Markdown,
        });
    }
    let kept = kept_offline(&state.organizations.read().await?, &key);
    if !kept {
        remove(&state, &key).await?;
    }
    Ok(Json(SendResponse {
        item_key: record.item_key,
        created,
        performed,
        kept,
    }))
}

async fn delete(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<LibraryPayload>> {
    let _one_at_a_time = state.sends.lock().await;
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
    use super::arxiv_id;

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
}
