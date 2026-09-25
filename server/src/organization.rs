//! The filing document (`organization.json` under the bucket root): collections, tags, notes,
//! reading positions, source checks and saved searches, keyed by item key. Provenance never
//! lives here: deleting this file leaves every stored PDF and its provenance intact.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::ACTIVITY_KEPT;
use crate::contract::{
    Activity, Collection, CollectionUpdateRequest, ItemFiling, ItemNote, Mirror, NonEmpty,
    Organization, Preferences, Reading, SavedSearch, SourceCheck, Theme, Timestamp, Trimmed,
    ZoteroRecord,
};
use crate::error::{AppError, AppResult};
use crate::export::IndexExporter;

pub fn organization_file(root: &Path) -> PathBuf {
    root.join("organization.json")
}

/// The filing of a bucket nobody has filed anything in yet.
pub fn empty_organization() -> Organization {
    Organization {
        version: 2.try_into().expect("2 is the filing document's version"),
        collections: Vec::new(),
        saved_searches: Vec::new(),
        items: BTreeMap::new(),
        activity: Vec::new(),
        preferences: Preferences {
            outline_on_open: false,
            theme: Theme::System,
        },
    }
}

/// The filing of an item nobody has filed: its modification time is its capture time.
pub fn unfiled(captured_at: &Timestamp) -> ItemFiling {
    ItemFiling {
        tags: Vec::new(),
        collections: Vec::new(),
        notes: Vec::new(),
        reading: Reading::Unread,
        source_check: SourceCheck::Unchecked,
        mirrors: Vec::new(),
        modified_at: captured_at.clone(),
        zotero: None,
    }
}

pub fn non_empty(text: &str) -> NonEmpty {
    text.try_into()
        .expect("callers pass keys, ids and trimmed values, which are never empty")
}

pub fn filing<'a>(org: &'a Organization, item: &str) -> Option<&'a ItemFiling> {
    org.items.get(&non_empty(item))
}

/// The item's filing; an item the document omits has never been filed.
pub fn filing_of(org: &Organization, item: &str, captured_at: &Timestamp) -> ItemFiling {
    match filing(org, item) {
        Some(filing) => filing.clone(),
        None => unfiled(captured_at),
    }
}

/// Applies CHANGE to the item's filing (its unfiled filing when it has none) and stamps it
/// modified at NOW.
fn file_item(
    mut org: Organization,
    item: &str,
    now: &Timestamp,
    change: impl FnOnce(&mut ItemFiling),
) -> Organization {
    let entry = org
        .items
        .entry(non_empty(item))
        .or_insert_with(|| unfiled(now));
    change(entry);
    entry.modified_at = now.clone();
    org
}

/// Trimmed, first occurrence kept, order preserved.
pub fn normalized_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<NonEmpty> {
    let mut seen = BTreeSet::new();
    tags.into_iter()
        .map(str::trim)
        .filter(|tag| seen.insert(tag.to_string()))
        .map(non_empty)
        .collect()
}

fn distinct(values: impl IntoIterator<Item = NonEmpty>) -> Vec<NonEmpty> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub fn set_tags(org: Organization, item: &str, tags: &[Trimmed], now: &Timestamp) -> Organization {
    file_item(org, item, now, |filing| {
        filing.tags = normalized_tags(tags.iter().map(|tag| tag.as_str()));
    })
}

/// Adds TAGS and COLLECTIONS to each of ITEMS, after what each item already has.
pub fn file_many(
    org: Organization,
    items: &[NonEmpty],
    tags: &[Trimmed],
    collections: &[NonEmpty],
    now: &Timestamp,
) -> Organization {
    items.iter().fold(org, |current, item| {
        file_item(current, item, now, |filing| {
            filing.tags = normalized_tags(
                filing
                    .tags
                    .iter()
                    .map(|tag| tag.as_str())
                    .chain(tags.iter().map(|tag| tag.as_str())),
            );
            filing.collections = distinct(filing.collections.iter().chain(collections).cloned());
        })
    })
}

pub fn set_collections(
    org: Organization,
    item: &str,
    collections: &[NonEmpty],
    now: &Timestamp,
) -> Organization {
    file_item(org, item, now, |filing| {
        filing.collections = distinct(collections.iter().cloned());
    })
}

pub fn add_note(org: Organization, item: &str, note: ItemNote) -> Organization {
    let at = note.date_added.clone();
    file_item(org, item, &at, |filing| filing.notes.push(note))
}

pub fn delete_note(org: Organization, item: &str, note_id: &str, now: &Timestamp) -> Organization {
    file_item(org, item, now, |filing| {
        filing.notes.retain(|note| *note.id != note_id);
    })
}

pub fn set_zotero_record(
    org: Organization,
    item: &str,
    record: ZoteroRecord,
    now: &Timestamp,
) -> Organization {
    file_item(org, item, now, |filing| filing.zotero = Some(record))
}

/// Where the reader was: not a filing change, so the item's modification time stays (an item
/// never filed keeps its capture time, as `unfiled` gives it).
pub fn set_reading(
    mut org: Organization,
    item: &str,
    captured_at: &Timestamp,
    reading: Reading,
) -> Organization {
    org.items
        .entry(non_empty(item))
        .or_insert_with(|| unfiled(captured_at))
        .reading = reading;
    org
}

pub fn add_mirror(org: Organization, item: &str, url: &str, now: &Timestamp) -> Organization {
    file_item(org, item, now, |filing| {
        if !filing.mirrors.iter().any(|mirror| mirror.url == url) {
            filing.mirrors.push(Mirror {
                url: url.to_string(),
                check: SourceCheck::Unchecked,
            });
        }
    })
}

pub fn remove_mirror(org: Organization, item: &str, url: &str, now: &Timestamp) -> Organization {
    file_item(org, item, now, |filing| {
        filing.mirrors.retain(|mirror| mirror.url != url);
    })
}

/// The outcome of checking the PDF URL and the mirrors (by URL): not a filing change.
pub fn record_source_checks(
    mut org: Organization,
    item: &str,
    captured_at: &Timestamp,
    source_check: SourceCheck,
    mirror_checks: &BTreeMap<String, SourceCheck>,
) -> Organization {
    let filing = org
        .items
        .entry(non_empty(item))
        .or_insert_with(|| unfiled(captured_at));
    filing.source_check = source_check;
    for mirror in &mut filing.mirrors {
        if let Some(check) = mirror_checks.get(&mirror.url) {
            mirror.check = check.clone();
        }
    }
    org
}

/// The item left the bucket (deleted, or sent to Zotero): its filing goes with it.
pub fn remove_item(mut org: Organization, item: &str) -> Organization {
    org.items.remove(&non_empty(item));
    org
}

pub fn add_collection(mut org: Organization, collection: Collection) -> Organization {
    org.collections.push(collection);
    org
}

pub fn update_collection(
    mut org: Organization,
    id: &str,
    update: &CollectionUpdateRequest,
) -> Organization {
    for collection in org.collections.iter_mut().filter(|c| *c.id == id) {
        if let Some(name) = &update.name {
            collection.name = name.clone();
        }
        if let Some(description) = &update.description {
            collection.description = description.clone();
        }
        if let Some(pinned) = update.pinned {
            collection.pinned = pinned;
        }
        if let Some(keep_offline) = update.keep_offline {
            collection.keep_offline = keep_offline;
        }
    }
    org
}

pub fn log_activity(mut org: Organization, entries: Vec<Activity>) -> Organization {
    org.activity.extend(entries);
    let excess = org.activity.len().saturating_sub(ACTIVITY_KEPT);
    org.activity.drain(..excess);
    org
}

/// The collection and every collection below it.
pub fn collection_subtree(collections: &[Collection], id: &str) -> BTreeSet<String> {
    let mut subtree = BTreeSet::from([id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for collection in collections {
            let below = collection
                .parent_id
                .as_ref()
                .is_some_and(|parent| subtree.contains(parent.as_str()));
            if below && subtree.insert(collection.id.to_string()) {
                grew = true;
            }
        }
    }
    subtree
}

/// The collections holding any of ITEMS, with how many of ITEMS each holds.
pub fn collections_holding(org: &Organization, items: &[NonEmpty]) -> BTreeMap<NonEmpty, u64> {
    let mut held = BTreeMap::new();
    for item in items {
        if let Some(filed) = filing(org, item) {
            for id in &filed.collections {
                *held.entry(id.clone()).or_insert(0) += 1;
            }
        }
    }
    held
}

/// Deleting a collection deletes its subcollections and takes every item out of them.
pub fn delete_collection(mut org: Organization, id: &str, now: &Timestamp) -> Organization {
    let removed = collection_subtree(&org.collections, id);
    for filing in org.items.values_mut() {
        if filing
            .collections
            .iter()
            .any(|collection| removed.contains(collection.as_str()))
        {
            filing
                .collections
                .retain(|collection| !removed.contains(collection.as_str()));
            filing.modified_at = now.clone();
        }
    }
    org.collections
        .retain(|collection| !removed.contains(collection.id.as_str()));
    org
}

pub fn add_saved_search(mut org: Organization, search: SavedSearch) -> Organization {
    org.saved_searches.push(search);
    org
}

pub fn replace_saved_search(mut org: Organization, search: SavedSearch) -> Organization {
    for saved in org.saved_searches.iter_mut().filter(|s| s.id == search.id) {
        *saved = search.clone();
    }
    org
}

pub fn delete_saved_search(mut org: Organization, id: &str) -> Organization {
    org.saved_searches.retain(|search| *search.id != id);
    org
}

/// Whether a Keep offline collection holds the item, directly or through a subcollection.
pub fn kept_offline(org: &Organization, item: &str) -> bool {
    let Some(filed) = filing(org, item) else {
        return false;
    };
    org.collections
        .iter()
        .filter(|collection| collection.keep_offline)
        .any(|collection| {
            collection_subtree(&org.collections, &collection.id)
                .iter()
                .any(|id| filed.collections.iter().any(|filed| filed.as_str() == id))
        })
}

/// One store per bucket root. Writes are serialized and land by rename, so a reader never
/// sees a half-written file and a response is sent only after its change is on disk.
pub struct OrganizationStore {
    path: PathBuf,
    writes: Mutex<()>,
    exporter: Option<Arc<IndexExporter>>,
}

impl OrganizationStore {
    /// EXPORTER hears of every write that landed.
    pub fn new(root: &Path, exporter: Option<Arc<IndexExporter>>) -> Self {
        Self {
            path: organization_file(root),
            writes: Mutex::new(()),
            exporter,
        }
    }

    pub async fn read(&self) -> AppResult<Organization> {
        read_organization(&self.path).await
    }

    /// Each change runs after the previous one settles; a change that fails leaves the file as
    /// it was.
    pub async fn update(
        &self,
        change: impl FnOnce(Organization) -> Organization,
    ) -> AppResult<Organization> {
        let _serialized = self.writes.lock().await;
        let next = change(self.read().await?);
        write_json(&self.path, &next).await?;
        if let Some(exporter) = &self.exporter {
            exporter.changed();
        }
        Ok(next)
    }
}

pub async fn read_organization(path: &Path) -> AppResult<Organization> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(empty_organization());
    }
    let text = tokio::fs::read_to_string(path).await?;
    serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!("{} fails its schema: {error}", path.display()))
    })
}

/// Writes VALUE as pretty JSON beside PATH and renames it into place.
pub async fn write_json(path: &Path, value: &impl serde::Serialize) -> AppResult<()> {
    let partial = PathBuf::from(format!("{}.partial", path.display()));
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    tokio::fs::write(&partial, text).await?;
    tokio::fs::rename(&partial, path).await?;
    Ok(())
}
