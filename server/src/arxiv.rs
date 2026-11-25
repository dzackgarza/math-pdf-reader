//! Search arXiv for a stored item's structured metadata and promote a selected version.
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use quick_xml::de::from_str;
use reqwest::Client;
use serde::Deserialize;
use std::collections::BTreeSet;

use crate::contract::{
    ApiErrorErrorKind, ArxivMatch, ArxivPromotionResponse, ArxivSearchResponse, NonEmpty,
    TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::imports::find_arxiv_pdf_at;
use crate::state::Shared;
use crate::store::{stage_file, ResolvedMetadata, StageFailure, Upload};

const MATCH_THRESHOLD: f64 = 0.8;
/// Link and page labels that a capture records as a title when the page names no paper.
const PAGE_LABELS: [&str; 9] = [
    "view pdf",
    "pdf",
    "download",
    "download pdf",
    "full text",
    "full text pdf",
    "untitled",
    "none",
    "null",
];
const MAX_RESULTS: usize = 5;

fn validate_arxiv_config(config: &crate::contract::AppConfig) -> AppResult<()> {
    for (value, path) in [
        (config.arxiv.api_url.as_str(), "/api/query"),
        (config.arxiv.abs_url.as_str(), "/abs/"),
        (config.arxiv.pdf_url.as_str(), "/pdf/"),
        (config.arxiv.e_print_url.as_str(), "/e-print/"),
    ] {
        let url = url::Url::parse(value)
            .map_err(|error| AppError::invalid(format!("invalid arXiv endpoint: {error}")))?;
        let production_host = url.scheme() == "https"
            && matches!(url.host_str(), Some("arxiv.org" | "export.arxiv.org"));
        let fixture_host = cfg!(feature = "arxiv-fixtures")
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1");
        if !(production_host || fixture_host)
            || url.path() != path
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::invalid(format!(
                "invalid arXiv endpoint: {value}"
            )));
        }
    }
    Ok(())
}

fn validate_promotion(
    candidate: &ArxivMatch,
    config: &crate::contract::AppConfig,
) -> AppResult<()> {
    validate_arxiv_config(config)?;
    if candidate.score < MATCH_THRESHOLD {
        return Err(AppError::invalid(format!(
            "arXiv candidate score {:.0}% is below the {:.0}% promotion threshold",
            candidate.score * 100.0,
            MATCH_THRESHOLD * 100.0
        )));
    }
    let pdf_url = url::Url::parse(&candidate.pdf_url)
        .map_err(|error| AppError::invalid(format!("invalid arXiv PDF URL: {error}")))?;
    const ARXIV_PDF: &str = "https://arxiv.org/pdf/";
    if !candidate.pdf_url.starts_with(ARXIV_PDF) || pdf_url.host_str() != Some("arxiv.org") {
        return Err(AppError::invalid(format!(
            "{} is not a configured arXiv PDF URL",
            candidate.pdf_url
        )));
    }
    let identifier = candidate
        .pdf_url
        .strip_prefix(ARXIV_PDF)
        .unwrap_or_default()
        .trim_matches('/');
    if identifier != candidate.id.as_str()
        && identifier != format!("{}v{}", candidate.id.as_str(), candidate.version.as_str())
    {
        return Err(AppError::invalid(format!(
            "{} does not name arXiv candidate {}",
            candidate.pdf_url,
            candidate.id.as_str()
        )));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct Feed {
    #[serde(rename = "entry", default)]
    entries: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
struct Entry {
    id: String,
    title: String,
    summary: Option<String>,
    published: Option<String>,
    #[serde(rename = "author", default)]
    authors: Vec<Author>,
}

#[derive(Debug, Deserialize)]
struct Author {
    name: String,
}

fn text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn words(value: &str) -> BTreeSet<String> {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_lowercase().collect::<String>()
            } else {
                " ".to_string()
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn similarity(left: &str, right: &str) -> f64 {
    if left.trim().eq_ignore_ascii_case(right.trim()) {
        return 1.0;
    }
    let left = words(left);
    let right = words(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(&right).count() as f64;
    2.0 * shared / (left.len() as f64 + right.len() as f64)
}

fn author_similarity(left: &[String], right: &[String]) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let left: BTreeSet<String> = left
        .iter()
        .map(|author| text(author).to_lowercase())
        .collect();
    let right: BTreeSet<String> = right
        .iter()
        .map(|author| text(author).to_lowercase())
        .collect();
    let shared = left.intersection(&right).count() as f64;
    2.0 * shared / (left.len() as f64 + right.len() as f64)
}

fn score(
    title: &str,
    authors: &[String],
    abstract_: Option<&str>,
    candidate: &Entry,
) -> (f64, Vec<NonEmpty>) {
    let candidate_title = text(&candidate.title);
    let candidate_authors: Vec<String> = candidate
        .authors
        .iter()
        .map(|author| author.name.clone())
        .collect();
    let title_score = similarity(title, &candidate_title);
    let author_score = author_similarity(authors, &candidate_authors);
    let abstract_score = abstract_.and_then(|abstract_| {
        candidate
            .summary
            .as_deref()
            .map(|summary| similarity(abstract_, summary))
    });
    let (score, reasons) = match abstract_score {
        Some(abstract_score) => (
            0.65 * title_score + 0.25 * author_score + 0.10 * abstract_score,
            vec![
                format!("title {:.0}%", title_score * 100.0),
                format!("authors {:.0}%", author_score * 100.0),
                format!("abstract {:.0}%", abstract_score * 100.0),
            ],
        ),
        None => (
            0.70 * title_score + 0.30 * author_score,
            vec![
                format!("title {:.0}%", title_score * 100.0),
                format!("authors {:.0}%", author_score * 100.0),
            ],
        ),
    };
    let (score, mut reasons) = if authors.is_empty() && abstract_.is_none() {
        (
            title_score,
            vec![format!("title {:.0}%", title_score * 100.0)],
        )
    } else {
        (score, reasons)
    };
    if score < MATCH_THRESHOLD {
        reasons.clear();
    }
    (
        score,
        reasons
            .into_iter()
            .map(|reason| NonEmpty::try_from(reason).expect("a score reason is not empty"))
            .collect(),
    )
}

fn identifier(id: &str) -> Option<(String, String)> {
    let raw = id.split("/abs/").nth(1)?.trim_end_matches('/');
    let (base, version) = raw
        .rsplit_once('v')
        .filter(|(_, suffix)| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
        .map_or((raw, "current"), |(base, version)| (base, version));
    if base.is_empty() {
        return None;
    }
    Some((base.to_string(), version.to_string()))
}

fn year(published: Option<&str>) -> Option<i64> {
    published?.get(..4)?.parse().ok()
}

fn candidate(
    entry: Entry,
    title: &str,
    authors: &[String],
    abstract_: Option<&str>,
) -> Option<ArxivMatch> {
    let (id, version) = identifier(&entry.id)?;
    let (score, reasons) = score(title, authors, abstract_, &entry);
    if score < MATCH_THRESHOLD {
        return None;
    }
    let authors = entry
        .authors
        .into_iter()
        .map(|author| NonEmpty::try_from(text(&author.name)).expect("arXiv authors are not empty"))
        .collect();
    Some(ArxivMatch {
        id: NonEmpty::try_from(id.clone()).expect("an arXiv ID is not empty"),
        version: NonEmpty::try_from(version).expect("an arXiv version is not empty"),
        title: NonEmpty::try_from(text(&entry.title)).expect("an arXiv title is not empty"),
        authors,
        abstract_: entry
            .summary
            .as_deref()
            .map(text)
            .filter(|summary| !summary.is_empty())
            .map(|summary| NonEmpty::try_from(summary).expect("an arXiv abstract is not empty")),
        year: year(entry.published.as_deref()),
        score,
        abs_url: format!("https://arxiv.org/abs/{id}"),
        pdf_url: format!("https://arxiv.org/pdf/{id}"),
        reasons,
    })
}

/// Whether TITLE names no paper: a page label, the text "None", empty, or the PDF's file name
/// (its key, its stored name, or the last segment of its PDF URL, with or without `.pdf`).
fn placeholder(item: &crate::contract::StoredItem) -> bool {
    if item.title.source == TitleSource::Filename {
        return true;
    }
    let title = text(&item.title.text).to_lowercase();
    if title.is_empty() || PAGE_LABELS.contains(&title.as_str()) {
        return true;
    }
    let key = item.key.as_str().to_lowercase();
    let mut names = vec![key.clone(), format!("{key}.pdf")];
    if let Some(segment) = url::Url::parse(&item.provenance.pdf_url)
        .ok()
        .and_then(|url| url.path_segments()?.next_back().map(str::to_string))
    {
        let segment = percent_encoding::percent_decode_str(&segment)
            .decode_utf8_lossy()
            .to_lowercase();
        names.push(segment.trim_end_matches(".pdf").to_string());
        names.push(segment);
    }
    names.contains(&title)
}

async fn search_candidates(state: &Shared, key: &str) -> AppResult<ArxivSearchResponse> {
    validate_arxiv_config(&state.config.app)?;
    let indexed = state.require(key).await?;
    let item = &indexed.stored;
    if placeholder(item) {
        return Err(AppError::api(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorErrorKind::PlaceholderTitle,
            format!(
                "\"{}\" is not the paper's title, so arXiv cannot be searched for it. Set the title, then search again.",
                *item.title.text
            ),
        ));
    }
    let escaped_title = item.title.text.replace('"', "\\\"");
    let query = format!("ti:\"{escaped_title}\"");
    let response = Client::builder()
        .user_agent("Math PDF Reader arXiv lookup")
        .build()
        .map_err(AppError::internal)?
        .get(&state.config.app.arxiv.api_url)
        .query(&[
            ("search_query", query),
            ("start", "0".to_string()),
            ("max_results", "10".to_string()),
            ("sortBy", "relevance".to_string()),
            ("sortOrder", "descending".to_string()),
        ])
        .send()
        .await
        .map_err(|error| AppError::internal(format!("arXiv API request failed: {error}")))?
        .error_for_status()
        .map_err(|error| AppError::internal(format!("arXiv API returned an error: {error}")))?
        .text()
        .await
        .map_err(|error| {
            AppError::internal(format!("arXiv API response could not be read: {error}"))
        })?;
    let feed: Feed = from_str(&response).map_err(|error| {
        AppError::internal(format!(
            "arXiv API response was not valid Atom XML: {error}"
        ))
    })?;
    let authors: Vec<String> = item
        .authors
        .iter()
        .map(|author| author.as_str().to_string())
        .collect();
    let mut matches: Vec<_> = feed
        .entries
        .into_iter()
        .filter_map(|entry| {
            candidate(
                entry,
                &item.title.text,
                &authors,
                item.abstract_.as_deref().map(String::as_str),
            )
        })
        .collect();
    for candidate in &mut matches {
        let versioned_id = if candidate.version.as_str() == "current" {
            candidate.id.to_string()
        } else {
            format!("{}v{}", candidate.id.as_str(), candidate.version.as_str())
        };
        candidate.abs_url = format!("https://arxiv.org/abs/{versioned_id}");
        candidate.pdf_url = format!("https://arxiv.org/pdf/{versioned_id}");
    }
    matches.sort_by(|left, right| right.score.total_cmp(&left.score));
    matches.truncate(MAX_RESULTS);
    Ok(ArxivSearchResponse {
        threshold: MATCH_THRESHOLD,
        matches,
    })
}

async fn search(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<ArxivSearchResponse>> {
    Ok(Json(search_candidates(&state, &key).await?))
}

async fn existing_promotion(
    state: &Shared,
    key: &str,
    requested: &ArxivMatch,
) -> AppResult<Option<ArxivPromotionResponse>> {
    let items = state.store.items().await?;
    let original = items
        .iter()
        .find(|item| item.stored.key.as_str() == key)
        .ok_or_else(|| AppError::unknown_item(key))?;
    if let Some(lineage) = original.source_lineage.as_ref() {
        if lineage.preferred_key.as_str() == key
            && lineage.original_key.as_str() == key
            && lineage.discovered_source_url == requested.pdf_url
        {
            return Ok(Some(ArxivPromotionResponse {
                key: lineage.preferred_key.clone(),
                original_key: lineage.original_key.clone(),
                existing: true,
                missing: false,
                source_lineage: lineage.clone(),
            }));
        }
    }
    let embedded = items
        .iter()
        .filter_map(|item| item.source_lineage.as_ref())
        .find(|lineage| {
            lineage.original_key.as_str() == key
                && lineage.original_provenance == original.stored.provenance
                && lineage.discovered_source_url == requested.pdf_url
        });
    let organization = state.organizations.read().await?;
    let filed = organization
        .items
        .values()
        .filter_map(|item| item.source_lineage.as_ref())
        .find(|lineage| {
            lineage.original_key.as_str() == key
                && lineage.original_provenance == original.stored.provenance
                && lineage.discovered_source_url == requested.pdf_url
        });
    let Some(lineage) = embedded.or(filed) else {
        return Ok(None);
    };
    let missing = !items
        .iter()
        .any(|item| item.stored.key == lineage.preferred_key);
    if missing {
        return Ok(None);
    }
    Ok(Some(ArxivPromotionResponse {
        key: lineage.preferred_key.clone(),
        original_key: key
            .try_into()
            .map_err(|_| AppError::internal("the original item key is empty"))?,
        existing: true,
        missing,
        source_lineage: lineage.clone(),
    }))
}

async fn promote(
    State(state): State<Shared>,
    Path(key): Path<String>,
    body: Bytes,
) -> AppResult<Json<ArxivPromotionResponse>> {
    let _one_at_a_time = state.sends.async_lock(key.clone()).await;
    let _chat = state.ai.chats.lock().await;
    let _locked = state.organizations.lock().await?;
    let requested: ArxivMatch = crate::state::parse_body(&body)?;
    validate_promotion(&requested, &state.config.app)?;
    let original = state.require(&key).await?;
    if let Some(existing) = existing_promotion(&state, &key, &requested).await? {
        if existing.key.as_str() == key {
            return Ok(Json(existing));
        }
        let preferred_key = existing.key.as_str();
        let preferred = state
            .store
            .item(preferred_key)
            .await?
            .ok_or_else(|| AppError::unknown_item(preferred_key))?;
        if preferred.source_lineage.as_ref() != Some(&existing.source_lineage)
            || preferred.stored.provenance.pdf_url != requested.pdf_url
        {
            return Err(AppError::store_failed("the linked arXiv item changed"));
        }
        let organization = state.organizations.read().await?;
        if let Some(filing) = organization.items.get(&preferred.stored.key) {
            let mut empty = crate::organization::unfiled(&preferred.stored.provenance.captured_at);
            empty.modified_at = filing.modified_at.clone();
            empty.source_lineage = filing.source_lineage.clone();
            if filing != &empty {
                return Err(AppError::invalid(
                    "the linked arXiv item has filing that requires manual reconciliation",
                ));
            }
        }
        let preferred_path = state
            .store
            .pdf_path(preferred_key)?
            .ok_or_else(|| AppError::unknown_item(preferred_key))?;
        let preferred_dir = preferred_path
            .parent()
            .expect("a stored PDF has a directory");
        for entry in std::fs::read_dir(preferred_dir)? {
            let name = entry?.file_name();
            if name == format!("{preferred_key}.md").as_str()
                || name == format!("{preferred_key}.extraction").as_str()
            {
                return Err(AppError::invalid(
                    "the linked arXiv item has extraction that requires manual reconciliation",
                ));
            }
        }
        let original_sha256 = state
            .store
            .open(&key)
            .await?
            .ok_or_else(|| AppError::unknown_item(&key))?
            .sha256;
        let pdf = stage_file(state.store.root(), &preferred_path)
            .await
            .map_err(|failure| match failure {
                StageFailure::Read(error) | StageFailure::Write(error) => {
                    AppError::store_failed(error)
                }
            })?;
        let upload = Upload {
            pdf,
            filename: None,
            pdf_url: requested.pdf_url.clone(),
            title_hint: preferred.stored.title.text.as_str().to_string(),
        };
        let metadata = ResolvedMetadata {
            title: preferred.stored.title.text.as_str().to_string(),
            authors: preferred
                .stored
                .authors
                .iter()
                .map(|author| author.as_str().to_string())
                .collect(),
            year: preferred.stored.year,
            abstract_: preferred
                .stored
                .abstract_
                .as_ref()
                .map(|text| text.as_str().to_string()),
        };
        let original_key: NonEmpty = key
            .clone()
            .try_into()
            .map_err(|_| AppError::internal("the original item key is empty"))?;
        let (captured, lineage) = state
            .store
            .replace_from_arxiv(
                &upload,
                &metadata,
                &original_key,
                &original.stored.provenance,
                &original_sha256,
                Some(preferred_key),
            )
            .await?;
        state.stored();
        return Ok(Json(ArxivPromotionResponse {
            key: captured.item.key,
            original_key,
            existing: false,
            missing: false,
            source_lineage: lineage,
        }));
    }
    drop(_locked);
    drop(_chat);
    let original_sha256 = state
        .store
        .open(&key)
        .await?
        .ok_or_else(|| AppError::unknown_item(&key))?
        .sha256;
    let candidate = search_candidates(&state, &key)
        .await?
        .matches
        .into_iter()
        .find(|candidate| {
            candidate.id == requested.id
                && candidate.version == requested.version
                && candidate.pdf_url == requested.pdf_url
        })
        .ok_or_else(|| {
            AppError::invalid("the arXiv candidate is not a sufficiently confident discovery match")
        })?;
    let download_url = format!(
        "{}{}",
        state.config.app.arxiv.pdf_url,
        candidate
            .pdf_url
            .trim_start_matches("https://arxiv.org/pdf/")
    );
    let mut upload =
        find_arxiv_pdf_at(&download_url, &state.config.app.rebuild, state.store.root()).await?;
    upload.pdf_url = candidate.pdf_url.to_string();
    let metadata = ResolvedMetadata {
        title: candidate.title.to_string(),
        authors: candidate
            .authors
            .iter()
            .map(|author| author.as_str().to_string())
            .collect(),
        year: candidate.year,
        abstract_: candidate
            .abstract_
            .as_ref()
            .map(|abstract_| abstract_.as_str().to_string()),
    };
    let original_key: NonEmpty = key
        .clone()
        .try_into()
        .map_err(|_| AppError::internal("the original item key is empty"))?;
    let _chat = state.ai.chats.lock().await;
    let _locked = state.organizations.lock().await?;
    state.store.clean_pending_promotions().await?;
    if let Some(existing) = existing_promotion(&state, &key, &requested).await? {
        return Ok(Json(existing));
    }
    if state.organizations.removed().await?.contains(&key) {
        return Err(AppError::unknown_item(&key));
    }
    let current = state.require(&key).await?;
    if current.stored.provenance != original.stored.provenance {
        return Err(AppError::invalid(
            "the original item changed during arXiv discovery",
        ));
    }
    let (captured, lineage) = state
        .store
        .replace_from_arxiv(
            &upload,
            &metadata,
            &original_key,
            &original.stored.provenance,
            &original_sha256,
            None,
        )
        .await?;
    state.stored();
    Ok(Json(ArxivPromotionResponse {
        key: captured.item.key,
        original_key,
        existing: captured.existing,
        missing: false,
        source_lineage: lineage,
    }))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/items/{key}/arxiv", post(search))
        .route("/api/items/{key}/arxiv/promote", post(promote))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_endpoints_reject_untrusted_hosts_and_paths() {
        let mut config: crate::contract::AppConfig =
            serde_json::from_str(include_str!("../../pdf-bucket.config.json"))
                .expect("the application configuration is valid");
        assert!(validate_arxiv_config(&config).is_ok());
        config.arxiv.pdf_url = "https://arxiv.org.attacker.example/pdf/".into();
        assert!(validate_arxiv_config(&config).is_err());
        config.arxiv.pdf_url = "http://arxiv.org/pdf/".into();
        assert!(validate_arxiv_config(&config).is_err());
        config.arxiv.pdf_url = "https://arxiv.org/not-pdf/".into();
        assert!(validate_arxiv_config(&config).is_err());
        config.arxiv.pdf_url = "https://arxiv.org/pdf/".into();
        config.arxiv.api_url = "http://127.0.0.1:8080/api/query".into();
        assert_eq!(
            validate_arxiv_config(&config).is_ok(),
            cfg!(feature = "arxiv-fixtures")
        );
    }

    fn entry() -> Entry {
        Entry {
            id: "http://arxiv.org/abs/1211.6367v5".to_string(),
            title: "Moduli of surfaces with an anti-canonical cycle".to_string(),
            summary: Some("We prove a global Torelli theorem for pairs.".to_string()),
            published: Some("2012-11-27T17:34:35Z".to_string()),
            authors: vec![
                Author {
                    name: "Mark Gross".to_string(),
                },
                Author {
                    name: "Paul Hacking".to_string(),
                },
                Author {
                    name: "Sean Keel".to_string(),
                },
            ],
        }
    }

    #[test]
    fn exact_structured_metadata_is_a_match_even_when_publication_year_differs() {
        let candidate = candidate(
            entry(),
            "Moduli of surfaces with an anti-canonical cycle",
            &[
                "Mark Gross".to_string(),
                "Paul Hacking".to_string(),
                "Sean Keel".to_string(),
            ],
            Some("We prove a global Torelli theorem for pairs."),
        )
        .expect("exact metadata should match");
        assert_eq!(String::from(candidate.id), "1211.6367");
        assert_eq!(String::from(candidate.version), "5");
        assert!(candidate.score >= MATCH_THRESHOLD);
    }

    #[test]
    fn unrelated_authors_keep_a_title_collision_below_threshold() {
        assert!(candidate(
            entry(),
            "Moduli of surfaces with an anti-canonical cycle",
            &["Someone Else".to_string()],
            None,
        )
        .is_none());
    }

    #[test]
    fn near_title_and_author_metadata_remains_a_confident_match() {
        let candidate = candidate(
            entry(),
            "Moduli of surfaces with an anti-canonical cycle",
            &["Paul Hacking".to_string(), "Mark Gross".to_string()],
            None,
        )
        .expect("a near title with matching authors should match");
        assert!(candidate.score >= MATCH_THRESHOLD);
    }

    #[test]
    fn incomplete_metadata_can_match_without_an_abstract() {
        let candidate = candidate(
            entry(),
            "Moduli of surfaces with an anti-canonical cycle",
            &[],
            None,
        )
        .expect("an exact title should match without authors or abstract");
        assert!(candidate
            .reasons
            .iter()
            .any(|reason| reason.starts_with("title")));
    }
}
