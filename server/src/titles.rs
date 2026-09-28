//! Item titles and authors from Zotero ("Retrieve metadata", as Zotero names it): the server asks
//! Zotero's local write API to resolve the item's URL, which runs Zotero's own identification
//! methods and saves nothing. The title, authors, year and abstract of the CSL-JSON it answers
//! become the item's, recorded inside the PDF. Without an answer the store reads them from the
//! PDF itself.
use crate::contract::{NonEmpty, RetrieveMetadataOutcome, TitleSource};
use crate::error::{AppError, AppResult};
use crate::send::import_url;
use crate::state::AppState;
use crate::store::ResolvedMetadata;
use crate::zotero::{Csl, CslDatePart, CslName, Resolution};

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("the text names what happened")
}

fn present(part: &Option<String>) -> Option<&str> {
    part.as_deref()
        .map(str::trim)
        .filter(|part| !part.is_empty())
}

// A name as it is written in running text: given names, particles, family name, suffix; the
// CSL-JSON "Display Order" for names written with the given name first.
fn written(name: &CslName) -> String {
    if let Some(literal) = present(&name.literal) {
        return literal.to_string();
    }
    let parts = [
        &name.given,
        &name.dropping_particle,
        &name.non_dropping_particle,
        &name.family,
    ];
    let written = parts
        .into_iter()
        .filter_map(present)
        .collect::<Vec<_>>()
        .join(" ");
    match present(&name.suffix) {
        Some(suffix) => format!("{written}, {suffix}"),
        None => written,
    }
}

fn year(csl: &Csl) -> AppResult<Option<i64>> {
    let Some(first) = csl
        .issued
        .as_ref()
        .and_then(|issued| issued.date_parts.first())
        .and_then(|parts| parts.first())
    else {
        return Ok(None);
    };
    match first {
        CslDatePart::Number(year) => Ok(Some(*year)),
        CslDatePart::Text(year) => year.trim().parse().map(Some).map_err(|error| {
            AppError::Zotero(format!(
                "Zotero resolved a year that is not a number: {year:?}: {error}"
            ))
        }),
    }
}

fn metadata(csl: &Csl) -> AppResult<ResolvedMetadata> {
    let title = present(&csl.title)
        .ok_or_else(|| AppError::Zotero("Zotero resolved an item with no title".to_string()))?;
    Ok(ResolvedMetadata {
        title: title.to_string(),
        authors: csl.author.iter().map(written).collect(),
        year: year(csl)?,
        abstract_: present(&csl.abstract_).map(str::to_string),
    })
}

async fn retrieve(state: &AppState, origin: &str, key: &str) -> AppResult<RetrieveMetadataOutcome> {
    let provenance = state.require(key).await?.stored.provenance;
    let url = import_url(origin, &provenance, key);
    Ok(match state.zotero.resolve_url(&url).await? {
        Resolution::Unidentified { attempts } => RetrieveMetadataOutcome::Unidentified { attempts },
        Resolution::Resolved { method, csl } => {
            let metadata = metadata(&csl)?;
            state
                .store
                .record_metadata(key, TitleSource::Resolver, &metadata)
                .await?;
            RetrieveMetadataOutcome::Resolved {
                method,
                title: nonempty(metadata.title),
            }
        }
    })
}

/// "Retrieve metadata" on KEY, whose request came to ORIGIN. A retrieval that failed (Zotero
/// down or refusing, an answer the bucket cannot record) is its `error` outcome; the item's
/// title then stays as it was.
pub async fn retrieve_metadata(
    state: &AppState,
    origin: &str,
    key: &str,
) -> RetrieveMetadataOutcome {
    match retrieve(state, origin, key).await {
        Ok(outcome) => outcome,
        Err(error) => RetrieveMetadataOutcome::Error {
            message: nonempty(error.to_string()),
        },
    }
}
