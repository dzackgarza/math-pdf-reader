//! Where a stored PDF came from, checked again: whether its PDF URL and mirrors still serve the
//! captured bytes (the recorded original SHA-256), and rebuilding a PDF the store has lost from
//! the first of those URLs that does.
use std::fmt;
use std::time::Duration;

use sha2::{Digest, Sha256};
use url::Url;

use crate::contract::{
    AppConfigRebuild, NonEmpty, Provenance, RebuildOutcome, RebuildOutcomeRestoredMetadata,
    RebuildOutcomeUnrestoredAttemptsItem, RebuildOutcomeUnrestoredAttemptsItemStatus, SourceCheck,
    Timestamp, TitleSource,
};
use crate::error::AppResult;
use crate::store::{ResolvedMetadata, Restoration, Store};

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Why a URL served no bytes; its text is the detail a dead source check records.
pub enum Dead {
    BadUrl(url::ParseError),
    NotLocal,
    NoSuchFile,
    Unreadable(std::io::Error),
    Unreachable(reqwest::Error),
    Status(u16),
}

impl fmt::Display for Dead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUrl(error) => write!(formatter, "{error}"),
            Self::NotLocal => formatter.write_str("names no local file"),
            Self::NoSuchFile => formatter.write_str("no such file"),
            Self::Unreadable(error) => write!(formatter, "{error}"),
            Self::Unreachable(error) => write!(formatter, "{error}"),
            Self::Status(status) => write!(formatter, "HTTP {status}"),
        }
    }
}

/// The one boundary where a network failure becomes a dead-URL outcome. A `file:` URL (a PDF
/// added from a folder) is read from disk.
pub async fn download(url: &str, timeout: Duration) -> Result<Vec<u8>, Dead> {
    let parsed = Url::parse(url).map_err(Dead::BadUrl)?;
    if parsed.scheme() == "file" {
        let path = parsed.to_file_path().map_err(|()| Dead::NotLocal)?;
        return match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Dead::NoSuchFile),
            Err(error) => Err(Dead::Unreadable(error)),
        };
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(Dead::Unreachable)?;
    let response = client.get(parsed).send().await.map_err(Dead::Unreachable)?;
    if !response.status().is_success() {
        return Err(Dead::Status(response.status().as_u16()));
    }
    let body = response.bytes().await.map_err(Dead::Unreachable)?;
    Ok(body.to_vec())
}

enum Fetched {
    Accessible(Vec<u8>),
    Changed(String),
    Dead(String),
}

async fn fetch_original(url: &str, original_sha256: &str, settings: &AppConfigRebuild) -> Fetched {
    let timeout = Duration::from_secs(settings.download_timeout_seconds.get());
    match download(url, timeout).await {
        Err(failure) => Fetched::Dead(failure.to_string()),
        Ok(bytes) => {
            let observed = sha256(&bytes);
            if observed == original_sha256 {
                Fetched::Accessible(bytes)
            } else {
                Fetched::Changed(format!("serves bytes hashing to {observed}"))
            }
        }
    }
}

pub async fn check_source(
    url: &str,
    original_sha256: &str,
    settings: &AppConfigRebuild,
) -> SourceCheck {
    let fetched = fetch_original(url, original_sha256, settings).await;
    let checked_at = Timestamp::now();
    match fetched {
        Fetched::Accessible(_) => SourceCheck::Accessible {
            checked_at,
            detail: "serves the captured bytes".to_string(),
        },
        Fetched::Changed(detail) => SourceCheck::Changed { checked_at, detail },
        Fetched::Dead(detail) => SourceCheck::Dead { checked_at, detail },
    }
}

/// An item the store may have lost, as the index export records it.
pub struct RecoverableItem {
    pub key: String,
    pub provenance: Provenance,
    pub title: String,
    pub title_source: TitleSource,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub abstract_: Option<String>,
    pub mirrors: Vec<String>,
}

// Writes the fetched original back under the item's key and records metadata added after capture.
async fn restore(
    store: &Store,
    item: &RecoverableItem,
    key: NonEmpty,
    from: &str,
    bytes: &[u8],
) -> AppResult<RebuildOutcome> {
    let stored_sha256 = match store.restore(&item.key, bytes, &item.provenance).await? {
        Restoration::Present => return Ok(RebuildOutcome::Present { key }),
        Restoration::Restored { stored_sha256 } => stored_sha256,
    };
    let metadata = if matches!(
        item.title_source,
        TitleSource::Resolver | TitleSource::Guess
    ) {
        let recorded = ResolvedMetadata {
            title: item.title.clone(),
            authors: item.authors.clone(),
            year: item.year,
            abstract_: item.abstract_.clone(),
        };
        match store
            .record_metadata(&item.key, item.title_source, &recorded)
            .await
        {
            Ok(_stored) => RebuildOutcomeRestoredMetadata::Recorded,
            Err(error) => RebuildOutcomeRestoredMetadata::Failed(nonempty(error.to_string())),
        }
    } else {
        RebuildOutcomeRestoredMetadata::FromPdf
    };
    Ok(RebuildOutcome::Restored {
        key,
        from: from.to_string(),
        stored_sha256: stored_sha256
            .try_into()
            .expect("a SHA-256 digest is 64 hex digits"),
        metadata,
    })
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("an error names what failed")
}

/// Restores the item's PDF from its PDF URL, else from each mirror in turn, when the store has
/// lost it. Recorded metadata is added again; metadata read from the original stays as it is.
pub async fn rebuild_item(
    store: &Store,
    item: &RecoverableItem,
    settings: &AppConfigRebuild,
) -> RebuildOutcome {
    let key: NonEmpty = nonempty(item.key.clone());
    match store.pdf_path(&item.key) {
        Ok(Some(_)) => return RebuildOutcome::Present { key },
        Ok(None) => {}
        Err(error) => {
            return RebuildOutcome::Failed {
                key,
                message: nonempty(error.to_string()),
            }
        }
    }
    let mut attempts = Vec::new();
    let urls = std::iter::once(&item.provenance.pdf_url).chain(&item.mirrors);
    for url in urls {
        let fetched = fetch_original(url, &item.provenance.original_sha256, settings).await;
        let (status, detail) = match fetched {
            Fetched::Accessible(bytes) => {
                return match restore(store, item, key.clone(), url, &bytes).await {
                    Ok(outcome) => outcome,
                    Err(error) => RebuildOutcome::Failed {
                        key,
                        message: nonempty(error.to_string()),
                    },
                };
            }
            Fetched::Changed(detail) => {
                (RebuildOutcomeUnrestoredAttemptsItemStatus::Changed, detail)
            }
            Fetched::Dead(detail) => (RebuildOutcomeUnrestoredAttemptsItemStatus::Dead, detail),
        };
        attempts.push(RebuildOutcomeUnrestoredAttemptsItem {
            url: url.clone(),
            status,
            detail,
        });
    }
    RebuildOutcome::Unrestored { key, attempts }
}
