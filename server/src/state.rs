//! The state one bucket's routes share: its store, index, filing, exporter and Zotero client,
//! and the joins of stored items with their filing that most answers are made of.
use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::Json;
use lockable::LockPool;
use tokio::sync::{Notify, Semaphore};

use crate::config::{BucketConfig, THUMBNAIL_RENDERS};
use crate::contract::{
    from_json, BucketItem, BucketItemFile, Contract, ExportedItem, LibraryPayload,
    LibraryPayloadUnreadableItem, MissingItem, Organization, ZoteroStatus,
};
use crate::error::{AppError, AppResult};
use crate::events::Events;
use crate::export::{concurrency, IndexExporter};
use crate::index::{IndexedItem, LibraryIndex};
use crate::organization::{filing_of, remove_item, OrganizationStore};
use crate::send::zotero_status;
use crate::sessions::SessionStore;
use crate::store::Store;
use crate::zotero::ZoteroWriteApi;

pub type Shared = Arc<AppState>;

pub struct AppState {
    pub config: BucketConfig,
    pub store: Store,
    pub index: Arc<LibraryIndex>,
    pub organizations: Arc<OrganizationStore>,
    pub exporter: Arc<IndexExporter>,
    pub zotero: ZoteroWriteApi,
    pub events: Events,
    pub sessions: Arc<SessionStore>,
    /// Wakes the index exporter: every filing or session write, every PDF stored or removed.
    changed: Arc<Notify>,
    /// Downloads at once when checking or rebuilding sources.
    pub downloads: Semaphore,
    /// Thumbnail renders at once.
    pub renders: Semaphore,
    /// One send or removal of an item at a time, so two clicks never create two Zotero items;
    /// sends of different items run side by side.
    pub sends: LockPool<String>,
}

impl AppState {
    /// Must run on a tokio runtime: the index exporter starts its task here.
    pub fn new(config: BucketConfig) -> Shared {
        let store = Store::configured(&config);
        let changed = Arc::new(Notify::new());
        let index = Arc::new(LibraryIndex::new(store.clone()));
        let organizations = Arc::new(OrganizationStore::new(store.clone(), Arc::clone(&changed)));
        let sessions = Arc::new(SessionStore::new(&config.root, Arc::clone(&changed)));
        let exporter = IndexExporter::start(
            Arc::clone(&index),
            Arc::clone(&organizations),
            Arc::clone(&sessions),
            config.index_export.clone(),
            Arc::clone(&changed),
        );
        Arc::new(Self {
            index,
            organizations,
            sessions,
            exporter,
            changed,
            zotero: ZoteroWriteApi::new(&config.zotero_url),
            events: Events::new(),
            downloads: Semaphore::new(concurrency(&config.app.rebuild)),
            renders: Semaphore::new(THUMBNAIL_RENDERS),
            sends: LockPool::new(),
            store,
            config,
        })
    }

    /// A PDF was stored or restored: the index export is rewritten.
    pub fn stored(&self) {
        self.changed.notify_one();
    }

    /// Takes KEY out of the bucket on purpose (a delete, a send to Zotero): the key is recorded
    /// as removed before its PDF goes to the trash, so the index export drops it even across a
    /// restart, and then its filing goes.
    pub async fn remove(&self, key: &str) -> AppResult<Organization> {
        let keys = [key.to_string()];
        self.organizations.record_removal(&keys).await?;
        if let Err(error) = self.store.remove(key).await {
            self.organizations.withdraw_removal(&keys).await?;
            return Err(error);
        }
        self.organizations.update(|org| remove_item(org, key)).await
    }

    pub async fn indexed(&self, key: &str) -> AppResult<Option<IndexedItem>> {
        self.store.item(key).await
    }

    pub async fn require(&self, key: &str) -> AppResult<IndexedItem> {
        match self.indexed(key).await? {
            Some(indexed) => Ok(indexed),
            None => Err(AppError::unknown_item(key)),
        }
    }

    /// The items the index export holds whose PDF is gone.
    pub async fn missing(
        &self,
        indexed: &[IndexedItem],
    ) -> AppResult<Vec<(ExportedItem, MissingItem)>> {
        let stored: BTreeSet<String> = indexed
            .iter()
            .map(|entry| entry.stored.key.to_string())
            .collect();
        self.exporter.missing(&stored).await
    }

    pub async fn payload_of(&self, organization: Organization) -> AppResult<LibraryPayload> {
        let library = self.store.library().await?;
        let missing = self.missing(&library.items).await?;
        Ok(LibraryPayload {
            items: library
                .items
                .iter()
                .map(|entry| bucket_item(entry, &organization))
                .collect::<AppResult<_>>()?,
            missing: missing.into_iter().map(|(_, shown)| shown).collect(),
            unreadable: library
                .unreadable
                .into_iter()
                .map(|file| LibraryPayloadUnreadableItem {
                    file: file.file.try_into().expect("a file name is never empty"),
                    message: file
                        .message
                        .try_into()
                        .expect("a read failure names its cause"),
                })
                .collect(),
            collections: organization.collections,
            saved_searches: organization.saved_searches,
            activity: organization.activity,
            preferences: organization.preferences,
        })
    }

    pub async fn payload(&self) -> AppResult<LibraryPayload> {
        self.payload_of(self.organizations.read().await?).await
    }

    /// Applies a filing change, checked under the filing lock, and answers with the library as
    /// it now stands.
    pub async fn change(
        &self,
        update: impl FnOnce(Organization) -> AppResult<Organization>,
    ) -> AppResult<Json<LibraryPayload>> {
        let organization = self.organizations.try_update(update).await?;
        Ok(Json(self.payload_of(organization).await?))
    }

    /// A change to the filing of ITEMS, made only while each still has a stored PDF.
    pub async fn change_items(
        &self,
        items: &[&str],
        update: impl FnOnce(Organization) -> AppResult<Organization>,
    ) -> AppResult<Json<LibraryPayload>> {
        let organization = self.organizations.update_items(items, update).await?;
        Ok(Json(self.payload_of(organization).await?))
    }
}

/// The library item: the stored PDF's provenance and metadata joined with its filing.
pub fn bucket_item(indexed: &IndexedItem, organization: &Organization) -> AppResult<BucketItem> {
    let stored = &indexed.stored;
    let provenance = &stored.provenance;
    let filing = filing_of(organization, &stored.key, &provenance.captured_at);
    let zotero: ZoteroStatus =
        zotero_status(filing.zotero.as_ref(), &indexed.extraction, &filing.notes);
    Ok(BucketItem {
        id: stored.key.clone(),
        title: stored.title.text.clone(),
        title_source: stored.title.source,
        authors: stored.authors.clone(),
        year: stored.year,
        abstract_: stored.abstract_.clone(),
        url: match &provenance.source_url {
            Some(page) => page.clone(),
            None => provenance.pdf_url.clone(),
        },
        tags: filing.tags,
        collections: filing.collections,
        notes: filing.notes,
        reading: filing.reading,
        source_check: filing.source_check,
        mirrors: filing.mirrors,
        extraction: indexed.extraction.clone(),
        zotero,
        date_added: provenance.captured_at.clone(),
        date_modified: filing.modified_at,
        provenance: provenance.clone(),
        file: BucketItemFile {
            path: indexed
                .path
                .to_string_lossy()
                .into_owned()
                .try_into()
                .expect("a stored PDF's path is not empty"),
            size_bytes: i64::try_from(indexed.size_bytes).map_err(AppError::internal)?,
        },
    })
}

/// A request body checked against its contract schema and typed; a body that fails it is an
/// invalid request.
pub fn parse_body<T: Contract>(body: &Bytes) -> AppResult<T> {
    from_json(body).map_err(|error| AppError::invalid(error.to_string()))
}
