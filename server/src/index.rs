//! The library index: every stored PDF under the root with its embedded provenance, its size,
//! and the extraction beside it. Derived from the files on every read; provenance is re-read
//! from a PDF only when that file is new or has changed.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tokio::sync::Mutex;
use walkdir::WalkDir;

use crate::contract::{
    Extraction, ExtractionExtractedFilesItem, ExtractionExtractedMarkdown, StoredItem,
};
use crate::error::{AppError, AppResult};
use crate::store::Store;

#[derive(Clone, Debug)]
pub struct IndexedItem {
    pub stored: StoredItem,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub extraction: Extraction,
}

/// When a PDF was last read: its modification time and size.
#[derive(Clone, PartialEq)]
struct Signature(SystemTime, u64);

struct CachedRead {
    signature: Signature,
    stored: StoredItem,
}

struct StoredFile {
    key: String,
    path: PathBuf,
    size_bytes: u64,
    signature: Signature,
}

pub struct LibraryIndex {
    store: Store,
    // Held for a whole refresh, so concurrent requests never read the same PDF twice.
    reads: Mutex<HashMap<String, CachedRead>>,
}

fn nonempty(text: String) -> crate::contract::NonEmpty {
    text.try_into().expect("a file name is never empty")
}

// A file an extraction plugin left beside a stored PDF.
fn artifact(path: &Path, name: String) -> AppResult<(String, String, i64)> {
    let size = std::fs::metadata(path)?.len();
    let size = i64::try_from(size).map_err(AppError::internal)?;
    Ok((name, path.to_string_lossy().into_owned(), size))
}

/// The extraction beside a stored PDF. The runner moves `<key>.extraction/` into place first
/// and `<key>.md` last, so only the Markdown marks a complete extraction.
fn extraction_for(root: &Path, key: &str, names: &HashSet<String>) -> AppResult<Extraction> {
    let markdown_name = format!("{key}.md");
    if !names.contains(&markdown_name) {
        return Ok(Extraction::None);
    }
    let directory = root.join(format!("{key}.extraction"));
    let mut files = Vec::new();
    if names.contains(&format!("{key}.extraction")) {
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
    let (name, path, size_bytes) = artifact(&root.join(&markdown_name), markdown_name)?;
    Ok(Extraction::Extracted {
        markdown: ExtractionExtractedMarkdown {
            name: nonempty(name),
            path: nonempty(path),
            size_bytes,
        },
        files,
    })
}

fn stored_files(root: &Path) -> AppResult<(HashSet<String>, Vec<StoredFile>)> {
    let mut names = HashSet::new();
    for entry in std::fs::read_dir(root)? {
        names.insert(entry?.file_name().to_string_lossy().into_owned());
    }
    let mut keys: Vec<&String> = names.iter().filter(|name| name.ends_with(".pdf")).collect();
    keys.sort();
    let mut files = Vec::new();
    for name in keys {
        let path = root.join(name);
        let fact = std::fs::metadata(&path)?;
        files.push(StoredFile {
            key: name[..name.len() - ".pdf".len()].to_string(),
            size_bytes: fact.len(),
            signature: Signature(fact.modified()?, fact.len()),
            path,
        });
    }
    Ok((names, files))
}

impl LibraryIndex {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            reads: Mutex::new(HashMap::new()),
        }
    }

    /// Every stored item, in key order.
    pub async fn items(&self) -> AppResult<Vec<IndexedItem>> {
        let mut reads = self.reads.lock().await;
        let root = self.store.root().to_path_buf();
        let (names, files) = stored_files(&root)?;

        let changed: Vec<String> = files
            .iter()
            .filter(|file| {
                reads
                    .get(&file.key)
                    .is_none_or(|read| read.signature != file.signature)
            })
            .map(|file| file.key.clone())
            .collect();
        if !changed.is_empty() {
            let mut listed: BTreeMap<String, StoredItem> = self
                .store
                .list(&changed)
                .await?
                .into_iter()
                .map(|item| (item.key.to_string(), item))
                .collect();
            for file in files.iter().filter(|file| changed.contains(&file.key)) {
                let stored = listed.remove(&file.key).ok_or_else(|| {
                    AppError::internal(format!("the store listing omitted {}", file.key))
                })?;
                reads.insert(
                    file.key.clone(),
                    CachedRead {
                        signature: file.signature.clone(),
                        stored,
                    },
                );
            }
        }
        reads.retain(|key, _| names.contains(&format!("{key}.pdf")));

        files
            .into_iter()
            .map(|file| {
                Ok(IndexedItem {
                    stored: reads
                        .get(&file.key)
                        .expect("every stored file was read above")
                        .stored
                        .clone(),
                    extraction: extraction_for(&root, &file.key, &names)?,
                    path: file.path,
                    size_bytes: file.size_bytes,
                })
            })
            .collect()
    }

    pub async fn item(&self, key: &str) -> AppResult<Option<IndexedItem>> {
        Ok(self
            .items()
            .await?
            .into_iter()
            .find(|indexed| *indexed.stored.key == key))
    }
}
