//! The store: the stored PDFs under the root (layout.rs) and every write to them. The server
//! chooses each path, writes each file as a unique temporary file that is synced and renamed
//! into place, moves what it removes to the desktop trash, and serializes writes: a new PDF
//! takes its key under one store-wide lock, and every change to a stored key holds that key's
//! lock. The pikepdf work (embedding provenance and metadata, reading a PDF) runs in the Python
//! commands (python.rs) on files the store names. A body from outside (a capture, a download)
//! is streamed to a staged file in the root while it is hashed, so no body is held in memory.
//!
//! A reader saves the bytes it opened with its annotations added. When the store wrote only
//! metadata into the PDF after the reader opened it, the save is taken and the metadata is
//! written into it again, as a rebase replays a commit onto the branch it missed.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::StatusCode;
use clearurls::UrlCleaner;
use futures::{Stream, StreamExt};
use nix::fcntl::{renameat2, RenameFlags};
use sha2::{Digest, Sha256};
use tempfile::{NamedTempFile, TempPath};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::io::ReaderStream;

use crate::config::{BucketConfig, PAGE_OUT_OF_RANGE_EXIT, PDF_HEADER_WINDOW};
use crate::contract::{
    ApiErrorErrorKind, NonEmpty, Provenance, SourceLineage, StoredItem, Timestamp, TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::index::{stored_item, CachedRead, FileRead, Signature};
use crate::layout::{self, candidate_keys, is_pdf, Key};
use crate::python::{PdfFailure, Python};
use crate::sources::{digest, sha256};

/// The ClearURLs rule set, which names the tracking parameters a link carries (`utm_source` and
/// the like) that do not locate the PDF.
static URL_CLEANER: LazyLock<UrlCleaner> =
    LazyLock::new(|| UrlCleaner::from_embedded_rules().expect("the embedded rules parse"));

/// A PDF offered for storage and where it came from. `filename` is the name the PDF was
/// offered under, if any.
pub struct Upload {
    pub pdf: Staged,
    pub filename: Option<String>,
    pub pdf_url: String,
    pub title_hint: String,
}

/// What Retrieve metadata gives an item: title, authors in order, year and abstract where known.
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
    metadata_writes: std::sync::Mutex<HashMap<Key, MetadataWrites>>,
}

/// A stored file that differs from each of BASES only by the metadata the store wrote into it.
struct MetadataWrites {
    stored_sha256: String,
    bases: HashSet<String>,
}

impl From<&StoredItem> for ResolvedMetadata {
    fn from(item: &StoredItem) -> Self {
        Self {
            title: item.title.text.to_string(),
            authors: item
                .authors
                .iter()
                .map(|author| author.to_string())
                .collect(),
            year: item.year,
            abstract_: item.abstract_.as_ref().map(|text| text.to_string()),
        }
    }
}

/// The Python command that prints the PDF at PATH with METADATA, its title from SOURCE.
fn metadata_args(path: &Path, source: TitleSource, metadata: &ResolvedMetadata) -> Vec<String> {
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
    args
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

/// A new, empty, unique temporary file in DIRECTORY, removed when dropped.
fn temporary(directory: &Path) -> std::io::Result<NamedTempFile> {
    tempfile::Builder::new()
        .prefix(".")
        .suffix(".partial")
        .tempfile_in(directory)
}

#[cfg(feature = "arxiv-fixtures")]
pub(crate) fn test_gate(variable: &str) -> std::io::Result<()> {
    let Some(base) = std::env::var_os(variable) else {
        return Ok(());
    };
    let base = PathBuf::from(base);
    std::fs::write(base.with_extension("ready"), b"ready")?;
    let release = base.with_extension("release");
    let start = std::time::Instant::now();
    while !release.try_exists()? {
        if start.elapsed() > Duration::from_secs(30) {
            return Err(std::io::Error::other(format!("{variable} timed out")));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

/// BYTES written to a unique temporary file in DIRECTORY and synced to disk.
fn staged(directory: &Path, bytes: &[u8]) -> std::io::Result<TempPath> {
    let mut file = temporary(directory)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    Ok(file.into_temp_path())
}

/// The first bytes of a body that `layout::is_pdf` looks at.
const HEAD: usize = PDF_HEADER_WINDOW + b"%PDF-".len();

/// A body streamed to a unique temporary file and synced, with its SHA-256 and its first
/// bytes. The file is removed when this is dropped.
pub struct Staged {
    path: TempPath,
    pub sha256: String,
    head: Vec<u8>,
}

impl Staged {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the body is a PDF: `%PDF-` starts within its first 1024 bytes.
    pub fn is_pdf(&self) -> bool {
        is_pdf(&self.head)
    }
}

/// Why a body was not staged: its source failed, or the disk did.
pub enum StageFailure<E> {
    Read(E),
    Write(std::io::Error),
}

/// Streams CHUNKS to a unique temporary file in DIRECTORY, hashing them as they are written.
pub async fn stage<E>(
    directory: &Path,
    chunks: impl Stream<Item = Result<Bytes, E>>,
) -> Result<Staged, StageFailure<E>> {
    let (file, path) = temporary(directory)
        .map_err(StageFailure::Write)?
        .into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let (mut hasher, mut head) = (Sha256::new(), Vec::with_capacity(HEAD));
    let mut chunks = std::pin::pin!(chunks);
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(StageFailure::Read)?;
        hasher.update(&chunk[..]);
        let wanted = HEAD.saturating_sub(head.len()).min(chunk.len());
        head.extend_from_slice(&chunk[..wanted]);
        file.write_all(&chunk).await.map_err(StageFailure::Write)?;
    }
    file.sync_all().await.map_err(StageFailure::Write)?;
    Ok(Staged {
        path,
        sha256: hex::encode(hasher.finalize()),
        head,
    })
}

/// The file at PATH, outside the root, staged into DIRECTORY.
pub async fn stage_file(
    directory: &Path,
    path: &Path,
) -> Result<Staged, StageFailure<std::io::Error>> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(StageFailure::Read)?;
    stage(directory, ReaderStream::new(file)).await
}

/// Renames a staged file to PATH and syncs the directory, so the new name survives a crash.
fn commit(staged: TempPath, path: &Path, placement: Placement) -> std::io::Result<()> {
    let directory = path.parent().expect("a written file lies in a directory");
    std::fs::create_dir_all(directory)?;
    match placement {
        Placement::New => staged.persist_noclobber(path),
        Placement::Over => staged.persist(path),
    }
    .map_err(|failed| failed.error)?;
    std::fs::File::open(directory)?.sync_all()
}

pub async fn blocking<T: Send + 'static>(
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

fn remove_empty_directory(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn not_a_pdf(message: &str) -> AppError {
    AppError::api(StatusCode::BAD_REQUEST, ApiErrorErrorKind::NotAPdf, message)
}

fn provenance_args(provenance: &Provenance) -> Vec<String> {
    vec![
        "embed-provenance".to_string(),
        format!("--pdf-url={}", provenance.pdf_url),
        format!("--captured-at={}", provenance.captured_at),
        format!("--original-sha256={}", *provenance.original_sha256),
        format!("--title-hint={}", *provenance.title_hint),
    ]
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
                metadata_writes: std::sync::Mutex::new(HashMap::new()),
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

    /// The number of annotations a reader made in the PDF at PATH, any PDF, stored or not.
    pub async fn annotations(&self, path: &Path) -> AppResult<u64> {
        let args = [
            "annotations".to_string(),
            "--".to_string(),
            path.to_string_lossy().into_owned(),
        ];
        Ok(self.python().json(&args).await?)
    }

    /// The stored PDF for a key, or `None` when the text is no key or names no stored PDF. Only
    /// the operating system's answer that no file is there (ENOENT, ENOTDIR from stat(2), or a
    /// stat of something else) is `None`; any other error is a failure of the check.
    pub fn pdf_path(&self, key: &str) -> AppResult<Option<PathBuf>> {
        Ok(self
            .stored_key(key)?
            .map(|key| layout::pdf_path(self.root(), &key)))
    }

    fn stored_key(&self, key: &str) -> AppResult<Option<Key>> {
        let Some(key) = Key::parse(key) else {
            return Ok(None);
        };
        let path = layout::pdf_path(self.root(), &key);
        match std::fs::metadata(&path) {
            Ok(metadata) => Ok(metadata.is_file().then_some(key)),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                Ok(None)
            }
            Err(error) => Err(AppError::store_failed(format!(
                "cannot check the stored PDF {}: stat: {error}",
                path.display()
            ))),
        }
    }

    fn existing_key(&self, key: &str) -> AppResult<Key> {
        self.stored_key(key)?
            .ok_or_else(|| AppError::unknown_item(key))
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

    /// SOURCE with PROVENANCE embedded, written by the Python command to a staged file in the
    /// root, with the SHA-256 of what it wrote.
    async fn embedded(
        &self,
        source: &Path,
        provenance: &Provenance,
    ) -> AppResult<(TempPath, String)> {
        let output = temporary(self.root())
            .map_err(AppError::store_failed)?
            .into_temp_path();
        let mut args = provenance_args(provenance);
        args.extend([
            "--".to_string(),
            source.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
        ]);
        self.inner.python.run(&args).await?;
        let written = tokio::fs::File::open(&output)
            .await
            .map_err(AppError::store_failed)?;
        written.sync_all().await.map_err(AppError::store_failed)?;
        let stored_sha256 = digest(ReaderStream::new(written))
            .await
            .map_err(AppError::store_failed)?;
        Ok((output, stored_sha256))
    }

    async fn embed_lineage(
        &self,
        source: &Path,
        lineage: &SourceLineage,
    ) -> AppResult<(TempPath, String)> {
        let output = temporary(self.root())?.into_temp_path();
        let args = vec![
            "embed-lineage".to_string(),
            format!("--original-key={}", lineage.original_key.as_str()),
            format!(
                "--original-provenance={}",
                serde_json::to_string(&lineage.original_provenance)?
            ),
            format!("--preferred-key={}", lineage.preferred_key.as_str()),
            format!("--discovered-source-url={}", lineage.discovered_source_url),
            format!("--promoted-at={}", lineage.promoted_at),
            "--".to_string(),
            source.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
        ];
        self.inner.python.run(&args).await?;
        #[cfg(feature = "arxiv-fixtures")]
        if std::env::var_os("PDF_BUCKET_TEST_LINEAGE_SYNC_FAILURE").is_some() {
            return Err(AppError::store_failed("injected lineage sync failure"));
        }
        let file = tokio::fs::File::open(&output).await?;
        file.sync_all().await?;
        let sha256 = digest(ReaderStream::new(file)).await?;
        Ok((output, sha256))
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
    /// gives: a key is free when no stored PDF has it and HELD, the keys the filing and the
    /// index export still list, does not contain it. The same original bytes already stored
    /// under any key are that item, whatever URL they came from. The PDF URL is recorded without
    /// its tracking parameters.
    pub async fn capture(&self, upload: &Upload, held: &BTreeSet<String>) -> AppResult<Captured> {
        if !upload.pdf.is_pdf() {
            return Err(not_a_pdf(
                "the bytes carry no %PDF- header in their first 1024 bytes",
            ));
        }
        if let Some(item) = self.holding(&upload.pdf.sha256).await? {
            return self.already(item).await;
        }
        let (embedded, stored_sha256) = self.prepare_capture(upload).await?;
        self.place_capture(upload, held, embedded, stored_sha256)
            .await
    }

    /// Stores a separate source representation even when its original bytes are already stored.
    pub async fn capture_distinct(
        &self,
        upload: &Upload,
        held: &BTreeSet<String>,
        metadata: &ResolvedMetadata,
        original_key: &NonEmpty,
        original_provenance: &Provenance,
    ) -> AppResult<(Captured, SourceLineage)> {
        let (embedded, _) = self.prepare_capture(upload).await?;
        let bytes = self
            .inner
            .python
            .run(&metadata_args(&embedded, TitleSource::Resolver, metadata))
            .await?;
        let root = self.root().to_path_buf();
        let embedded = blocking(move || staged(&root, &bytes)).await?;
        let _placing = self.inner.placing.lock().await;
        for key in candidate_keys(upload.filename.as_deref(), &upload.pdf.sha256) {
            let path = layout::pdf_path(self.root(), &key);
            if held.contains(key.as_str())
                || layout::document_dir(self.root(), &key).try_exists()?
            {
                continue;
            }
            let lineage = SourceLineage {
                original_key: original_key.clone(),
                original_provenance: original_provenance.clone(),
                preferred_key: key.as_str().try_into().expect("a store key is nonempty"),
                discovered_source_url: upload.pdf_url.clone(),
                promoted_at: Timestamp::now(),
            };
            let (output, stored_sha256) = self.embed_lineage(&embedded, &lineage).await?;
            let record = match self.read_records(&[output.to_path_buf()]).await?.pop() {
                Some(FileRead::Read(record))
                    if record.source_lineage.as_ref() == Some(&lineage) =>
                {
                    record
                }
                Some(FileRead::Read(_)) => {
                    return Err(AppError::store_failed(
                        "the staged PDF did not retain its source lineage",
                    ))
                }
                Some(FileRead::Unreadable(message)) => return Err(AppError::store_failed(message)),
                None => return Err(AppError::store_failed("the staged PDF returned no record")),
            };
            let item = stored_item(&key, *record);
            let root = self.root().to_path_buf();
            let document = layout::document_dir(&root, &key);
            let markdown = layout::markdown_path(&root, &key);
            let extraction = layout::extraction_dir(&root, &key);
            let directory = root.join(format!(
                ".promotion-{}-{}",
                hex::encode(key.as_str()),
                uuid::Uuid::new_v4()
            ));
            blocking(move || {
                std::fs::create_dir(&directory)?;
                std::fs::File::open(&root)?.sync_all()?;
                #[cfg(feature = "arxiv-fixtures")]
                test_gate("PDF_BUCKET_TEST_PROMOTION_CREATED")?;
                let pending = directory.join("pending.pdf");
                let anchor = directory.join("source.pdf");
                std::fs::hard_link(&output, &pending)?;
                std::fs::File::open(&directory)?.sync_all()?;
                #[cfg(feature = "arxiv-fixtures")]
                test_gate("PDF_BUCKET_TEST_PROMOTION_PENDING")?;
                std::fs::hard_link(&output, &anchor)?;
                std::fs::File::open(&directory)?.sync_all()?;
                #[cfg(feature = "arxiv-fixtures")]
                test_gate("PDF_BUCKET_TEST_PROMOTION_BEFORE")?;
                if markdown.try_exists()? || extraction.try_exists()? {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "promotion key gained existing extraction files",
                    ));
                }
                std::fs::create_dir(&document)?;
                let source_dir = std::fs::File::open(&directory)?;
                let root_dir = std::fs::File::open(&root)?;
                renameat2(
                    &source_dir,
                    &pending,
                    &root_dir,
                    &path,
                    RenameFlags::RENAME_NOREPLACE,
                )
                .map_err(std::io::Error::from)?;
                #[cfg(feature = "arxiv-fixtures")]
                test_gate("PDF_BUCKET_TEST_PROMOTION_AFTER")?;
                std::fs::File::open(&directory)?.sync_all()?;
                std::fs::File::open(&root)?.sync_all()
            })
            .await?;
            return Ok((
                Captured {
                    item,
                    stored_sha256,
                    existing: false,
                },
                lineage,
            ));
        }
        Err(AppError::store_failed(format!(
            "every key {:?} gives is held by a different PDF, the filing or the index export",
            upload.filename
        )))
    }

    async fn prepare_capture(&self, upload: &Upload) -> AppResult<(TempPath, String)> {
        if !upload.pdf.is_pdf() {
            return Err(not_a_pdf(
                "the bytes carry no %PDF- header in their first 1024 bytes",
            ));
        }
        let original_sha256 = upload.pdf.sha256.clone();
        let pdf_url = URL_CLEANER
            .clear_single_url_str(&upload.pdf_url)
            .map_err(|error| AppError::invalid(format!("the PDF URL does not parse: {error}")))?
            .into_owned();
        let provenance = Provenance {
            pdf_url,
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
        self.embedded(upload.pdf.path(), &provenance).await
    }

    async fn place_capture(
        &self,
        upload: &Upload,
        held: &BTreeSet<String>,
        embedded: TempPath,
        stored_sha256: String,
    ) -> AppResult<Captured> {
        let original_sha256 = &upload.pdf.sha256;
        let _placing = self.inner.placing.lock().await;
        if let Some(item) = self.holding(original_sha256).await? {
            return self.already(item).await;
        }
        for key in candidate_keys(upload.filename.as_deref(), original_sha256) {
            let path = layout::pdf_path(self.root(), &key);
            if held.contains(key.as_str())
                || layout::document_dir(self.root(), &key).try_exists()?
            {
                continue;
            }
            blocking(move || commit(embedded, &path, Placement::New)).await?;
            return Ok(Captured {
                item: self.require_stored(&key).await?,
                stored_sha256,
                existing: false,
            });
        }
        Err(AppError::store_failed(format!(
            "every key {:?} gives is held by a different PDF, the filing or the index export",
            upload.filename
        )))
    }

    /// Opens KEY's stored PDF with the SHA-256 of what the opened file holds, cached per file
    /// so that range requests do not hash the file again.
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

    /// Whether KEY's file, hashing to STORED_SHA256, differs from the bytes BASE_SHA256 names
    /// only by metadata the store wrote into it.
    fn only_metadata_since(&self, key: &Key, stored_sha256: &str, base_sha256: &str) -> bool {
        self.inner
            .metadata_writes
            .lock()
            .expect("the metadata writes are never poisoned")
            .get(key)
            .is_some_and(|writes| {
                writes.stored_sha256 == stored_sha256 && writes.bases.contains(base_sha256)
            })
    }

    /// Notes that KEY's file, now hashing to STORED_SHA256, is the file BASE_SHA256 named with
    /// metadata written into it.
    fn metadata_written(&self, key: &Key, base_sha256: String, stored_sha256: String) {
        let mut writes = self
            .inner
            .metadata_writes
            .lock()
            .expect("the metadata writes are never poisoned");
        let mut bases = match writes.remove(key) {
            Some(earlier) if earlier.stored_sha256 == base_sha256 => earlier.bases,
            _ => HashSet::new(),
        };
        bases.insert(base_sha256);
        writes.insert(
            key.clone(),
            MetadataWrites {
                stored_sha256,
                bases,
            },
        );
    }

    /// Replaces KEY's stored PDF with BYTES (the reader's save, annotations included) when the
    /// new bytes carry the provenance embedded in it and the stored file hashes to BASE_SHA256,
    /// the bytes the save was made from. A stored file that differs from those bytes only by
    /// metadata the store wrote since takes the save with that metadata written into it again.
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
        let rebased = stored_sha256 != base_sha256;
        if rebased && !self.only_metadata_since(&key, &stored_sha256, base_sha256) {
            return Ok(Replacement::Stale { stored_sha256 });
        }
        let indexed = self
            .item(key.as_str())
            .await?
            .ok_or_else(|| AppError::unknown_item(key.as_str()))?;
        let lineage = indexed
            .source_lineage
            .filter(|lineage| lineage.preferred_key.as_str() == key.as_str());
        let stored = indexed.stored;
        let saved_sha256 = sha256(&bytes);
        let root = self.root().to_path_buf();
        let saved = blocking({
            let root = root.clone();
            move || staged(&root, &bytes)
        })
        .await?;
        let (placed, placed_sha256) = if rebased {
            let metadata = ResolvedMetadata::from(&stored);
            let args = metadata_args(&saved, stored.title.source, &metadata);
            let bytes = self.inner.python.run(&args).await?;
            let sha256 = sha256(&bytes);
            (blocking(move || staged(&root, &bytes)).await?, sha256)
        } else {
            (saved, saved_sha256.clone())
        };
        let offered = self
            .read_records(&[placed.to_path_buf()])
            .await?
            .pop()
            .expect("one path read gives one outcome");
        let offered = match offered {
            FileRead::Read(record) => record,
            FileRead::Unreadable(message) => {
                return Err(AppError::api(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    ApiErrorErrorKind::UnreadablePdf,
                    message,
                ))
            }
        };
        if serde_json::to_value(&offered.provenance)? != serde_json::to_value(&stored.provenance)?
            || offered
                .source_lineage
                .as_ref()
                .is_some_and(|offered| Some(offered) != lineage.as_ref())
        {
            return Ok(Replacement::ProvenanceMismatch);
        }
        let restored_lineage = lineage.is_some() && offered.source_lineage.is_none();
        let (placed, placed_sha256) =
            if let Some(lineage) = lineage.as_ref().filter(|_| restored_lineage) {
                self.embed_lineage(&placed, lineage).await?
            } else {
                (placed, placed_sha256)
            };
        blocking(move || commit(placed, &path, Placement::Over)).await?;
        if rebased || restored_lineage {
            self.metadata_written(&key, saved_sha256, placed_sha256);
        }
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
        let base_sha256 = sha256(&tokio::fs::read(&path).await?);
        let bytes = self
            .inner
            .python
            .run(&metadata_args(&path, source, metadata))
            .await?;
        let stored_sha256 = sha256(&bytes);
        let root = self.root().to_path_buf();
        blocking(move || commit(staged(&root, &bytes)?, &path, Placement::Over)).await?;
        self.metadata_written(&key, base_sha256, stored_sha256);
        self.require_stored(&key).await
    }

    /// Stores PDF, re-downloaded for a lost PDF, under KEY with the provenance recorded at
    /// capture. PDF must be the recorded original; a PDF already under KEY is left alone.
    pub async fn restore(
        &self,
        key: &str,
        pdf: &Staged,
        provenance: &Provenance,
        lineage: Option<&SourceLineage>,
    ) -> AppResult<Restoration> {
        let parsed = Key::parse(key).ok_or_else(|| {
            AppError::store_failed(format!(
                "the index export lists {key:?}, which is no store key"
            ))
        })?;
        if pdf.sha256 != *provenance.original_sha256 {
            return Err(AppError::internal(format!(
                "{key}: the bytes hash to {}, not the recorded original {}",
                pdf.sha256, *provenance.original_sha256
            )));
        }
        let (embedded, stored_sha256) = self.embedded(pdf.path(), provenance).await?;
        let (embedded, stored_sha256) = match lineage {
            Some(lineage)
                if lineage.preferred_key.as_str() == key
                    && lineage.discovered_source_url == provenance.pdf_url =>
            {
                self.embed_lineage(&embedded, lineage).await?
            }
            Some(_) => {
                return Err(AppError::store_failed(format!(
                    "{key} has inconsistent recovery lineage"
                )))
            }
            None => (embedded, stored_sha256),
        };
        let _placing = self.inner.placing.lock().await;
        let path = layout::pdf_path(self.root(), &parsed);
        if path.exists() {
            return Ok(Restoration::Present);
        }
        blocking(move || commit(embedded, &path, Placement::New)).await?;
        Ok(Restoration::Restored { stored_sha256 })
    }

    /// Moves KEY's complete document directory to the desktop trash; answers the names moved.
    pub async fn remove(&self, key: &str) -> AppResult<Vec<String>> {
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let root = self.root();
        let mut paths = vec![layout::document_dir(root, &key)];
        let names = paths.iter().map(|path| file_name(path)).collect();
        let expected = self.item(key.as_str()).await?.and_then(|item| {
            item.source_lineage
                .filter(|lineage| lineage.preferred_key.as_str() == key.as_str())
        });
        let (anchors, directories) = self
            .promotion_anchors(key.as_str(), expected.as_ref())
            .await?;
        paths.extend(anchors);
        let recovery_root = root.to_path_buf();
        blocking(move || crate::extraction_publication::recover(&recovery_root)).await?;
        trash_all(paths).await?;
        for directory in directories {
            remove_empty_directory(&directory)?;
        }
        Ok(names)
    }

    async fn promotion_anchors(
        &self,
        key: &str,
        expected: Option<&SourceLineage>,
    ) -> AppResult<(Vec<PathBuf>, Vec<PathBuf>)> {
        let root = self.root();
        let prefix = format!(".promotion-{}-", hex::encode(key));
        let mut anchors = Vec::new();
        let mut directories = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_prefix(&prefix) else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err() || !entry.file_type()?.is_dir() {
                continue;
            }
            let directory = entry.path();
            if directory.join("pending.pdf").try_exists()? {
                continue;
            }
            let anchor = directory.join("source.pdf");
            let entries: Vec<_> = std::fs::read_dir(&directory)?.collect::<Result<_, _>>()?;
            if entries.len() != 1
                || !entries[0].file_type()?.is_file()
                || entries[0].path() != anchor
            {
                return Err(AppError::store_failed(format!(
                    "{} contains unexpected files",
                    directory.display()
                )));
            }
            let read = self
                .read_records(std::slice::from_ref(&anchor))
                .await?
                .pop();
            match read {
                Some(FileRead::Read(record))
                    if record.source_lineage.as_ref() == expected && expected.is_some() => {}
                _ => {
                    return Err(AppError::store_failed(format!(
                        "{} does not belong to {key}",
                        anchor.display()
                    )))
                }
            }
            anchors.push(anchor);
            directories.push(directory);
        }
        Ok((anchors, directories))
    }

    pub async fn forget_promotion(
        &self,
        key: &str,
        expected: Option<&SourceLineage>,
    ) -> AppResult<()> {
        let (anchors, directories) = self.promotion_anchors(key, expected).await?;
        trash_all(anchors).await?;
        for directory in directories {
            remove_empty_directory(&directory)?;
        }
        Ok(())
    }

    /// Called only under the organization root lock, which excludes live promotions.
    pub(crate) async fn clean_pending_promotions(&self) -> AppResult<()> {
        let root = self.root();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = name.strip_prefix(".promotion-") else {
                continue;
            };
            let Some((encoded, transaction)) = name.split_once('-') else {
                continue;
            };
            let Ok(key_bytes) = hex::decode(encoded) else {
                continue;
            };
            let Ok(key) = String::from_utf8(key_bytes) else {
                continue;
            };
            if uuid::Uuid::parse_str(transaction).is_err()
                || Key::parse(&key).is_none()
                || !entry.file_type()?.is_dir()
            {
                continue;
            }
            let directory = entry.path();
            let entries: Vec<_> = std::fs::read_dir(&directory)?.collect::<Result<_, _>>()?;
            if entries.is_empty() {
                remove_empty_directory(&directory)?;
                std::fs::File::open(root)?.sync_all()?;
                continue;
            }
            let pending = directory.join("pending.pdf");
            let anchor = directory.join("source.pdf");
            if entries.len() > 2
                || !entries.iter().all(|file| {
                    (file.path() == pending || file.path() == anchor)
                        && file.file_type().is_ok_and(|kind| kind.is_file())
                })
                || !pending.try_exists()?
            {
                continue;
            }
            let read = self
                .read_records(std::slice::from_ref(&pending))
                .await?
                .pop();
            if !matches!(read, Some(FileRead::Read(record)) if record.source_lineage.as_ref().is_some_and(|lineage|
                lineage.preferred_key.as_str() == key && lineage.discovered_source_url == record.provenance.pdf_url))
            {
                continue;
            }
            if anchor.try_exists()? {
                let pending_metadata = std::fs::metadata(&pending)?;
                let anchor_metadata = std::fs::metadata(&anchor)?;
                if pending_metadata.dev() != anchor_metadata.dev()
                    || pending_metadata.ino() != anchor_metadata.ino()
                {
                    continue;
                }
                std::fs::remove_file(&anchor)?;
            }
            std::fs::remove_file(&pending)?;
            remove_empty_directory(&directory)?;
            std::fs::File::open(root)?.sync_all()?;
        }
        Ok(())
    }

    /// Places a finished extraction beside KEY's PDF: the previous `<key>.md` and
    /// `<key>.extraction/` go to the desktop trash, then ARTIFACTS (if any) becomes
    /// `<key>.extraction/` and MARKDOWN becomes `<key>.md`, last, since the Markdown marks a
    /// complete extraction. Staging and destination share one filesystem, so each move is a
    /// rename.
    pub async fn place_extraction(
        &self,
        key: &str,
        expected_provenance: &Provenance,
        markdown: PathBuf,
        artifacts: Option<PathBuf>,
    ) -> AppResult<()> {
        let key = self.existing_key(key)?;
        let _key = self.lock(&key).await;
        let current = self.item(key.as_str()).await?;
        if current.as_ref().map(|item| &item.stored.provenance) != Some(expected_provenance) {
            return Err(AppError::api(
                StatusCode::CONFLICT,
                ApiErrorErrorKind::StoreFailed,
                format!("{key}.pdf changed while its extraction ran"),
            ));
        }
        let root = self.root().to_path_buf();
        blocking(move || {
            crate::extraction_publication::publish(&root, &key, &markdown, artifacts.as_deref())
        })
        .await
    }

    /// KEY's first page WIDTH pixels wide, as a PNG. The key's lock is held while it renders, so
    /// a removal waits for the render, and a render after a removal finds no item.
    pub async fn thumbnail(&self, key: &str, width: u32) -> AppResult<Vec<u8>> {
        let _key = self.lock(&self.existing_key(key)?).await;
        let key = self.existing_key(key)?;
        let args = [
            "thumbnail".to_string(),
            "--".to_string(),
            layout::pdf_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
            width.to_string(),
        ];
        Ok(self.inner.python.run(&args).await?)
    }

    /// KEY's text, every page after a marker line, or only PAGE (from 1).
    pub async fn text(&self, key: &str, page: Option<u32>) -> AppResult<String> {
        let _key = self.lock(&self.existing_key(key)?).await;
        let key = self.existing_key(key)?;
        let mut args = vec!["text".to_string()];
        if let Some(page) = page {
            args.extend(["--page".to_string(), page.to_string()]);
        }
        args.extend([
            "--".to_string(),
            layout::pdf_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
        ]);
        let stdout = self.inner.python.run(&args).await.map_err(page_failure)?;
        String::from_utf8(stdout).map_err(AppError::internal)
    }

    /// The lines of KEY's extraction that PAGE (from 1) of its PDF most likely covers, or None
    /// when the page's words match nowhere in it.
    pub async fn locate(&self, key: &str, page: u64) -> AppResult<Option<ExtractionLines>> {
        let _key = self.lock(&self.existing_key(key)?).await;
        let key = self.existing_key(key)?;
        let args = [
            "locate".to_string(),
            "--page".to_string(),
            page.to_string(),
            "--".to_string(),
            layout::pdf_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
            layout::markdown_path(self.root(), &key)
                .to_string_lossy()
                .into_owned(),
        ];
        self.inner.python.json(&args).await.map_err(page_failure)
    }
}

/// What `pdfbucket locate` answers: a range of lines of the extraction, counted from 1, and the
/// nearest heading at or before it.
#[derive(serde::Deserialize)]
pub struct ExtractionLines {
    pub first: u64,
    pub last: u64,
    pub heading: Option<String>,
}

/// A failed page command: a page the PDF lacks is the caller's mistake, the rest the store's.
fn page_failure(failure: PdfFailure) -> AppError {
    match failure {
        PdfFailure::Crashed { status, stderr } if status.code() == Some(PAGE_OUT_OF_RANGE_EXIT) => {
            AppError::invalid(stderr.trim())
        }
        other => other.into(),
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
