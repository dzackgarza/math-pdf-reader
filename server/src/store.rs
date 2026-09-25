//! The store: the stored PDFs under the root (layout.rs) and every write to them. The server
//! chooses each path, writes each file as a unique temporary file that is synced and renamed
//! into place, moves what it removes to the desktop trash, and serializes writes: a new PDF
//! takes its key under one store-wide lock, and every change to a stored key holds that key's
//! lock. The pikepdf work (embedding provenance and metadata, reading a PDF) runs in the Python
//! commands (python.rs) on bytes and paths the store hands them.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use tempfile::NamedTempFile;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::config::BucketConfig;
use crate::contract::{
    ApiErrorErrorKind, IdentifierList, Provenance, StoredItem, Timestamp, TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::index::{CachedRead, FileRead, Signature};
use crate::layout::{self, candidate_keys, is_pdf, Key};
use crate::python::{PdfFailure, Python};
use crate::sources::sha256;

/// A PDF offered for storage and where it came from. `filename` is the name the PDF was
/// offered under, if any; `source_url` the page that linked to it, if known.
pub struct Upload {
    pub bytes: Vec<u8>,
    pub filename: Option<String>,
    pub pdf_url: String,
    pub source_url: Option<String>,
    pub title_hint: String,
}

/// What a resolver gives an item: title, authors in order, year and abstract where known.
pub struct ResolvedMetadata {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub abstract_: Option<String>,
}

/// A capture's result: the stored item, the SHA-256 of the file as stored, and whether the same
/// original bytes were already stored.
pub struct Captured {
    pub item: StoredItem,
    pub stored_sha256: String,
    pub existing: bool,
}

/// A reader save's result.
pub enum Replacement {
    Replaced,
    /// The stored file no longer holds the bytes the save was made from.
    Stale {
        stored_sha256: String,
    },
    /// The bytes do not carry the provenance embedded in the stored file.
    ProvenanceMismatch,
}

/// A restore's result: the PDF written back, or one already stored under the key.
pub enum Restoration {
    Restored { stored_sha256: String },
    Present,
}

/// A stored file as opened, with the SHA-256 of what it holds: the entity tag of its URL.
pub struct OpenedPdf {
    pub file: tokio::fs::File,
    pub sha256: String,
}

pub(crate) struct Inner {
    pub(crate) root: PathBuf,
    pub(crate) python: Python,
    /// What each `<key>.pdf` file said about itself when last read, by file name. Held for a
    /// whole refresh, so concurrent requests never read the same PDF twice.
    pub(crate) reads: Mutex<HashMap<String, CachedRead>>,
    /// Held while a new PDF takes its key, so two PDFs never take one key.
    placing: Mutex<()>,
    keys: std::sync::Mutex<HashMap<Key, Arc<Mutex<()>>>>,
    hashes: std::sync::Mutex<HashMap<Key, (Signature, String)>>,
}

#[derive(Clone)]
pub struct Store {
    pub(crate) inner: Arc<Inner>,
}

// Where a new file goes: onto a free path only, or over the file there.
#[derive(Clone, Copy)]
enum Placement {
    New,
    Over,
}

/// BYTES written to a unique temporary file in DIRECTORY and synced to disk.
fn staged(directory: &Path, bytes: &[u8]) -> std::io::Result<NamedTempFile> {
    let mut file = tempfile::Builder::new()
        .prefix(".")
        .suffix(".partial")
        .tempfile_in(directory)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    Ok(file)
}

/// Renames a staged file to PATH and syncs the directory, so the new name survives a crash.
fn commit(staged: NamedTempFile, path: &Path, placement: Placement) -> std::io::Result<()> {
    match placement {
        Placement::New => staged.persist_noclobber(path),
        Placement::Over => staged.persist(path),
    }
    .map_err(|failed| failed.error)?;
    let directory = path.parent().expect("a written file lies in a directory");
    std::fs::File::open(directory)?.sync_all()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(AppError::internal)?
        .map_err(AppError::store_failed)
}

/// Moves PATHS to the desktop trash, in order.
async fn trash_all(paths: Vec<PathBuf>) -> AppResult<()> {
    tokio::task::spawn_blocking(move || trash::delete_all(paths))
        .await
        .map_err(AppError::internal)?
        .map_err(|error| AppError::store_failed(format!("cannot move to the trash: {error}")))
}

fn not_a_pdf(message: &str) -> AppError {
    AppError::api(StatusCode::BAD_REQUEST, ApiErrorErrorKind::NotAPdf, message)
}

fn provenance_args(provenance: &Provenance) -> Vec<String> {
    let mut args = vec![
        "embed-provenance".to_string(),
        format!("--pdf-url={}", provenance.pdf_url),
        format!("--captured-at={}", provenance.captured_at),
        format!("--original-sha256={}", *provenance.original_sha256),
        format!("--title-hint={}", *provenance.title_hint),
    ];
    if let Some(source_url) = &provenance.source_url {
        args.push(format!("--source-url={source_url}"));
    }
    args
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .expect("a stored path names a file")
        .to_string_lossy()
        .into_owned()
}

impl Store {
    pub fn new(root: PathBuf, python: Python) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                python,
                reads: Mutex::new(HashMap::new()),
                placing: Mutex::new(()),
                keys: std::sync::Mutex::new(HashMap::new()),
                hashes: std::sync::Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The store over a bucket's root, running the bucket's Python environment.
    pub fn configured(config: &BucketConfig) -> Self {
        let timeout = Duration::from_secs(config.app.store.command_timeout_seconds.get());
        Self::new(
            config.root.clone(),
            Python::new(
                config.python_bin.clone(),
                config.process_env.clone(),
                timeout,
            ),
        )
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn python(&self) -> &Python {
        &self.inner.python
    }

    /// The stored PDF for a key, or `None` when the text is no key or names no stored PDF.
    pub fn pdf_path(&self, key: &str) -> Option<PathBuf> {
        let key = Key::parse(key)?;
        let path = layout::pdf_path(self.root(), &key);
        path.is_file().then_some(path)
    }

    fn existing_key(&self, key: &str) -> AppResult<Key> {
        match Key::parse(key) {
            Some(parsed) if layout::pdf_path(self.root(), &parsed).is_file() => Ok(parsed),
            _ => Err(AppError::unknown_item(key)),
        }
    }

    /// Held for every change to KEY's files.
    async fn lock(&self, key: &Key) -> OwnedMutexGuard<()> {
        let lock = Arc::clone(
            self.inner
                .keys
                .lock()
                .expect("the key locks are never poisoned")
                .entry(key.clone())
                .or_default(),
        );
        lock.lock_owned().await
    }

    async fn embedded(&self, bytes: &[u8], provenance: &Provenance) -> Result<Vec<u8>, PdfFailure> {
        self.inner
            .python
            .run(&provenance_args(provenance), Some(bytes))
            .await
    }

    /// The stored item whose PDF was captured from these original bytes, if any.
    async fn holding(&self, original_sha256: &str) -> AppResult<Option<StoredItem>> {
        Ok(self
            .items()
            .await?
            .into_iter()
            .map(|indexed| indexed.stored)
            .find(|stored| *stored.provenance.original_sha256 == original_sha256))
    }

    async fn already(&self, item: StoredItem) -> AppResult<Captured> {
        let key = Key::parse(&item.key).expect("an indexed key is a key");
        let stored_sha256 = sha256(&tokio::fs::read(layout::pdf_path(self.root(), &key)).await?);
        Ok(Captured {
            item,
            stored_sha256,
            existing: true,
        })
    }

    async fn require_stored(&self, key: &Key) -> AppResult<StoredItem> {
        match self.item(key.as_str()).await? {
            Some(indexed) => Ok(indexed.stored),
            None => Err(AppError::store_failed(format!(
                "{key}.pdf is not readable after it was written"
            ))),
        }
    }

    /// Stores an upload with its provenance embedded, under the first free key its file name
    /// gives. The same original bytes already stored under any key are that item, whatever URL
    /// they came from.
    pub async fn capture(&self, upload: &Upload) -> AppResult<Captured> {
        if !is_pdf(&upload.bytes) {
            return Err(not_a_pdf(
                "the bytes carry no %PDF- header in their first 1024 bytes",
            ));
        }
        let original_sha256 = sha256(&upload.bytes);
        if let Some(item) = self.holding(&original_sha256).await? {
            return self.already(item).await;
        }
        let provenance = Provenance {
            pdf_url: upload.pdf_url.clone(),
            source_url: upload.source_url.clone(),
            captured_at: Timestamp::now(),
            original_sha256: original_sha256
                .clone()
                .try_into()
                .expect("a SHA-256 digest is 64 hex digits"),
            title_hint: upload
                .title_hint
                .clone()
                .try_into()
                .map_err(|_empty| AppError::invalid("the title hint is empty"))?,
        };
        let embedded = self.embedded(&upload.bytes, &provenance).await?;
        let stored_sha256 = sha256(&embedded);

        let _placing = self.inner.placing.lock().await;
        if let Some(item) = self.holding(&original_sha256).await? {
            return self.already(item).await;
        }
        for key in candidate_keys(upload.filename.as_deref(), &original_sha256) {
            let path = layout::pdf_path(self.root(), &key);
            if path.exists() {
                continue;
            }
            let (bytes, root) = (embedded.clone(), self.root().to_path_buf());
            blocking(move || commit(staged(&root, &bytes)?, &path, Placement::New)).await?;
            return Ok(Captured {
                item: self.require_stored(&key).await?,
                stored_sha256,
                existing: false,
            });
        }
        Err(AppError::store_failed(format!(
            "every key {:?} gives holds a different PDF",
            upload.filename
        )))
    }

    /// Opens KEY's stored PDF with the SHA-256 of what the opened file holds, cached per file
    /// so that PDF.js's range requests do not hash the file again.
    pub async fn open(&self, key: &str) -> AppResult<Option<OpenedPdf>> {
        let Some(key) = Key::parse(key) else {
            return Ok(None);
        };
        let mut file = match tokio::fs::File::open(layout::pdf_path(self.root(), &key)).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let signature = Signature::of(&file.metadata().await?);
        let cached = self
            .inner
            .hashes
            .lock()
            .expect("the hash cache is never poisoned")
            .get(&key)
            .filter(|(seen, _)| *seen == signature)
            .map(|(_, sha)| sha.clone());
        let sha256 = match cached {
            Some(sha) => sha,
            None => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).await?;
                file.rewind().await?;
                let sha = sha256(&bytes);
                self.inner
                    .hashes
                    .lock()
                    .expect("the hash cache is never poisoned")
                    .insert(key, (signature, sha.clone()));
                sha
            }
        };
        Ok(Some(OpenedPdf { file, sha256 }))
    }

    /// Replaces KEY's stored PDF with BYTES (the reader's save, annotations included) when the
    /// stored file still hashes to BASE_SHA256, the bytes the save was made from, and the new
    /// bytes carry the provenance embedded in it.
    pub async fn replace(
        &self,
        key: &str,
        bytes: Vec<u8>,
        base_sha256: &str,
    ) -> AppResult<Replacement> {
        if !is_pdf(&bytes) {
            return Err(not_a_pdf("the request body is not a PDF"));
        }
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let path = layout::pdf_path(self.root(), &key);
        let stored_sha256 = sha256(&tokio::fs::read(&path).await?);
        if stored_sha256 != base_sha256 {
            return Ok(Replacement::Stale { stored_sha256 });
        }
        let stored = self.require_stored(&key).await?;
        let root = self.root().to_path_buf();
        let staged = blocking(move || staged(&root, &bytes)).await?;
        let offered = self
            .read_records(&[staged.path().to_path_buf()])
            .await?
            .pop()
            .expect("one path read gives one outcome");
        let carried = match offered {
            FileRead::Read(record) => record.provenance,
            FileRead::Unreadable(message) => {
                return Err(AppError::api(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    ApiErrorErrorKind::UnreadablePdf,
                    message,
                ))
            }
        };
        if serde_json::to_value(&carried)? != serde_json::to_value(&stored.provenance)? {
            return Ok(Replacement::ProvenanceMismatch);
        }
        blocking(move || commit(staged, &path, Placement::Over)).await?;
        Ok(Replacement::Replaced)
    }

    /// Records METADATA, its title from SOURCE, inside KEY's stored PDF.
    pub async fn record_metadata(
        &self,
        key: &str,
        source: TitleSource,
        metadata: &ResolvedMetadata,
    ) -> AppResult<StoredItem> {
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let path = layout::pdf_path(self.root(), &key);
        let mut args = vec!["embed-metadata".to_string()];
        args.extend(
            metadata
                .authors
                .iter()
                .map(|author| format!("--author={author}")),
        );
        if let Some(year) = metadata.year {
            args.push(format!("--year={year}"));
        }
        if let Some(abstract_) = &metadata.abstract_ {
            args.push(format!("--abstract={abstract_}"));
        }
        args.extend([
            "--".to_string(),
            path.to_string_lossy().into_owned(),
            metadata.title.clone(),
            source.to_string(),
        ]);
        let bytes = self.inner.python.run(&args, None).await?;
        let root = self.root().to_path_buf();
        blocking(move || commit(staged(&root, &bytes)?, &path, Placement::Over)).await?;
        self.require_stored(&key).await
    }

    /// Stores bytes re-downloaded for a lost PDF under KEY with the provenance recorded at
    /// capture. The bytes must be the recorded original; a PDF already under KEY is left alone.
    pub async fn restore(
        &self,
        key: &str,
        bytes: &[u8],
        provenance: &Provenance,
    ) -> AppResult<Restoration> {
        let parsed = Key::parse(key).ok_or_else(|| {
            AppError::store_failed(format!(
                "the index export lists {key:?}, which is no store key"
            ))
        })?;
        let observed = sha256(bytes);
        if observed != *provenance.original_sha256 {
            return Err(AppError::internal(format!(
                "{key}: the bytes hash to {observed}, not the recorded original {}",
                *provenance.original_sha256
            )));
        }
        let embedded = self.embedded(bytes, provenance).await?;
        let stored_sha256 = sha256(&embedded);
        let _placing = self.inner.placing.lock().await;
        let path = layout::pdf_path(self.root(), &parsed);
        if path.exists() {
            return Ok(Restoration::Present);
        }
        let root = self.root().to_path_buf();
        blocking(move || commit(staged(&root, &embedded)?, &path, Placement::New)).await?;
        Ok(Restoration::Restored { stored_sha256 })
    }

    /// Moves KEY's extraction and then its PDF to the desktop trash; answers the names moved.
    pub async fn remove(&self, key: &str) -> AppResult<Vec<String>> {
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let root = self.root();
        let paths: Vec<PathBuf> = [
            layout::markdown_path(root, &key),
            layout::extraction_dir(root, &key),
            layout::pdf_path(root, &key),
        ]
        .into_iter()
        .filter(|path| path.exists())
        .collect();
        let names = paths.iter().map(|path| file_name(path)).collect();
        trash_all(paths).await?;
        Ok(names)
    }

    /// Places a finished extraction beside KEY's PDF: the previous `<key>.md` and
    /// `<key>.extraction/` go to the desktop trash, then ARTIFACTS (if any) becomes
    /// `<key>.extraction/` and MARKDOWN becomes `<key>.md`, last, since the Markdown marks a
    /// complete extraction. Both lie in the root, so each move is a rename.
    pub async fn place_extraction(
        &self,
        key: &str,
        markdown: PathBuf,
        artifacts: Option<PathBuf>,
    ) -> AppResult<()> {
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let root = self.root().to_path_buf();
        let markdown_path = layout::markdown_path(&root, &key);
        let extraction_dir = layout::extraction_dir(&root, &key);
        let previous: Vec<PathBuf> = [&markdown_path, &extraction_dir]
            .into_iter()
            .filter(|path| path.exists())
            .cloned()
            .collect();
        if !previous.is_empty() {
            trash_all(previous).await?;
        }
        blocking(move || {
            if let Some(artifacts) = artifacts {
                std::fs::rename(artifacts, &extraction_dir)?;
            }
            std::fs::rename(markdown, &markdown_path)?;
            std::fs::File::open(&root)?.sync_all()
        })
        .await
    }

    /// KEY's first page WIDTH pixels wide, as a PNG.
    pub async fn thumbnail(&self, key: &str, width: u32) -> AppResult<Vec<u8>> {
        let key = self.existing_key(key)?;
        let args = [
            "thumbnail".to_string(),
            "--".to_string(),
            layout::pdf_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
            width.to_string(),
        ];
        Ok(self.inner.python.run(&args, None).await?)
    }

    /// The identifiers the publisher embedded in KEY's PDF.
    pub async fn embedded_identifiers(&self, key: &str) -> AppResult<Vec<String>> {
        let key = self.existing_key(key)?;
        let args = [
            "identifiers".to_string(),
            "--".to_string(),
            layout::pdf_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
        ];
        let listed: IdentifierList = self.inner.python.json(&args).await?;
        Ok(listed
            .0
            .into_iter()
            .map(|identifier| identifier.to_string())
            .collect())
    }
}

/// Writes BYTES to PATH, a file outside the root (a cache), as a synced temporary file renamed
/// into place.
pub async fn write_file(path: PathBuf, bytes: Vec<u8>) -> AppResult<()> {
    blocking(move || {
        let directory = path.parent().expect("a written file lies in a directory");
        std::fs::create_dir_all(directory)?;
        commit(staged(directory, &bytes)?, &path, Placement::Over)
    })
    .await
}
