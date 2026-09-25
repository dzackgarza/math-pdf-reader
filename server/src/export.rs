//! The index export: every stored item's embedded provenance with its filing and a record of its
//! extraction, plus the collections, saved searches and reading sessions, as one deterministic
//! JSON document (items in key order). Importing it into a store without filing restores
//! collections, tags, notes, saved searches and sessions; rebuilding from it re-downloads every
//! PDF it lists that the store has lost.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::{watch, Notify, Semaphore};

use crate::contract::{
    AppConfigRebuild, ExportedItem, ExportedItemTitle, Extraction, ExtractionRecord,
    ExtractionRecordExtractedFilesItem, ExtractionRecordExtractedMarkdown, IndexExport,
    IndexExportState, MissingItem, Organization, RebuildOutcome, Timestamp,
};
use crate::error::{AppError, AppResult};
use crate::index::{IndexedItem, LibraryIndex};
use crate::organization::{
    filing_of, holds_filing, organization_file, read_document, unfiled, write_json,
    OrganizationStore,
};
use crate::sessions::{sessions_file, SessionStore};
use crate::sources::{rebuild_item, RecoverableItem};
use crate::store::Store;

pub async fn read_index_export(export_file: &Path) -> AppResult<IndexExport> {
    read_document(export_file)
        .await?
        .ok_or_else(|| AppError::internal(format!("{} does not exist", export_file.display())))
}

/// What one export did: wrote the document, or refused because the previous export lists keys
/// that have no PDF in the store and were not removed on purpose.
pub enum ExportOutcome {
    Written(IndexExport),
    Refused(Vec<String>),
}

/// The documents one bucket root keeps, as the export and import read and write them.
pub struct BucketDocuments<'a> {
    pub index: &'a LibraryIndex,
    pub organizations: &'a OrganizationStore,
    pub sessions: &'a SessionStore,
}

// What an extraction left beside the PDF, by name under the bucket root.
fn extraction_record(key: &str, extraction: &Extraction) -> ExtractionRecord {
    match extraction {
        Extraction::None => ExtractionRecord::None,
        Extraction::Extracted { markdown, files } => ExtractionRecord::Extracted {
            markdown: ExtractionRecordExtractedMarkdown {
                name: markdown.name.clone(),
                size_bytes: markdown.size_bytes,
            },
            files: files
                .iter()
                .map(|file| ExtractionRecordExtractedFilesItem {
                    name: format!("{key}.extraction/{}", *file.name)
                        .try_into()
                        .expect("an artifact name is not empty"),
                    size_bytes: file.size_bytes,
                })
                .collect(),
        },
    }
}

fn exported(indexed: IndexedItem, organization: &Organization) -> ExportedItem {
    let item = indexed.stored;
    ExportedItem {
        filing: filing_of(organization, &item.key, &item.provenance.captured_at),
        extraction: extraction_record(&item.key, &indexed.extraction),
        key: item.key,
        provenance: item.provenance,
        title: ExportedItemTitle {
            text: item.title.text,
            source: item.title.source,
        },
        authors: item.authors,
        year: item.year,
        abstract_: item.abstract_,
    }
}

/// Writes the export of every stored item. A key that the previous export lists and the store no
/// longer holds is dropped when it was removed on purpose; any other such key makes the export
/// refuse, since writing it would drop the only record that can bring that PDF back. Keys the
/// written export dropped leave the removed set.
pub async fn export_index(
    documents: &BucketDocuments<'_>,
    export_file: &Path,
) -> AppResult<ExportOutcome> {
    // One consistent view: a removal records its key before its PDF goes, under this lock.
    let (stored, removed, organization) = {
        let _locked = documents.organizations.lock().await?;
        (
            documents.index.items().await?,
            documents.organizations.removed().await?,
            documents.organizations.read().await?,
        )
    };
    if let Some(previous) = read_document::<IndexExport>(export_file).await? {
        let keys: BTreeSet<&str> = stored.iter().map(|item| item.stored.key.as_str()).collect();
        let missing: Vec<String> = previous
            .items
            .iter()
            .map(|item| item.key.to_string())
            .filter(|key| !keys.contains(key.as_str()) && !removed.contains(key))
            .collect();
        if !missing.is_empty() {
            return Ok(ExportOutcome::Refused(missing));
        }
    }
    let index = IndexExport {
        version: 3.try_into().expect("3 is the index export's version"),
        sessions: documents.sessions.read().await?.sessions,
        items: stored
            .into_iter()
            .map(|indexed| exported(indexed, &organization))
            .collect(),
        collections: organization.collections,
        saved_searches: organization.saved_searches,
        activity: organization.activity,
        preferences: organization.preferences,
    };
    let directory = export_file
        .parent()
        .expect("the index export file lies in a directory");
    tokio::fs::create_dir_all(directory).await?;
    write_json(export_file, &index).await?;
    let listed: BTreeSet<String> = index
        .items
        .iter()
        .map(|item| item.key.to_string())
        .collect();
    let dropped: BTreeSet<String> = removed.difference(&listed).cloned().collect();
    documents.organizations.prune(&dropped).await?;
    Ok(ExportOutcome::Written(index))
}

/// Restores the filing (collections, tags, notes, saved searches) and the reading sessions from
/// an index export into a data root whose filing document holds no filing: none yet, or the
/// empty one a freshly started app writes. Sessions the root already has stay; exported sessions
/// with other ids are added.
pub async fn import_index(
    documents: &BucketDocuments<'_>,
    root: &Path,
    export_file: &Path,
) -> AppResult<Organization> {
    let index = read_index_export(export_file).await?;
    let organization = documents
        .organizations
        .try_update(|existing| {
            if holds_filing(&existing) {
                return Err(AppError::internal(format!(
                    "{} holds filing; import only into a store without filing",
                    organization_file(root).display()
                )));
            }
            // The export gives every item a filing; one never filed is exported as unfiled,
            // which the library assumes for an item the filing document omits, so it is omitted
            // again here.
            let items: BTreeMap<_, _> = index
                .items
                .into_iter()
                .filter(|item| item.filing != unfiled(&item.provenance.captured_at))
                .map(|item| (item.key, item.filing))
                .collect();
            Ok(Organization {
                version: 2.try_into().expect("2 is the filing document's version"),
                collections: index.collections,
                saved_searches: index.saved_searches,
                activity: index.activity,
                preferences: index.preferences,
                items,
            })
        })
        .await?;
    let mut sessions = documents.sessions.read().await?;
    let known: BTreeSet<_> = sessions.sessions.iter().map(|session| session.id).collect();
    sessions.sessions.extend(
        index
            .sessions
            .into_iter()
            .filter(|session| !known.contains(&session.id)),
    );
    write_json(&sessions_file(root), &sessions).await?;
    Ok(organization)
}

pub fn recoverable(item: &ExportedItem) -> RecoverableItem {
    RecoverableItem {
        key: item.key.to_string(),
        provenance: item.provenance.clone(),
        title: item.title.text.to_string(),
        title_source: item.title.source,
        authors: item
            .authors
            .iter()
            .map(|author| author.to_string())
            .collect(),
        year: item.year,
        abstract_: item.abstract_.as_ref().map(|text| text.to_string()),
        mirrors: item
            .filing
            .mirrors
            .iter()
            .map(|mirror| mirror.url.clone())
            .collect(),
    }
}

/// Every item the export lists, in export order: present, restored, or unrestored with each
/// URL tried.
pub async fn rebuild_cache(
    store: &Store,
    export_file: &Path,
    settings: &AppConfigRebuild,
) -> AppResult<Vec<RebuildOutcome>> {
    tokio::fs::create_dir_all(store.root()).await?;
    let index = read_index_export(export_file).await?;
    let downloads = Semaphore::new(concurrency(settings));
    Ok(join_all(index.items.iter().map(|item| async {
        let _slot = downloads.acquire().await.expect("the semaphore stays open");
        rebuild_item(store, &recoverable(item), settings).await
    }))
    .await)
}

pub fn concurrency(settings: &AppConfigRebuild) -> usize {
    usize::try_from(settings.concurrent_downloads.get()).expect("a download count fits in usize")
}

/// Rewrites the index export whenever the running server changes the library: CHANGED wakes it,
/// and changes that arrive while an export runs are folded into one more export after it. Each
/// outcome becomes the exporter's state, which `/status` reports and `/api/events` streams.
pub struct IndexExporter {
    index: Arc<LibraryIndex>,
    organizations: Arc<OrganizationStore>,
    sessions: Arc<SessionStore>,
    export_file: PathBuf,
    state: watch::Sender<IndexExportState>,
}

fn file_text(file: &Path) -> crate::contract::NonEmpty {
    file.to_string_lossy()
        .into_owned()
        .try_into()
        .expect("the index export's path is not empty")
}

impl IndexExporter {
    /// Starts the exporter's task on the current runtime; its first export runs at once.
    pub fn start(
        index: Arc<LibraryIndex>,
        organizations: Arc<OrganizationStore>,
        sessions: Arc<SessionStore>,
        export_file: PathBuf,
        changed: Arc<Notify>,
    ) -> Arc<Self> {
        let (state, _) = watch::channel(IndexExportState::Pending {
            file: file_text(&export_file),
        });
        let exporter = Arc::new(Self {
            index,
            organizations,
            sessions,
            export_file,
            state,
        });
        let running = Arc::clone(&exporter);
        changed.notify_one();
        tokio::spawn(async move {
            loop {
                changed.notified().await;
                running.export().await;
            }
        });
        exporter
    }

    pub fn export_file(&self) -> &Path {
        &self.export_file
    }

    /// The outcome of the latest export.
    pub fn state(&self) -> IndexExportState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<IndexExportState> {
        self.state.subscribe()
    }

    fn documents(&self) -> BucketDocuments<'_> {
        BucketDocuments {
            index: &self.index,
            organizations: &self.organizations,
            sessions: &self.sessions,
        }
    }

    async fn export(&self) {
        let file = file_text(&self.export_file);
        let state = match export_index(&self.documents(), &self.export_file).await {
            Ok(ExportOutcome::Written(index)) => IndexExportState::Written {
                file,
                written_at: Timestamp::now(),
                items: i64::try_from(index.items.len()).expect("an item count fits in i64"),
            },
            Ok(ExportOutcome::Refused(missing)) => IndexExportState::Refused {
                file,
                missing: missing
                    .iter()
                    .map(|key| key.as_str().try_into().expect("a key is not empty"))
                    .collect(),
            },
            Err(error) => IndexExportState::Failed {
                file,
                message: format!("{error:?}")
                    .try_into()
                    .expect("an error's text is not empty"),
            },
        };
        self.state.send_replace(state);
    }

    /// The items the last export holds whose PDF is not among STORED and that were not removed
    /// on purpose: the ones Rebuild can bring back, or forgetting drops.
    pub async fn missing(
        &self,
        stored: &BTreeSet<String>,
    ) -> AppResult<Vec<(ExportedItem, MissingItem)>> {
        let Some(index) = read_document::<IndexExport>(&self.export_file).await? else {
            return Ok(Vec::new());
        };
        let removed = self.organizations.removed().await?;
        Ok(index
            .items
            .into_iter()
            .filter(|item| {
                !stored.contains(item.key.as_str()) && !removed.contains(item.key.as_str())
            })
            .map(|item| {
                let shown = MissingItem {
                    key: item.key.clone(),
                    title: item.title.text.clone(),
                    authors: item.authors.clone(),
                    provenance: item.provenance.clone(),
                    mirrors: item
                        .filing
                        .mirrors
                        .iter()
                        .map(|mirror| mirror.url.clone())
                        .collect(),
                };
                (item, shown)
            })
            .collect())
    }
}

/// Forgets KEY, an item the export at EXPORT_FILE lists whose PDF the store lost: it counts as
/// removed on purpose, so the next export drops it, and its filing goes.
pub async fn forget_missing(
    organizations: &OrganizationStore,
    export_file: &Path,
    key: &str,
) -> AppResult<Organization> {
    let listed = read_document::<IndexExport>(export_file)
        .await?
        .is_some_and(|index| index.items.iter().any(|item| *item.key == key));
    if !listed {
        return Err(AppError::unknown_item(key));
    }
    organizations.forget(key).await
}
