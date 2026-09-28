//! Where a stored PDF came from, checked again: whether its PDF URL and mirrors still serve the
//! captured bytes (the recorded original SHA-256), and rebuilding a PDF the store has lost from
//! the first of those URLs that does.
use std::fmt;
use std::time::Duration;

use axum::body::Bytes;
use futures::stream::BoxStream;
use futures::{Stream, StreamExt, TryStreamExt};
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;
use url::Url;

use crate::contract::{
    AppConfigRebuild, NonEmpty, Provenance, RebuildOutcome, RebuildOutcomeRestoredMetadata,
    RebuildOutcomeUnrestoredAttemptsItem, RebuildOutcomeUnrestoredAttemptsItemStatus, SourceCheck,
    Timestamp, TitleSource,
};
use crate::error::AppResult;
use crate::store::{stage, ResolvedMetadata, Restoration, StageFailure, Staged, Store};

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

/// The SHA-256 of a body read chunk by chunk.
pub async fn digest<E>(chunks: impl Stream<Item = Result<Bytes, E>>) -> Result<String, E> {
    let mut hasher = Sha256::new();
    let mut chunks = std::pin::pin!(chunks);
    while let Some(chunk) = chunks.next().await {
        hasher.update(&chunk?[..]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A downloaded body as it arrives.
type Body = BoxStream<'static, Result<Bytes, Dead>>;

/// The one boundary where a network failure becomes a dead-URL outcome. A `file:` URL (a PDF
/// added from a folder) is read from disk. The body is read by the caller as it arrives, within
/// SETTINGS' download time limit.
async fn download(url: &str, settings: &AppConfigRebuild) -> Result<Body, Dead> {
    let parsed = Url::parse(url).map_err(Dead::BadUrl)?;
    if parsed.scheme() == "file" {
        let path = parsed.to_file_path().map_err(|()| Dead::NotLocal)?;
        return match tokio::fs::File::open(&path).await {
            Ok(file) => Ok(ReaderStream::new(file).map_err(Dead::Unreadable).boxed()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Dead::NoSuchFile),
            Err(error) => Err(Dead::Unreadable(error)),
        };
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.download_timeout_seconds.get()))
        .build()
        .map_err(Dead::Unreachable)?;
    let response = client.get(parsed).send().await.map_err(Dead::Unreachable)?;
    if !response.status().is_success() {
        return Err(Dead::Status(response.status().as_u16()));
    }
    Ok(response.bytes_stream().map_err(Dead::Unreachable).boxed())
}

fn changed(observed: &str) -> String {
    format!("serves bytes hashing to {observed}")
}

/// Whether URL still serves the bytes hashing to ORIGINAL_SHA256; the body is hashed as it
/// arrives and kept nowhere.
pub async fn check_source(
    url: &str,
    original_sha256: &str,
    settings: &AppConfigRebuild,
) -> SourceCheck {
    let observed = match download(url, settings).await {
        Ok(body) => digest(body).await,
        Err(failure) => Err(failure),
    };
    let checked_at = Timestamp::now();
    match observed {
        Ok(observed) if observed == original_sha256 => SourceCheck::Accessible {
            checked_at,
            detail: "serves the captured bytes".to_string(),
        },
        Ok(observed) => SourceCheck::Changed {
            checked_at,
            detail: changed(&observed),
        },
        Err(failure) => SourceCheck::Dead {
            checked_at,
            detail: failure.to_string(),
        },
    }
}

enum Fetched {
    Accessible(Staged),
    Changed(String),
    Dead(String),
}

/// URL's body staged in the store's root when it is the recorded original; a disk failure while
/// staging is the error.
async fn fetch_original(
    store: &Store,
    url: &str,
    original_sha256: &str,
    settings: &AppConfigRebuild,
) -> std::io::Result<Fetched> {
    let body = match download(url, settings).await {
        Ok(body) => body,
        Err(failure) => return Ok(Fetched::Dead(failure.to_string())),
    };
    match stage(store.root(), body).await {
        Ok(staged) if staged.sha256 == original_sha256 => Ok(Fetched::Accessible(staged)),
        Ok(staged) => Ok(Fetched::Changed(changed(&staged.sha256))),
        Err(StageFailure::Read(failure)) => Ok(Fetched::Dead(failure.to_string())),
        Err(StageFailure::Write(error)) => Err(error),
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
    pdf: &Staged,
) -> AppResult<RebuildOutcome> {
    let stored_sha256 = match store.restore(&item.key, pdf, &item.provenance).await? {
        Restoration::Present => return Ok(RebuildOutcome::Present { key }),
        Restoration::Restored { stored_sha256 } => stored_sha256,
    };
    let metadata = if matches!(
        item.title_source,
        TitleSource::Manual | TitleSource::Resolver | TitleSource::Guess
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
        let fetched =
            match fetch_original(store, url, &item.provenance.original_sha256, settings).await {
                Ok(fetched) => fetched,
                Err(error) => {
                    return RebuildOutcome::Failed {
                        key,
                        message: nonempty(format!("cannot stage {url}: {error}")),
                    }
                }
            };
        let (status, detail) = match fetched {
            Fetched::Accessible(pdf) => {
                return match restore(store, item, key.clone(), url, &pdf).await {
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
