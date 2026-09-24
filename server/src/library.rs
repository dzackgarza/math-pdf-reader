//! The library API: the stored items joined with their filing, and the filing mutations.
use std::collections::BTreeSet;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};

use crate::contract::{
    Activity, ApiErrorErrorKind, BucketItem, BulkCollectionsRequest, BulkTagsRequest, Collection,
    CollectionUpdateRequest, CollectionsRequest, ItemNote, LibraryPayload, NewCollectionRequest,
    NewSavedSearchRequest, NewSavedSearchRequestMatch, NonEmpty, NoteRequest, Organization,
    Preferences, Reading, ReadingRequest, ReplaceOutcome, RetrieveMetadataResponse, Rule,
    SavedSearch, SavedSearchMatch, SavedSearchUpdateRequest, SavedSearchUpdateRequestMatch,
    Settings, TagsRequest, Timestamp, Trimmed,
};
use crate::error::{AppError, AppResult};
use crate::organization::{
    add_collection, add_note, add_saved_search, collections_holding, delete_collection,
    delete_note, delete_saved_search, file_many, filing, log_activity, non_empty,
    organization_file, replace_saved_search, set_collections, set_reading, set_tags,
    update_collection,
};
use crate::state::{bucket_item, parse_body, Shared};
use crate::titles::retrieve_metadata;

type Payload = AppResult<Json<LibraryPayload>>;

/// A trimmed value, which must not be blank once trimmed.
fn trimmed(value: &Trimmed) -> AppResult<Trimmed> {
    Trimmed::try_from(value.trim())
        .map_err(|error| AppError::invalid(format!("blank value: {error}")))
}

fn trimmed_all(values: &[Trimmed]) -> AppResult<Vec<Trimmed>> {
    values.iter().map(trimmed).collect()
}

fn trimmed_rule(rule: Rule) -> AppResult<Rule> {
    Ok(match rule {
        Rule::Title { operator, value } => Rule::Title {
            operator,
            value: trimmed(&value)?,
        },
        Rule::Author { operator, value } => Rule::Author {
            operator,
            value: trimmed(&value)?,
        },
        Rule::Tag { operator, value } => Rule::Tag {
            operator,
            value: trimmed(&value)?,
        },
        Rule::Topic { operator, value } => Rule::Topic {
            operator,
            value: trimmed(&value)?,
        },
        Rule::Collection { operator, value } => Rule::Collection {
            operator,
            value: trimmed(&value)?,
        },
        Rule::Source { operator, value } => Rule::Source {
            operator,
            value: trimmed(&value)?,
        },
        other => other,
    })
}

fn unknown_collection(ids: &[String]) -> AppError {
    AppError::api(
        StatusCode::BAD_REQUEST,
        ApiErrorErrorKind::UnknownCollection,
        format!("no collection has id {}", ids.join(", ")),
    )
}

fn at_least_one<T>(what: &str, values: &[T]) -> AppResult<()> {
    if values.is_empty() {
        return Err(AppError::invalid(format!("{what} lists nothing")));
    }
    Ok(())
}

/// Activity for filing ITEMS into COLLECTIONS: per collection, the items new to it.
fn filed_into(
    org: &Organization,
    items: &[NonEmpty],
    collections: &[NonEmpty],
    at: &Timestamp,
) -> Vec<Activity> {
    collections
        .iter()
        .filter_map(|collection_id| {
            let count = items
                .iter()
                .filter(|item| {
                    !filing(org, item)
                        .is_some_and(|filed| filed.collections.contains(collection_id))
                })
                .count();
            std::num::NonZeroU64::new(count as u64).map(|count| Activity::Filed {
                at: at.clone(),
                collection_id: collection_id.clone(),
                count,
            })
        })
        .collect()
}

/// Activity for TAGS newly added to ITEMS, once per collection that holds any of them.
fn tagged_in(
    org: &Organization,
    items: &[NonEmpty],
    tags: &[NonEmpty],
    at: &Timestamp,
) -> Vec<Activity> {
    if tags.is_empty() {
        return Vec::new();
    }
    collections_holding(org, items)
        .into_iter()
        .map(|(collection_id, count)| Activity::Tagged {
            at: at.clone(),
            collection_id,
            count: std::num::NonZeroU64::new(count).expect("a holding collection holds an item"),
            tags: tags.to_vec(),
        })
        .collect()
}

async fn library(State(state): State<Shared>) -> Payload {
    Ok(Json(state.payload().await?))
}

async fn preferences(State(state): State<Shared>, body: Bytes) -> Payload {
    let preferences: Preferences = parse_body(&body)?;
    state
        .change(|org| Organization { preferences, ..org })
        .await
}

async fn settings(State(state): State<Shared>) -> Json<Settings> {
    let text = |path: &std::path::Path| {
        path.to_string_lossy()
            .into_owned()
            .try_into()
            .expect("a path is not empty")
    };
    Json(Settings {
        root: text(&state.config.root),
        organization_file: text(&organization_file(&state.config.root)),
        pdfjs_version: state
            .config
            .app
            .pdfjs
            .version
            .to_string()
            .try_into()
            .expect("the PDF.js version is not empty"),
    })
}

/// "Retrieve metadata": run the identifier resolvers again and answer with the item as it now
/// stands; a resolver that fails leaves the title as it was.
async fn metadata(
    State(state): State<Shared>,
    Path(key): Path<String>,
) -> AppResult<Json<RetrieveMetadataResponse>> {
    state.require(&key).await?;
    let outcome = retrieve_metadata(&state.store, &key, &state.config.resolvers_manifest).await?;
    let indexed = state.indexed(&key).await?.ok_or_else(|| {
        AppError::internal(format!(
            "{key} left the store while its metadata was retrieved"
        ))
    })?;
    let item = bucket_item(&indexed, &state.organizations.read().await?)?;
    Ok(Json(RetrieveMetadataResponse { outcome, item }))
}

/// The reader's save: the PDF with its annotations written in by PDF.js.
async fn replace_pdf(
    State(state): State<Shared>,
    Path(key): Path<String>,
    body: Bytes,
) -> AppResult<Json<BucketItem>> {
    state.require(&key).await?;
    if !body.starts_with(b"%PDF-") {
        return Err(AppError::invalid("the request body is not a PDF"));
    }
    if let ReplaceOutcome::ProvenanceMismatch { .. } = state.store.replace(&key, &body).await? {
        return Err(AppError::api(
            StatusCode::CONFLICT,
            ApiErrorErrorKind::ProvenanceMismatch,
            format!("the PDF does not carry the provenance embedded in {key}"),
        ));
    }
    let indexed = state.indexed(&key).await?.ok_or_else(|| {
        AppError::internal(format!("{key} left the store while its PDF was replaced"))
    })?;
    Ok(Json(bucket_item(
        &indexed,
        &state.organizations.read().await?,
    )?))
}

async fn reading(State(state): State<Shared>, Path(key): Path<String>, body: Bytes) -> Payload {
    let request: ReadingRequest = parse_body(&body)?;
    if request.page > request.pages {
        return Err(AppError::invalid("page lies beyond the page count"));
    }
    let indexed = state.require(&key).await?;
    let reading = Reading::Viewed {
        page: request.page,
        pages: request.pages,
        viewed_at: Timestamp::now(),
    };
    let captured_at = indexed.stored.provenance.captured_at;
    state
        .change(|org| set_reading(org, &key, &captured_at, reading))
        .await
}

async fn tags(State(state): State<Shared>, Path(key): Path<String>, body: Bytes) -> Payload {
    let request: TagsRequest = parse_body(&body)?;
    let tags = trimmed_all(&request.tags)?;
    state.require(&key).await?;
    state
        .change(|org| {
            let at = Timestamp::now();
            let added: Vec<NonEmpty> = tags
                .iter()
                .map(|tag| non_empty(tag))
                .filter(|tag| !filing(&org, &key).is_some_and(|filed| filed.tags.contains(tag)))
                .collect();
            let activity = tagged_in(&org, &[non_empty(&key)], &added, &at);
            log_activity(set_tags(org, &key, &tags, &at), activity)
        })
        .await
}

async fn item_collections(
    State(state): State<Shared>,
    Path(key): Path<String>,
    body: Bytes,
) -> Payload {
    let request: CollectionsRequest = parse_body(&body)?;
    state.require(&key).await?;
    let known = state.collection_ids().await?;
    let unknown: Vec<String> = request
        .collections
        .iter()
        .filter(|id| !known.contains(id.as_str()))
        .map(|id| id.to_string())
        .collect();
    if !unknown.is_empty() {
        return Err(unknown_collection(&unknown));
    }
    state
        .change(|org| {
            let at = Timestamp::now();
            let activity = filed_into(&org, &[non_empty(&key)], &request.collections, &at);
            log_activity(
                set_collections(org, &key, &request.collections, &at),
                activity,
            )
        })
        .await
}

async fn add_item_note(
    State(state): State<Shared>,
    Path(key): Path<String>,
    body: Bytes,
) -> Payload {
    let request: NoteRequest = parse_body(&body)?;
    let text = trimmed(&request.note)?;
    state.require(&key).await?;
    let at = Timestamp::now();
    let note = ItemNote {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        note: text,
        date_added: at.clone(),
        date_modified: at,
    };
    state.change(|org| add_note(org, &key, note)).await
}

async fn delete_item_note(
    State(state): State<Shared>,
    Path((key, note_id)): Path<(String, String)>,
) -> Payload {
    let org = state.organizations.read().await?;
    let known =
        filing(&org, &key).is_some_and(|filed| filed.notes.iter().any(|note| *note.id == note_id));
    if !known {
        return Err(AppError::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownNote,
            format!("item {key} has no note {note_id}"),
        ));
    }
    state
        .change(|org| delete_note(org, &key, &note_id, &Timestamp::now()))
        .await
}

async fn unstored(state: &Shared, keys: &[NonEmpty]) -> AppResult<()> {
    let stored: BTreeSet<String> = state
        .index
        .items()
        .await?
        .into_iter()
        .map(|indexed| indexed.stored.key.to_string())
        .collect();
    let unknown: Vec<&str> = keys
        .iter()
        .map(|key| key.as_str())
        .filter(|key| !stored.contains(*key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(AppError::unknown_item(&unknown.join(", ")))
    }
}

async fn bulk_tags(State(state): State<Shared>, body: Bytes) -> Payload {
    let request: BulkTagsRequest = parse_body(&body)?;
    at_least_one("keys", &request.keys)?;
    at_least_one("add", &request.add)?;
    let add = trimmed_all(&request.add)?;
    unstored(&state, &request.keys).await?;
    state
        .change(|org| {
            let at = Timestamp::now();
            let tags: Vec<NonEmpty> = add.iter().map(|tag| non_empty(tag)).collect();
            let activity = tagged_in(&org, &request.keys, &tags, &at);
            log_activity(file_many(org, &request.keys, &add, &[], &at), activity)
        })
        .await
}

async fn bulk_collections(State(state): State<Shared>, body: Bytes) -> Payload {
    let request: BulkCollectionsRequest = parse_body(&body)?;
    at_least_one("keys", &request.keys)?;
    at_least_one("add", &request.add)?;
    unstored(&state, &request.keys).await?;
    let known = state.collection_ids().await?;
    let missing: Vec<String> = request
        .add
        .iter()
        .filter(|id| !known.contains(id.as_str()))
        .map(|id| id.to_string())
        .collect();
    if !missing.is_empty() {
        return Err(unknown_collection(&missing));
    }
    state
        .change(|org| {
            let at = Timestamp::now();
            let activity = filed_into(&org, &request.keys, &request.add, &at);
            log_activity(
                file_many(org, &request.keys, &[], &request.add, &at),
                activity,
            )
        })
        .await
}

async fn new_collection(State(state): State<Shared>, body: Bytes) -> AppResult<Json<Collection>> {
    let request: NewCollectionRequest = parse_body(&body)?;
    let name = trimmed(&request.name)?;
    if let Some(parent) = &request.parent_id {
        if !state.collection_ids().await?.contains(parent.as_str()) {
            return Err(unknown_collection(std::slice::from_ref(parent)));
        }
    }
    let collection = Collection {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        name,
        parent_id: request.parent_id,
        description: String::new(),
        pinned: false,
        keep_offline: false,
    };
    let created = Activity::Created {
        at: Timestamp::now(),
        collection_id: collection.id.clone(),
    };
    let added = collection.clone();
    state
        .organizations
        .update(|org| log_activity(add_collection(org, added), vec![created]))
        .await?;
    Ok(Json(collection))
}

fn no_collection(id: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownCollection,
        format!("no collection has id {id}"),
    )
}

async fn edit_collection(
    State(state): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Payload {
    let mut update: CollectionUpdateRequest = parse_body(&body)?;
    let changes_nothing = update.name.is_none()
        && update.description.is_none()
        && update.pinned.is_none()
        && update.keep_offline.is_none();
    if changes_nothing {
        return Err(AppError::invalid("the update changes nothing"));
    }
    update.name = update.name.as_ref().map(trimmed).transpose()?;
    if !state.collection_ids().await?.contains(&id) {
        return Err(no_collection(&id));
    }
    state
        .change(|org| {
            let before = org
                .collections
                .iter()
                .find(|collection| *collection.id == id);
            let switched = match (update.keep_offline, before) {
                (Some(on), Some(before)) if on != before.keep_offline => {
                    vec![Activity::KeptOffline {
                        at: Timestamp::now(),
                        collection_id: non_empty(&id),
                        on,
                    }]
                }
                _ => Vec::new(),
            };
            log_activity(update_collection(org, &id, &update), switched)
        })
        .await
}

async fn remove_collection(State(state): State<Shared>, Path(id): Path<String>) -> Payload {
    if !state.collection_ids().await?.contains(&id) {
        return Err(no_collection(&id));
    }
    state
        .change(|org| delete_collection(org, &id, &Timestamp::now()))
        .await
}

/// The collection ids that collection rules name and the filing does not hold.
async fn unknown_rule_collections(state: &Shared, rules: &[Rule]) -> AppResult<()> {
    let known = state.collection_ids().await?;
    let unknown: Vec<String> = rules
        .iter()
        .filter_map(|rule| match rule {
            Rule::Collection { value, .. } if !known.contains(value.as_str()) => {
                Some(value.to_string())
            }
            _ => None,
        })
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(unknown_collection(&unknown))
    }
}

fn trimmed_rules(rules: Vec<Rule>) -> AppResult<Vec<Rule>> {
    at_least_one("rules", &rules)?;
    rules.into_iter().map(trimmed_rule).collect()
}

async fn new_saved_search(
    State(state): State<Shared>,
    body: Bytes,
) -> AppResult<Json<SavedSearch>> {
    let request: NewSavedSearchRequest = parse_body(&body)?;
    let rules = trimmed_rules(request.rules)?;
    unknown_rule_collections(&state, &rules).await?;
    let search = SavedSearch {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        name: trimmed(&request.name)?,
        match_: match request.match_ {
            NewSavedSearchRequestMatch::All => SavedSearchMatch::All,
            NewSavedSearchRequestMatch::Any => SavedSearchMatch::Any,
        },
        rules,
    };
    let added = search.clone();
    state
        .organizations
        .update(|org| add_saved_search(org, added))
        .await?;
    Ok(Json(search))
}

fn no_saved_search(id: &str) -> AppError {
    AppError::api(
        StatusCode::NOT_FOUND,
        ApiErrorErrorKind::UnknownSavedSearch,
        format!("no saved search has id {id}"),
    )
}

async fn saved_search_known(state: &Shared, id: &str) -> AppResult<()> {
    let saved = state.organizations.read().await?.saved_searches;
    if saved.iter().any(|search| *search.id == id) {
        Ok(())
    } else {
        Err(no_saved_search(id))
    }
}

async fn edit_saved_search(
    State(state): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Payload {
    let request: SavedSearchUpdateRequest = parse_body(&body)?;
    saved_search_known(&state, &id).await?;
    let rules = trimmed_rules(request.rules)?;
    unknown_rule_collections(&state, &rules).await?;
    let search = SavedSearch {
        id: non_empty(&id),
        name: trimmed(&request.name)?,
        match_: match request.match_ {
            SavedSearchUpdateRequestMatch::All => SavedSearchMatch::All,
            SavedSearchUpdateRequestMatch::Any => SavedSearchMatch::Any,
        },
        rules,
    };
    state.change(|org| replace_saved_search(org, search)).await
}

async fn remove_saved_search(State(state): State<Shared>, Path(id): Path<String>) -> Payload {
    saved_search_known(&state, &id).await?;
    state.change(|org| delete_saved_search(org, &id)).await
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/library", get(library))
        .route("/api/preferences", put(preferences))
        .route("/api/settings", get(settings))
        .route("/api/items/{key}/metadata", post(metadata))
        .route("/api/items/{key}/pdf", put(replace_pdf))
        .route("/api/items/{key}/reading", put(reading))
        .route("/api/items/{key}/tags", put(tags))
        .route("/api/items/{key}/collections", put(item_collections))
        .route("/api/items/{key}/notes", post(add_item_note))
        .route("/api/items/{key}/notes/{note_id}", delete(delete_item_note))
        .route("/api/bulk/tags", post(bulk_tags))
        .route("/api/bulk/collections", post(bulk_collections))
        .route("/api/collections", post(new_collection))
        .route(
            "/api/collections/{id}",
            patch(edit_collection).delete(remove_collection),
        )
        .route("/api/saved-searches", post(new_saved_search))
        .route(
            "/api/saved-searches/{id}",
            put(edit_saved_search).delete(remove_saved_search),
        )
}
