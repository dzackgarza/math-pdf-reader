//! The filing document (`organization.json` under the bucket root): collections, tags, notes,
//! reading positions, source checks and saved searches, keyed by item key. Provenance never
//! lives here: deleting this file leaves every stored PDF and its provenance intact.
//!
//! Beside it, `removed.json` holds the keys taken out of the bucket on purpose that an index
//! export may still list (see `RemovedKeys` in src/contract/files.ts).
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use tokio::sync::{Mutex, MutexGuard, Notify};

use crate::config::ACTIVITY_KEPT;
use crate::contract::{
    from_json, Activity, ApiErrorErrorKind, Collection, CollectionUpdateRequest, Contract,
    ItemFiling, ItemNote, Mirror, NonEmpty, Organization, Preferences, Reading, RemovedKeys, Rule,
    RuleCollectionOperator, SavedSearch, SavedSearchMatch, SourceCheck, Theme, Timestamp, Trimmed,
    ZoteroRecord,
};
use crate::error::{AppError, AppResult};
use crate::store::Store;

pub fn organization_file(root: &Path) -> PathBuf {
    root.join("organization.json")
}

fn removed_file(root: &Path) -> PathBuf {
    root.join("removed.json")
}

pub fn no_collection(id: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownCollection,
        format!("no collection has id {id}"),
    )
}

pub fn no_saved_search(id: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownSavedSearch,
        format!("no saved search has id {id}"),
    )
}

fn unknown_note(item: &str, note_id: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownNote,
        format!("item {item} has no note {note_id}"),
    )
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

/// Whether the document holds any filing: collections, saved searches, item filing or activity.
/// Preferences are settings, not filing.
pub fn holds_filing(org: &Organization) -> bool {
    !(org.collections.is_empty()
        && org.saved_searches.is_empty()
        && org.items.is_empty()
        && org.activity.is_empty())
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

fn distinct(values: impl IntoIterator<Item = NonEmpty>) -> Vec<NonEmpty> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// Takes REMOVE out of VALUES, then puts ADD after what stays, each value once, order kept.
fn delta(values: &[NonEmpty], add: &[NonEmpty], remove: &[NonEmpty]) -> Vec<NonEmpty> {
    distinct(
        values
            .iter()
            .filter(|value| !remove.contains(value))
            .chain(add)
            .cloned(),
    )
}

pub fn tags_of(values: &[Trimmed]) -> Vec<NonEmpty> {
    values.iter().map(|tag| non_empty(tag)).collect()
}

/// Takes REMOVE out of each item's tags and COLLECTIONS, then adds ADD after what each keeps.
pub struct FilingDelta<'a> {
    pub add_tags: &'a [NonEmpty],
    pub remove_tags: &'a [NonEmpty],
    pub add_collections: &'a [NonEmpty],
    pub remove_collections: &'a [NonEmpty],
}

pub fn file_many(
    org: Organization,
    items: &[NonEmpty],
    change: &FilingDelta<'_>,
    now: &Timestamp,
) -> Organization {
    items.iter().fold(org, |current, item| {
        file_item(current, item, now, |filing| {
            filing.tags = delta(&filing.tags, change.add_tags, change.remove_tags);
            filing.collections = delta(
                &filing.collections,
                change.add_collections,
                change.remove_collections,
            );
        })
    })
}

pub fn add_note(org: Organization, item: &str, note: ItemNote) -> Organization {
    let at = note.date_added.clone();
    file_item(org, item, &at, |filing| filing.notes.push(note))
}

pub fn delete_note(
    org: Organization,
    item: &str,
    note_id: &str,
    now: &Timestamp,
) -> AppResult<Organization> {
    let known =
        filing(&org, item).is_some_and(|filed| filed.notes.iter().any(|n| *n.id == note_id));
    if !known {
        return Err(unknown_note(item, note_id));
    }
    Ok(file_item(org, item, now, |filing| {
        filing.notes.retain(|note| *note.id != note_id);
    }))
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
) -> AppResult<Organization> {
    let collection = org
        .collections
        .iter_mut()
        .find(|c| *c.id == id)
        .ok_or_else(|| no_collection(id))?;
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
    Ok(org)
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

/// The collection ids among IDS that the filing does not hold.
pub fn unknown_collections<'a>(
    org: &Organization,
    ids: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    ids.into_iter()
        .filter(|id| {
            !org.collections
                .iter()
                .any(|collection| *collection.id == *id)
        })
        .map(str::to_string)
        .collect()
}

/// A rule's truth once the collections in GONE no longer exist and hold no item: `is` one of
/// them holds for no item, `is not` one of them for every item; any other rule is unaffected.
fn settled(rule: &Rule, gone: &BTreeSet<String>) -> Option<bool> {
    match rule {
        Rule::Collection { operator, value } if gone.contains(value.as_str()) => {
            Some(matches!(operator, RuleCollectionOperator::IsNot))
        }
        _ => None,
    }
}

/// The saved search with its rules on the collections in GONE settled, selecting exactly the
/// items it selected before; `None` when it now selects every item or none, which no rule list
/// can say.
fn repaired(mut search: SavedSearch, gone: &BTreeSet<String>) -> Option<SavedSearch> {
    // A rule that decides the whole search (false under "all", true under "any") leaves it
    // constant; a rule that cannot change the outcome (true under "all", false under "any")
    // drops out.
    let deciding = matches!(search.match_, SavedSearchMatch::Any);
    if search
        .rules
        .iter()
        .any(|rule| settled(rule, gone) == Some(deciding))
    {
        return None;
    }
    search.rules.retain(|rule| settled(rule, gone).is_none());
    (!search.rules.is_empty()).then_some(search)
}

/// Deleting a collection deletes its subcollections, takes every item out of them, and repairs
/// every saved search whose rules name them.
pub fn delete_collection(
    mut org: Organization,
    id: &str,
    now: &Timestamp,
) -> AppResult<Organization> {
    if !org
        .collections
        .iter()
        .any(|collection| *collection.id == id)
    {
        return Err(no_collection(id));
    }
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
    org.saved_searches = std::mem::take(&mut org.saved_searches)
        .into_iter()
        .filter_map(|search| repaired(search, &removed))
        .collect();
    Ok(org)
}

pub fn add_saved_search(mut org: Organization, search: SavedSearch) -> Organization {
    org.saved_searches.push(search);
    org
}

pub fn replace_saved_search(mut org: Organization, search: SavedSearch) -> AppResult<Organization> {
    let saved = org
        .saved_searches
        .iter_mut()
        .find(|saved| saved.id == search.id)
        .ok_or_else(|| no_saved_search(&search.id))?;
    *saved = search;
    Ok(org)
}

pub fn delete_saved_search(mut org: Organization, id: &str) -> AppResult<Organization> {
    if !org.saved_searches.iter().any(|search| *search.id == id) {
        return Err(no_saved_search(id));
    }
    org.saved_searches.retain(|search| *search.id != id);
    Ok(org)
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

/// Exclusive access to the filing: this process's writers queue on the mutex, and other
/// processes (`pdf-bucket import-index`, `forget`, `export-index`) on an advisory lock of the
/// bucket root directory itself (flock(2) through `File::lock`), so the lock leaves no file.
pub struct FilingLock<'a> {
    _serialized: MutexGuard<'a, ()>,
    _file: std::fs::File,
}

/// One store per bucket root. Writes are serialized and land by rename, so a reader never
/// sees a half-written file and a response is sent only after its change is on disk.
pub struct OrganizationStore {
    store: Store,
    writes: Mutex<()>,
    changed: Arc<Notify>,
}

impl OrganizationStore {
    /// CHANGED is notified after every write that landed.
    pub fn new(store: Store, changed: Arc<Notify>) -> Self {
        Self {
            store,
            writes: Mutex::new(()),
            changed,
        }
    }

    fn root(&self) -> &Path {
        self.store.root()
    }

    pub async fn read(&self) -> AppResult<Organization> {
        read_organization(&organization_file(self.root())).await
    }

    /// The keys removed on purpose that an export may still list.
    pub async fn removed(&self) -> AppResult<BTreeSet<String>> {
        let path = removed_file(self.root());
        Ok(match read_document::<RemovedKeys>(&path).await? {
            Some(removed) => removed.keys.iter().map(|key| key.to_string()).collect(),
            None => BTreeSet::new(),
        })
    }

    pub async fn lock(&self) -> AppResult<FilingLock<'_>> {
        let serialized = self.writes.lock().await;
        let root = self.root().to_path_buf();
        let file = tokio::task::spawn_blocking(move || -> std::io::Result<std::fs::File> {
            let file = std::fs::File::open(&root)?;
            file.lock()?;
            Ok(file)
        })
        .await
        .map_err(AppError::internal)??;
        Ok(FilingLock {
            _serialized: serialized,
            _file: file,
        })
    }

    async fn write(&self, org: &Organization) -> AppResult<()> {
        write_json(&organization_file(self.root()), org).await?;
        self.changed.notify_one();
        Ok(())
    }

    async fn write_removed(&self, keys: BTreeSet<String>) -> AppResult<()> {
        let document = RemovedKeys {
            version: 1
                .try_into()
                .expect("1 is the removed keys document's version"),
            keys: keys.iter().map(|key| non_empty(key)).collect(),
        };
        write_json(&removed_file(self.root()), &document).await
    }

    /// Each change runs after the previous one settles; a change that fails leaves the file as
    /// it was.
    pub async fn try_update(
        &self,
        change: impl FnOnce(Organization) -> AppResult<Organization>,
    ) -> AppResult<Organization> {
        let _locked = self.lock().await?;
        let next = change(self.read().await?)?;
        self.write(&next).await?;
        Ok(next)
    }

    pub async fn update(
        &self,
        change: impl FnOnce(Organization) -> Organization,
    ) -> AppResult<Organization> {
        self.try_update(|org| Ok(change(org))).await
    }

    /// A change to the filing of ITEMS, made only while each still has a stored PDF, checked
    /// under the same lock: a key deleted meanwhile answers `unknown_item` instead of gaining
    /// filing again.
    pub async fn update_items(
        &self,
        items: &[&str],
        change: impl FnOnce(Organization) -> AppResult<Organization>,
    ) -> AppResult<Organization> {
        self.try_update(|org| {
            let unstored: Vec<&str> = items
                .iter()
                .copied()
                .filter(|key| self.store.pdf_path(key).is_none())
                .collect();
            if !unstored.is_empty() {
                return Err(AppError::unknown_item(&unstored.join(", ")));
            }
            change(org)
        })
        .await
    }

    /// Records KEYS as removed on purpose, before their PDFs go.
    pub async fn record_removal(&self, keys: &[String]) -> AppResult<()> {
        let _locked = self.lock().await?;
        let mut removed = self.removed().await?;
        removed.extend(keys.iter().cloned());
        self.write_removed(removed).await
    }

    /// Takes KEYS back out of the removed set: their PDFs stayed.
    pub async fn withdraw_removal(&self, keys: &[String]) -> AppResult<()> {
        let _locked = self.lock().await?;
        let mut removed = self.removed().await?;
        removed.retain(|key| !keys.contains(key));
        self.write_removed(removed).await
    }

    /// Forgets an item whose PDF is gone: it counts as removed on purpose, and its filing goes.
    pub async fn forget(&self, key: &str) -> AppResult<Organization> {
        let _locked = self.lock().await?;
        if self.store.pdf_path(key).is_some() {
            return Err(AppError::invalid(format!(
                "{key} has a stored PDF; delete the item instead"
            )));
        }
        let mut removed = self.removed().await?;
        removed.insert(key.to_string());
        self.write_removed(removed).await?;
        let next = remove_item(self.read().await?, key);
        self.write(&next).await?;
        Ok(next)
    }

    /// A new capture holds KEY: a key removed earlier is no longer removed, and the filing it
    /// left (tags, notes, a Zotero record) is not the new item's.
    pub async fn claim(&self, key: &str) -> AppResult<()> {
        let _locked = self.lock().await?;
        let mut removed = self.removed().await?;
        if !removed.remove(key) {
            return Ok(());
        }
        self.write_removed(removed).await?;
        let org = self.read().await?;
        if filing(&org, key).is_some() {
            self.write(&remove_item(org, key)).await?;
        }
        Ok(())
    }

    /// An export dropped DROPPED: they leave the removed set, with any filing a key whose PDF
    /// is gone still has.
    pub async fn prune(&self, dropped: &BTreeSet<String>) -> AppResult<()> {
        if dropped.is_empty() {
            return Ok(());
        }
        let _locked = self.lock().await?;
        let mut removed = self.removed().await?;
        removed.retain(|key| !dropped.contains(key));
        self.write_removed(removed).await?;
        let org = self.read().await?;
        let stale: Vec<&String> = dropped
            .iter()
            .filter(|key| filing(&org, key).is_some() && self.store.pdf_path(key).is_none())
            .collect();
        if !stale.is_empty() {
            let next = stale
                .into_iter()
                .fold(org, |current, key| remove_item(current, key));
            write_json(&organization_file(self.root()), &next).await?;
        }
        Ok(())
    }
}

/// The document at PATH as the contract type T, or `None` when there is no file.
pub async fn read_document<T: Contract>(path: &Path) -> AppResult<Option<T>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(None);
    }
    let text = tokio::fs::read(path).await?;
    from_json(&text).map(Some).map_err(|error| {
        AppError::internal(format!("{} fails its schema: {error}", path.display()))
    })
}

pub async fn read_organization(path: &Path) -> AppResult<Organization> {
    Ok(read_document(path)
        .await?
        .unwrap_or_else(empty_organization))
}

/// Writes VALUE as pretty JSON to a new temporary file beside PATH, flushes it to disk, renames
/// it into place and flushes the directory, so a reader never sees a torn file and two writers
/// (the app and `just export-index`) never share a temporary file.
/// Pattern: tempfile's `NamedTempFile::persist`, with the fsync of file and directory that
/// rename(2) durability needs.
pub async fn write_json(path: &Path, value: &impl serde::Serialize) -> AppResult<()> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let directory = path
            .parent()
            .expect("a document lies in a directory")
            .to_path_buf();
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(text.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(&path).map_err(|error| error.error)?;
        std::fs::File::open(&directory)?.sync_all()
    })
    .await
    .map_err(AppError::internal)??;
    Ok(())
}
