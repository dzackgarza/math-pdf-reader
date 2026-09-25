//! The library API: the stored items joined with their filing, and the filing mutations. Every
//! check a mutation makes against the filing (the item still stored, a collection or saved search
//! known) runs under the filing lock, in the same step as the change.
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};

use crate::contract::{
    Activity, ApiErrorErrorKind, BucketItem, BulkCollectionsRequest, BulkTagsRequest, Collection,
    CollectionUpdateRequest, ItemNote, LibraryPayload, NewCollectionRequest, NewSavedSearchRequest,
    NewSavedSearchRequestMatch, NonEmpty, NoteRequest, Organization, PreferencesUpdateRequest,
    Reading, ReadingRequest, ReplaceOutcome, RetrieveMetadataResponse, Rule, SavedSearch,
    SavedSearchMatch, SavedSearchUpdateRequest, SavedSearchUpdateRequestMatch, Settings, Timestamp,
};
use crate::error::{AppError, AppResult};
use crate::export::forget_missing;
use crate::organization::{
    add_collection, add_note, add_saved_search, collections_holding, delete_collection,
    delete_note, delete_saved_search, file_many, filing, log_activity, non_empty,
    organization_file, replace_saved_search, set_reading, tags_of, unknown_collections,
    update_collection, FilingDelta,
};
use crate::state::{bucket_item, parse_body, Shared};
use crate::titles::retrieve_metadata;

type Payload = AppResult<Json<LibraryPayload>>;

fn unknown_collection(ids: &[String]) -> AppError {
    AppError::api(
        StatusCode::BAD_REQUEST,
        ApiErrorErrorKind::UnknownCollection,
        format!("no collection has id {}", ids.join(", ")),
    )
}

/// Refuses IDS the filing holds no collection for.
fn known_collections<'a>(
    org: &Organization,
    ids: impl IntoIterator<Item = &'a str>,
) -> AppResult<()> {
    let unknown = unknown_collections(org, ids);
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(unknown_collection(&unknown))
    }
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

/// Activity for TAGS added to ITEMS, once per collection that holds any of them; only tags
/// some item lacked count.
fn tagged_in(
    org: &Organization,
    items: &[NonEmpty],
    tags: &[NonEmpty],
    at: &Timestamp,
) -> Vec<Activity> {
    let added: Vec<NonEmpty> = tags
        .iter()
        .filter(|tag| {
            items
                .iter()
                .any(|item| !filing(org, item).is_some_and(|filed| filed.tags.contains(tag)))
        })
        .cloned()
        .collect();
    if added.is_empty() {
        return Vec::new();
    }
    collections_holding(org, items)
        .into_iter()
        .map(|(collection_id, count)| Activity::Tagged {
            at: at.clone(),
            collection_id,
            count: std::num::NonZeroU64::new(count).expect("a holding collection holds an item"),
            tags: added.clone(),
        })
        .collect()
}

async fn library(State(state): State<Shared>) -> Payload {
    Ok(Json(state.payload().await?))
}

async fn preferences(State(state): State<Shared>, body: Bytes) -> Payload {
    let update: PreferencesUpdateRequest = parse_body(&body)?;
    state
        .change(|mut org| {
            if let Some(outline_on_open) = update.outline_on_open {
                org.preferences.outline_on_open = outline_on_open;
            }
            if let Some(theme) = update.theme {
                org.preferences.theme = theme;
            }
            Ok(org)
        })
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
    // The one check JSON Schema cannot state; ReadingRequestSchema refines the same.
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
        .change_items(&[&key], |org| {
            Ok(set_reading(org, &key, &captured_at, reading))
        })
        .await
}

async fn add_item_note(
    State(state): State<Shared>,
    Path(key): Path<String>,
    body: Bytes,
) -> Payload {
    let request: NoteRequest = parse_body(&body)?;
    let at = Timestamp::now();
    let note = ItemNote {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        note: request.note,
        date_added: at.clone(),
        date_modified: at,
    };
    state
        .change_items(&[&key], |org| Ok(add_note(org, &key, note)))
        .await
}

async fn delete_item_note(
    State(state): State<Shared>,
    Path((key, note_id)): Path<(String, String)>,
) -> Payload {
    state
        .change_items(&[&key], |org| {
            delete_note(org, &key, &note_id, &Timestamp::now())
        })
        .await
}

fn key_strs(keys: &[NonEmpty]) -> Vec<&str> {
    keys.iter().map(|key| key.as_str()).collect()
}

async fn bulk_tags(State(state): State<Shared>, body: Bytes) -> Payload {
    let request: BulkTagsRequest = parse_body(&body)?;
    let (add, remove) = (tags_of(&request.add), tags_of(&request.remove));
    state
        .change_items(&key_strs(&request.keys), |org| {
            let at = Timestamp::now();
            let activity = tagged_in(&org, &request.keys, &add, &at);
            let change = FilingDelta {
                add_tags: &add,
                remove_tags: &remove,
                add_collections: &[],
                remove_collections: &[],
            };
            Ok(log_activity(
                file_many(org, &request.keys, &change, &at),
                activity,
            ))
        })
        .await
}

async fn bulk_collections(State(state): State<Shared>, body: Bytes) -> Payload {
    let request: BulkCollectionsRequest = parse_body(&body)?;
    state
        .change_items(&key_strs(&request.keys), |org| {
            known_collections(
                &org,
                request
                    .add
                    .iter()
                    .chain(&request.remove)
                    .map(|id| id.as_str()),
            )?;
            let at = Timestamp::now();
            let activity = filed_into(&org, &request.keys, &request.add, &at);
            let change = FilingDelta {
                add_tags: &[],
                remove_tags: &[],
                add_collections: &request.add,
                remove_collections: &request.remove,
            };
            Ok(log_activity(
                file_many(org, &request.keys, &change, &at),
                activity,
            ))
        })
        .await
}

async fn new_collection(State(state): State<Shared>, body: Bytes) -> AppResult<Json<Collection>> {
    let request: NewCollectionRequest = parse_body(&body)?;
    let collection = Collection {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        name: request.name,
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
        .try_update(|org| {
            known_collections(&org, added.parent_id.as_deref().map(|id| id.as_str()))?;
            Ok(log_activity(add_collection(org, added), vec![created]))
        })
        .await?;
    Ok(Json(collection))
}

async fn edit_collection(
    State(state): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Payload {
    let update: CollectionUpdateRequest = parse_body(&body)?;
    state
        .change(|org| {
            let switched = match (
                update.keep_offline,
                org.collections
                    .iter()
                    .find(|collection| *collection.id == id),
            ) {
                (Some(on), Some(before)) if on != before.keep_offline => {
                    vec![Activity::KeptOffline {
                        at: Timestamp::now(),
                        collection_id: non_empty(&id),
                        on,
                    }]
                }
                _ => Vec::new(),
            };
            Ok(log_activity(
                update_collection(org, &id, &update)?,
                switched,
            ))
        })
        .await
}

async fn remove_collection(State(state): State<Shared>, Path(id): Path<String>) -> Payload {
    state
        .change(|org| delete_collection(org, &id, &Timestamp::now()))
        .await
}

/// Refuses collection rules that name a collection the filing does not hold.
fn known_rule_collections(org: &Organization, rules: &[Rule]) -> AppResult<()> {
    known_collections(
        org,
        rules.iter().filter_map(|rule| match rule {
            Rule::Collection { value, .. } => Some(value.as_str()),
            _ => None,
        }),
    )
}

async fn new_saved_search(
    State(state): State<Shared>,
    body: Bytes,
) -> AppResult<Json<SavedSearch>> {
    let request: NewSavedSearchRequest = parse_body(&body)?;
    let search = SavedSearch {
        id: non_empty(&uuid::Uuid::new_v4().to_string()),
        name: request.name,
        match_: match request.match_ {
            NewSavedSearchRequestMatch::All => SavedSearchMatch::All,
            NewSavedSearchRequestMatch::Any => SavedSearchMatch::Any,
        },
        rules: request.rules,
    };
    let added = search.clone();
    state
        .organizations
        .try_update(|org| {
            known_rule_collections(&org, &added.rules)?;
            Ok(add_saved_search(org, added))
        })
        .await?;
    Ok(Json(search))
}

async fn edit_saved_search(
    State(state): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Payload {
    let request: SavedSearchUpdateRequest = parse_body(&body)?;
    let search = SavedSearch {
        id: non_empty(&id),
        name: request.name,
        match_: match request.match_ {
            SavedSearchUpdateRequestMatch::All => SavedSearchMatch::All,
            SavedSearchUpdateRequestMatch::Any => SavedSearchMatch::Any,
        },
        rules: request.rules,
    };
    state
        .change(|org| {
            known_rule_collections(&org, &search.rules)?;
            replace_saved_search(org, search)
        })
        .await
}

async fn remove_saved_search(State(state): State<Shared>, Path(id): Path<String>) -> Payload {
    state.change(|org| delete_saved_search(org, &id)).await
}

/// Forgets an item the index export lists whose PDF the store lost: the next export drops it
/// instead of refusing, and its filing goes.
async fn forget(State(state): State<Shared>, Path(key): Path<String>) -> Payload {
    let organization =
        forget_missing(&state.organizations, state.exporter.export_file(), &key).await?;
    Ok(Json(state.payload_of(organization).await?))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/library", get(library))
        .route("/api/preferences", patch(preferences))
        .route("/api/settings", get(settings))
        .route("/api/items/{key}/metadata", post(metadata))
        .route("/api/items/{key}/pdf", put(replace_pdf))
        .route("/api/items/{key}/reading", put(reading))
        .route("/api/items/{key}/notes", post(add_item_note))
        .route("/api/items/{key}/notes/{note_id}", delete(delete_item_note))
        .route("/api/missing/{key}", delete(forget))
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
