//! The index export: every stored item's embedded provenance with its filing, plus the
//! collections and saved searches, as one deterministic JSON document (items in key order).
//! Importing it into a store without filing restores collections, tags, notes and saved
//! searches; rebuilding from it re-downloads every PDF it lists that the store has lost.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::future::join_all;
use tokio::sync::{Notify, Semaphore};

use crate::contract::{
    AppConfigRebuild, ExportedItem, ExportedItemTitle, IndexExport, MissingItem, Organization,
    RebuildOutcome,
};
use crate::error::{AppError, AppResult};
use crate::organization::{filing_of, organization_file, read_organization, unfiled, write_json};
use crate::sources::{rebuild_item, RecoverableItem};
use crate::store::Store;

pub async fn read_index_export(export_file: &Path) -> AppResult<IndexExport> {
    let text = tokio::fs::read_to_string(export_file).await?;
    serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!(
            "{} fails its schema: {error}",
            export_file.display()
        ))
    })
}

/// Writes the export of every stored item. REMOVED names items the user deleted or sent away on
/// purpose; the export may drop those. Any other item the previous export lists and the store
/// no longer holds makes the export refuse: writing it would drop the only record that can
/// bring those PDFs back.
pub async fn export_index(
    store: &Store,
    export_file: &Path,
    removed: &BTreeSet<String>,
) -> AppResult<IndexExport> {
    let stored: Vec<_> = store
        .items()
        .await?
        .into_iter()
        .map(|indexed| indexed.stored)
        .collect();
    if tokio::fs::try_exists(export_file).await? {
        let keys: BTreeSet<&str> = stored.iter().map(|item| item.key.as_str()).collect();
        let previous = read_index_export(export_file).await?;
        let missing: Vec<&str> = previous
            .items
            .iter()
            .map(|item| item.key.as_str())
            .filter(|key| !keys.contains(key) && !removed.contains(*key))
            .collect();
        if !missing.is_empty() {
            return Err(AppError::internal(format!(
                "{} lists {}, which have no PDF in the store; run `just rebuild-cache` first",
                export_file.display(),
                missing.join(", ")
            )));
        }
    }
    let organization = read_organization(&organization_file(store.root())).await?;
    let items = stored
        .into_iter()
        .map(|item| ExportedItem {
            filing: filing_of(&organization, &item.key, &item.provenance.captured_at),
            key: item.key,
            provenance: item.provenance,
            title: ExportedItemTitle {
                text: item.title.text,
                source: item.title.source,
            },
            authors: item.authors,
            year: item.year,
            abstract_: item.abstract_,
        })
        .collect();
    let index = IndexExport {
        version: 2.try_into().expect("2 is the index export's version"),
        collections: organization.collections,
        saved_searches: organization.saved_searches,
        activity: organization.activity,
        preferences: organization.preferences,
        items,
    };
    let directory = export_file
        .parent()
        .expect("the index export file lies in a directory");
    tokio::fs::create_dir_all(directory).await?;
    write_json(export_file, &index).await?;
    Ok(index)
}

/// Restores the filing (collections, tags, notes, saved searches) from an index export into a
/// data root that has none.
pub async fn import_index(root: &Path, export_file: &Path) -> AppResult<Organization> {
    tokio::fs::create_dir_all(root).await?;
    let path = organization_file(root);
    if tokio::fs::try_exists(&path).await? {
        return Err(AppError::internal(format!(
            "{} exists; import only into a store without filing",
            path.display()
        )));
    }
    let index = read_index_export(export_file).await?;
    // The export gives every item a filing; one never filed is exported as unfiled, which the
    // library assumes for an item the filing document omits, so it is omitted again here.
    let mut items = std::collections::BTreeMap::new();
    for item in index.items {
        let never_filed = serde_json::to_value(&item.filing)?
            == serde_json::to_value(unfiled(&item.provenance.captured_at))?;
        if !never_filed {
            items.insert(item.key, item.filing);
        }
    }
    let organization = Organization {
        version: 2.try_into().expect("2 is the filing document's version"),
        collections: index.collections,
        saved_searches: index.saved_searches,
        activity: index.activity,
        preferences: index.preferences,
        items,
    };
    write_json(&path, &organization).await?;
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

/// Rewrites the index export whenever the running server changes the library. Changes that
/// arrive while an export runs are folded into one more export after it. A refused export (a
/// PDF missing from the store) is reported on stderr and leaves the previous export in place.
pub struct IndexExporter {
    store: Store,
    export_file: PathBuf,
    removed: Mutex<BTreeSet<String>>,
    wake: Notify,
}

impl IndexExporter {
    /// Starts the exporter's task on the current runtime.
    pub fn start(store: Store, export_file: PathBuf) -> Arc<Self> {
        let exporter = Arc::new(Self {
            store,
            export_file,
            removed: Mutex::new(BTreeSet::new()),
            wake: Notify::new(),
        });
        let running = Arc::clone(&exporter);
        tokio::spawn(async move {
            loop {
                running.wake.notified().await;
                running.export().await;
            }
        });
        exporter
    }

    /// The library changed: an export follows.
    pub fn changed(&self) {
        self.wake.notify_one();
    }

    /// Items removed on purpose; the next export drops them instead of refusing.
    pub fn forget(&self, keys: &[String]) {
        self.removed
            .lock()
            .expect("the removed set is never poisoned")
            .extend(keys.iter().cloned());
    }

    pub fn export_file(&self) -> &Path {
        &self.export_file
    }

    async fn export(&self) {
        let dropping = self
            .removed
            .lock()
            .expect("the removed set is never poisoned")
            .clone();
        match export_index(&self.store, &self.export_file, &dropping).await {
            // A key leaves the removed set once an export has dropped it; one still stored
            // (announced before its PDF went) stays until the export after its removal.
            Ok(exported) => {
                let listed: BTreeSet<&str> = exported
                    .items
                    .iter()
                    .map(|item| item.key.as_str())
                    .collect();
                self.removed
                    .lock()
                    .expect("the removed set is never poisoned")
                    .retain(|key| !dropping.contains(key) || listed.contains(key.as_str()));
            }
            Err(error) => eprintln!("index export refused: {error:?}"),
        }
    }

    /// The items the last export holds whose PDF is not among STORED and that were not removed
    /// on purpose: the ones Rebuild can bring back.
    pub async fn missing(
        &self,
        stored: &BTreeSet<String>,
    ) -> AppResult<Vec<(ExportedItem, MissingItem)>> {
        if !tokio::fs::try_exists(&self.export_file).await? {
            return Ok(Vec::new());
        }
        let removed = self
            .removed
            .lock()
            .expect("the removed set is never poisoned")
            .clone();
        let index = read_index_export(&self.export_file).await?;
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
