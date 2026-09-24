//! The state one bucket's routes share: its store, index, filing, exporter and Zotero client,
//! and the joins of stored items with their filing that most answers are made of.
use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::Json;
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex, Semaphore};

use crate::config::{store_command, BucketConfig, THUMBNAIL_RENDERS};
use crate::contract::{
    BucketItem, BucketItemFile, ExportedItem, LibraryPayload, MissingItem, Organization,
    ZoteroStatus,
};
use crate::error::{AppError, AppResult};
use crate::events::Events;
use crate::export::{concurrency, IndexExporter};
use crate::index::{IndexedItem, LibraryIndex};
use crate::organization::{filing_of, OrganizationStore};
use crate::send::zotero_status;
use crate::sessions::SessionStore;
use crate::store::Store;
use crate::zotero::ZoteroWriteApi;

pub type Shared = Arc<AppState>;

pub struct AppState {
    pub config: BucketConfig,
    pub store: Store,
    pub index: LibraryIndex,
    pub organizations: OrganizationStore,
    pub exporter: Option<Arc<IndexExporter>>,
    pub zotero: ZoteroWriteApi,
    pub events: Events,
    pub sessions: SessionStore,
    /// Downloads at once when checking or rebuilding sources.
    pub downloads: Semaphore,
    /// Thumbnail renders at once.
    pub renders: Semaphore,
    /// One send or removal at a time, so two clicks never create two Zotero items.
    pub sends: Mutex<()>,
}

impl AppState {
    /// Must run on a tokio runtime: the index exporter starts its task here.
    pub fn new(config: BucketConfig) -> Shared {
        let store = Store::new(
            config.root.clone(),
            store_command(),
            config.process_env.clone(),
        );
        let exporter = config
            .index_export
            .clone()
            .map(|file| IndexExporter::start(store.clone(), file));
        let state = Arc::new(Self {
            index: LibraryIndex::new(store.clone()),
            organizations: OrganizationStore::new(&config.root, exporter.clone()),
            sessions: SessionStore::new(&config.root),
            zotero: ZoteroWriteApi::new(&config.zotero_url),
            events: Events::new(),
            downloads: Semaphore::new(concurrency(&config.app.rebuild)),
            renders: Semaphore::new(THUMBNAIL_RENDERS),
            sends: Mutex::new(()),
            exporter,
            store,
            config,
        });
        state.stored();
        state
    }

    /// A PDF was stored or restored: the index export is rewritten.
    pub fn stored(&self) {
        if let Some(exporter) = &self.exporter {
            exporter.changed();
        }
    }

    /// Items left the bucket on purpose: the index export drops them.
    pub fn removed(&self, keys: &[String]) {
        if let Some(exporter) = &self.exporter {
            exporter.forget(keys);
            exporter.changed();
        }
    }

    pub async fn indexed(&self, key: &str) -> AppResult<Option<IndexedItem>> {
        self.index.item(key).await
    }

    pub async fn require(&self, key: &str) -> AppResult<IndexedItem> {
        match self.indexed(key).await? {
            Some(indexed) => Ok(indexed),
            None => Err(AppError::unknown_item(key)),
        }
    }

    pub async fn collection_ids(&self) -> AppResult<BTreeSet<String>> {
        Ok(self
            .organizations
            .read()
            .await?
            .collections
            .into_iter()
            .map(|collection| collection.id.to_string())
            .collect())
    }

    /// The items the index export holds whose PDF is gone; none without an export.
    pub async fn missing(
        &self,
        indexed: &[IndexedItem],
    ) -> AppResult<Vec<(ExportedItem, MissingItem)>> {
        let Some(exporter) = &self.exporter else {
            return Ok(Vec::new());
        };
        let stored: BTreeSet<String> = indexed
            .iter()
            .map(|entry| entry.stored.key.to_string())
            .collect();
        exporter.missing(&stored).await
    }

    pub async fn payload_of(&self, organization: Organization) -> AppResult<LibraryPayload> {
        let indexed = self.index.items().await?;
        let missing = self.missing(&indexed).await?;
        Ok(LibraryPayload {
            items: indexed
                .iter()
                .map(|entry| bucket_item(entry, &organization))
                .collect::<AppResult<_>>()?,
            missing: missing.into_iter().map(|(_, shown)| shown).collect(),
            collections: organization.collections,
            saved_searches: organization.saved_searches,
            activity: organization.activity,
            preferences: organization.preferences,
        })
    }

    pub async fn payload(&self) -> AppResult<LibraryPayload> {
        self.payload_of(self.organizations.read().await?).await
    }

    /// Applies a filing change and answers with the library as it now stands.
    pub async fn change(
        &self,
        update: impl FnOnce(Organization) -> Organization,
    ) -> AppResult<Json<LibraryPayload>> {
        let organization = self.organizations.update(update).await?;
        Ok(Json(self.payload_of(organization).await?))
    }
}

/// The library item: the stored PDF's provenance and metadata joined with its filing.
pub fn bucket_item(indexed: &IndexedItem, organization: &Organization) -> AppResult<BucketItem> {
    let stored = &indexed.stored;
    let provenance = &stored.provenance;
    let filing = filing_of(organization, &stored.key, &provenance.captured_at);
    let zotero: ZoteroStatus = zotero_status(filing.zotero.as_ref(), &indexed.extraction);
    Ok(BucketItem {
        id: stored.key.clone(),
        title: stored.title.text.clone(),
        title_source: stored.title.source,
        authors: stored.authors.clone(),
        year: stored.year,
        abstract_: stored.abstract_.clone(),
        url: provenance.source_url.clone(),
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

/// A request body parsed against its contract type; a body that fails it is an invalid request.
pub fn parse_body<T: DeserializeOwned>(body: &Bytes) -> AppResult<T> {
    serde_json::from_slice(body).map_err(|error| AppError::invalid(error.to_string()))
}
