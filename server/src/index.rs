//! The library index: every stored PDF under the root with what it says about itself, its size
//! and the extraction beside it, derived from the files. A PDF is read again (by `pdfbucket
//! read`) only when its file is new or has changed; the store, the library, the reader and the
//! index export share this one cache. A `<key>.pdf` the store cannot read is reported by file
//! name beside the items, never in their place.
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::contract::{
    Extraction, ExtractionExtractedFilesItem, ExtractionExtractedMarkdown, NonEmpty, PdfRecord,
    ReadOutcomeList, ReadOutcomeListItem, StoredItem, StoredItemTitle,
};
use crate::error::{AppError, AppResult};
use crate::layout::{self, pdf_key, Key};
use crate::store::Store;

#[derive(Clone, Debug)]
pub struct IndexedItem {
    pub stored: StoredItem,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub pages: u64,
    pub extraction: Extraction,
}

/// A `<key>.pdf` in the root the store cannot read, and why.
#[derive(Clone, Debug)]
pub struct UnreadableFile {
    pub file: String,
    pub message: String,
}

/// Every stored item in key order, and every file that should be one and cannot be read.
pub struct Library {
    pub items: Vec<IndexedItem>,
    pub unreadable: Vec<UnreadableFile>,
}

// A listed file as the index takes it.
enum Indexed {
    Item(Box<IndexedItem>),
    Unreadable(UnreadableFile),
}

/// What one file said about itself.
#[derive(Clone)]
pub(crate) enum FileRead {
    Read(PdfRecord),
    Unreadable(String),
}

/// The file behind a path when it was read: an atomic replacement gives a new inode, and an
/// edit in place a new modification time or size.
#[derive(Clone, PartialEq)]
pub(crate) struct Signature {
    inode: u64,
    size: u64,
    modified_ns: i128,
}

impl Signature {
    pub(crate) fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            inode: metadata.ino(),
            size: metadata.size(),
            modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
                + i128::from(metadata.mtime_nsec()),
        }
    }
}

pub(crate) struct CachedRead {
    signature: Signature,
    read: FileRead,
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("a file name is never empty")
}

// A file an extraction plugin left beside a stored PDF.
fn artifact(path: &Path, name: String) -> AppResult<(String, String, i64)> {
    let size = std::fs::metadata(path)?.len();
    let size = i64::try_from(size).map_err(AppError::internal)?;
    Ok((name, path.to_string_lossy().into_owned(), size))
}

/// The extraction beside a stored PDF. The placement moves `<key>.extraction/` into place
/// first and `<key>.md` last, so only the Markdown marks a complete extraction.
fn extraction_for(root: &Path, key: &Key) -> AppResult<Extraction> {
    let markdown = layout::markdown_path(root, key);
    if !markdown.is_file() {
        return Ok(Extraction::None);
    }
    let directory = layout::extraction_dir(root, key);
    let mut files = Vec::new();
    if directory.is_dir() {
        for entry in WalkDir::new(&directory).sort_by_file_name() {
            let entry = entry.map_err(AppError::internal)?;
            if entry.file_type().is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(&directory)
                    .expect("walkdir yields paths under its root")
                    .to_string_lossy()
                    .into_owned();
                let (name, path, size_bytes) = artifact(entry.path(), relative)?;
                files.push(ExtractionExtractedFilesItem {
                    name: nonempty(name),
                    path: nonempty(path),
                    size_bytes,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let name = format!("{key}.md");
    let (name, path, size_bytes) = artifact(&markdown, name)?;
    Ok(Extraction::Extracted {
        markdown: ExtractionExtractedMarkdown {
            name: nonempty(name),
            path: nonempty(path),
            size_bytes,
        },
        files,
    })
}

fn stored_item(key: &Key, record: PdfRecord) -> StoredItem {
    StoredItem {
        key: nonempty(key.to_string()),
        provenance: record.provenance,
        title: StoredItemTitle {
            text: record.title.text,
            source: record.title.source,
        },
        authors: record.authors,
        year: record.year,
        abstract_: record.abstract_,
    }
}

// A `<key>.pdf` file in the root as listed.
struct StoredFile {
    name: String,
    key: Option<Key>,
    path: PathBuf,
    size_bytes: u64,
    signature: Signature,
}

fn stored_file(root: &Path, name: String) -> AppResult<Option<StoredFile>> {
    let path = root.join(&name);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        // Removed or replaced between the listing and this look: the next read sees it again.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    Ok(Some(StoredFile {
        key: pdf_key(&name),
        size_bytes: metadata.size(),
        signature: Signature::of(&metadata),
        name,
        path,
    }))
}

impl Store {
    /// What each PDF at PATHS says about itself, in order, read in one `pdfbucket read`.
    pub(crate) async fn read_records(&self, paths: &[PathBuf]) -> AppResult<Vec<FileRead>> {
        let mut args = vec!["read".to_string(), "--".to_string()];
        args.extend(paths.iter().map(|path| path.to_string_lossy().into_owned()));
        let outcomes: ReadOutcomeList = self.python().json(&args).await?;
        if outcomes.0.len() != paths.len() {
            return Err(AppError::store_failed(format!(
                "pdfbucket read answered {} outcomes for {} files",
                outcomes.0.len(),
                paths.len()
            )));
        }
        Ok(outcomes
            .0
            .into_iter()
            .map(|outcome| match outcome {
                ReadOutcomeListItem::Read { record } => FileRead::Read(record),
                ReadOutcomeListItem::Unreadable { message } => {
                    FileRead::Unreadable(message.to_string())
                }
            })
            .collect())
    }

    // The reads of FILES, from the cache where a file is unchanged; the cache keeps only them
    // when ALL is set (a full listing), and adds to what it holds otherwise.
    async fn reads_of(&self, files: &[StoredFile], all: bool) -> AppResult<Vec<FileRead>> {
        let mut reads = self.inner.reads.lock().await;
        let changed: Vec<&StoredFile> = files
            .iter()
            .filter(|file| file.key.is_some())
            .filter(|file| {
                reads
                    .get(&file.name)
                    .is_none_or(|cached| cached.signature != file.signature)
            })
            .collect();
        if !changed.is_empty() {
            let paths: Vec<PathBuf> = changed.iter().map(|file| file.path.clone()).collect();
            let fresh = self.read_records(&paths).await?;
            for (file, read) in changed.into_iter().zip(fresh) {
                reads.insert(
                    file.name.clone(),
                    CachedRead {
                        signature: file.signature.clone(),
                        read,
                    },
                );
            }
        }
        if all {
            let listed: BTreeSet<&str> = files.iter().map(|file| file.name.as_str()).collect();
            reads.retain(|name, _| listed.contains(name.as_str()));
        }
        Ok(files
            .iter()
            .map(|file| match &file.key {
                None => {
                    FileRead::Unreadable(format!("{} is not named after a store key", file.name))
                }
                Some(_) => reads
                    .get(&file.name)
                    .expect("every keyed file was read above")
                    .read
                    .clone(),
            })
            .collect())
    }

    fn indexed(&self, file: StoredFile, read: FileRead) -> AppResult<Indexed> {
        let (key, record) = match (file.key, read) {
            (Some(key), FileRead::Read(record)) => (key, record),
            (_, FileRead::Unreadable(message)) => {
                return Ok(Indexed::Unreadable(UnreadableFile {
                    file: file.name,
                    message,
                }));
            }
            (None, FileRead::Read(_)) => unreachable!("a file named after no key is never read"),
        };
        Ok(Indexed::Item(Box::new(IndexedItem {
            pages: record.pages.get(),
            stored: stored_item(&key, record),
            extraction: extraction_for(self.root(), &key)?,
            path: file.path,
            size_bytes: file.size_bytes,
        })))
    }

    /// Every stored item in key order, and every `<key>.pdf` that cannot be read.
    pub async fn library(&self) -> AppResult<Library> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(self.root())? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name.ends_with(".pdf") && !name.starts_with('.') {
                names.push(name);
            }
        }
        names.sort();
        let mut files = Vec::new();
        for name in names {
            if let Some(file) = stored_file(self.root(), name)? {
                files.push(file);
            }
        }
        let reads = self.reads_of(&files, true).await?;
        let mut library = Library {
            items: Vec::new(),
            unreadable: Vec::new(),
        };
        for (file, read) in files.into_iter().zip(reads) {
            match self.indexed(file, read)? {
                Indexed::Item(item) => library.items.push(*item),
                Indexed::Unreadable(unreadable) => library.unreadable.push(unreadable),
            }
        }
        Ok(library)
    }

    /// Every stored item in key order.
    pub async fn items(&self) -> AppResult<Vec<IndexedItem>> {
        Ok(self.library().await?.items)
    }

    /// The stored item for KEY, reading only its own file; None when KEY names no readable
    /// stored PDF.
    pub async fn item(&self, key: &str) -> AppResult<Option<IndexedItem>> {
        let Some(key) = Key::parse(key) else {
            return Ok(None);
        };
        let Some(file) = stored_file(self.root(), format!("{key}.pdf"))? else {
            return Ok(None);
        };
        let read = self
            .reads_of(std::slice::from_ref(&file), false)
            .await?
            .pop()
            .expect("one file read gives one outcome");
        Ok(match self.indexed(file, read)? {
            Indexed::Item(item) => Some(*item),
            Indexed::Unreadable(_) => None,
        })
    }
}
