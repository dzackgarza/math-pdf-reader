//! The bucket's HTTP surface: capture, import, status, the PDF and reader URLs, the event
//! stream, the API route groups, the PDF.js viewer and the library UI bundle.
use std::io::ErrorKind;
use std::path::Path as FsPath;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::headers::Range;
use axum_extra::TypedHeader;
use axum_range::{KnownSize, Ranged};
use futures::stream::{self, StreamExt};
use nix::errno::Errno;
use nix::unistd::{access, AccessFlags};
use tower_http::services::ServeDir;
use url::Url;

use crate::config::VERSION;
use crate::contract::{
    ApiErrorErrorKind, CaptureResponse, FolderImportRequest, FolderImportResponse,
    FolderImportResponseFilesItem, ImportUrlRequest, ImportUrlResponse, NonEmpty, OpenReader,
    RetrieveMetadataOutcome, ServerStatus, ServerStatusCapabilities, ServerStatusService,
    ServerStatusServiceName, ServerStatusStorage, StoredItemTitle, TitleSource,
};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::export::concurrency;
use crate::imports::{find_pdf_at, folder_upload, pdf_names_in_folder, FolderFile};
use crate::library::entity_tag;
use crate::reader::{pdf_url_path, reader_page, reader_url_path};
use crate::state::{bucket_item, parse_body, Shared};
use crate::store::{Captured, Upload};
use crate::titles::retrieve_metadata;
use crate::{extractions, guard, library, send, sessions, source_routes, thumbnails};

/// The origin a request was made to, from its Host header.
fn origin(headers: &HeaderMap) -> AppResult<String> {
    let host = headers
        .get(header::HOST)
        .ok_or_else(|| AppError::invalid("the request names no host"))?;
    let host = host
        .to_str()
        .map_err(|error| AppError::invalid(format!("the Host header is not text: {error}")))?;
    Ok(format!("http://{host}"))
}

/// Stores an upload. A new item then takes its title from a resolver when one knows its
/// identifier; whatever the resolvers' outcome, the PDF stays stored, and the outcome is
/// answered beside it (None for a PDF already stored).
async fn store(
    state: &Shared,
    upload: &Upload,
) -> AppResult<(Captured, Option<RetrieveMetadataOutcome>)> {
    let mut captured = state.store.capture(upload).await?;
    if !captured.existing {
        state.organizations.claim(&captured.item.key).await?;
    }
    state.stored();
    if captured.existing {
        return Ok((captured, None));
    }
    let outcome = retrieve_metadata(state, &captured.item.key).await;
    if let RetrieveMetadataOutcome::Resolved { title, .. } = &outcome {
        captured.item.title = StoredItemTitle {
            text: title.clone(),
            source: TitleSource::Resolver,
        };
    }
    Ok((captured, Some(outcome)))
}

fn web_url(value: &str) -> bool {
    match Url::parse(value) {
        Ok(url) => matches!(url.scheme(), "http" | "https"),
        Err(_unparsed) => false,
    }
}

// The capture extension's form: the PDF's bytes and the name it was offered under, its URL,
// the page that linked to it when one is known, and a title hint.
async fn capture_form(mut form: Multipart) -> AppResult<Upload> {
    let unreadable = |error: axum::extract::multipart::MultipartError| {
        AppError::invalid(format!(
            "the capture form cannot be read: {}",
            error.body_text()
        ))
    };
    let (mut pdf, mut pdf_url, mut source_url, mut title_hint) = (None, None, None, None);
    while let Some(field) = form.next_field().await.map_err(unreadable)? {
        let name = field.name().map(str::to_string);
        match name.as_deref() {
            Some("pdf") => {
                let Some(filename) = field.file_name().map(str::to_string) else {
                    return Err(AppError::invalid("the capture form's pdf is not a file"));
                };
                let bytes = field.bytes().await.map_err(unreadable)?;
                pdf = Some((filename, bytes.to_vec()));
            }
            Some(text @ ("pdf_url" | "source_url" | "title_hint")) => {
                let value = field.text().await.map_err(unreadable)?;
                let slot = match text {
                    "pdf_url" => &mut pdf_url,
                    "source_url" => &mut source_url,
                    _ => &mut title_hint,
                };
                *slot = Some(value);
            }
            other => {
                return Err(AppError::invalid(format!(
                    "the capture form has an unexpected field {other:?}"
                )))
            }
        }
    }
    let (Some((filename, bytes)), Some(pdf_url), Some(title_hint)) = (pdf, pdf_url, title_hint)
    else {
        return Err(AppError::invalid(
            "the capture form requires pdf, pdf_url and title_hint",
        ));
    };
    let linked = source_url.as_deref().is_none_or(web_url);
    if !web_url(&pdf_url) || !linked {
        return Err(AppError::invalid(
            "pdf_url and source_url must be http or https URLs",
        ));
    }
    if title_hint.is_empty() {
        return Err(AppError::invalid("title_hint must not be empty"));
    }
    Ok(Upload {
        bytes,
        filename: Some(filename),
        pdf_url,
        source_url,
        title_hint,
    })
}

async fn capture_bytes(
    State(state): State<Shared>,
    headers: HeaderMap,
    form: Multipart,
) -> AppResult<Json<CaptureResponse>> {
    let upload = capture_form(form).await?;
    let origin = origin(&headers)?;
    let (captured, metadata) = store(&state, &upload).await?;
    let key = captured.item.key.to_string();
    let response = CaptureResponse {
        existing: captured.existing,
        stored_sha256: captured
            .stored_sha256
            .try_into()
            .expect("a SHA-256 digest is 64 hex digits"),
        reader_url: format!("{origin}{}", reader_url_path(&key)),
        pdf_url: format!("{origin}{}", pdf_url_path(&key)),
        provenance: captured.item.provenance,
        key: captured.item.key,
        metadata,
    };
    state.events.publish_open_reader(OpenReader {
        reader_url: response.reader_url.clone(),
        title: captured.item.title.text,
    });
    Ok(Json(response))
}

async fn import_url(
    State(state): State<Shared>,
    body: Bytes,
) -> AppResult<Json<ImportUrlResponse>> {
    let request: ImportUrlRequest = parse_body(&body)?;
    if !web_url(&request.url) {
        return Err(AppError::invalid(format!(
            "{} is not an http or https URL",
            request.url
        )));
    }
    let upload = find_pdf_at(&request.url, &state.config.app.rebuild)
        .await
        .map_err(|failure| {
            AppError::api(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorErrorKind::NoPdfAtUrl,
                failure.to_string(),
            )
        })?;
    let (captured, metadata) = store(&state, &upload).await?;
    Ok(Json(ImportUrlResponse {
        key: captured.item.key,
        existing: captured.existing,
        metadata,
    }))
}

fn nonempty(text: String) -> NonEmpty {
    text.try_into().expect("the text is never empty")
}

// One file of a folder import: read, checked and stored on its own, its failure its outcome.
async fn import_one(
    state: &Shared,
    folder: &FsPath,
    name: String,
) -> FolderImportResponseFilesItem {
    let file = nonempty(name.clone());
    let upload = match folder_upload(folder, &name).await {
        Ok(FolderFile::Pdf(upload)) => upload,
        Ok(FolderFile::NotPdf) => return FolderImportResponseFilesItem::NotAPdf { file },
        Err(error) => {
            return FolderImportResponseFilesItem::Failed {
                file,
                message: nonempty(format!("cannot read {name}: {error}")),
            }
        }
    };
    match store(state, &upload).await {
        Ok((captured, None)) => FolderImportResponseFilesItem::Existing {
            file,
            key: captured.item.key,
        },
        Ok((captured, Some(metadata))) => FolderImportResponseFilesItem::Stored {
            file,
            key: captured.item.key,
            metadata,
        },
        Err(error) => FolderImportResponseFilesItem::Failed {
            file,
            message: nonempty(error.to_string()),
        },
    }
}

/// Add Folder: every file directly inside the folder whose name ends in `.pdf`, a few at a
/// time (the rebuild download limit), each read only when its turn comes, each with its own
/// outcome in name order.
async fn import_folder(
    State(state): State<Shared>,
    body: Bytes,
) -> AppResult<Json<FolderImportResponse>> {
    let request: FolderImportRequest = parse_body(&body)?;
    let folder = FsPath::new(request.path.as_str());
    // Only the operating system's answer that the path is no directory (a stat(2) of something
    // else, ENOENT, ENOTDIR) is `not_a_folder`; any other error is a failure of the check.
    let is_folder = match tokio::fs::metadata(folder).await {
        Ok(metadata) => metadata.is_dir(),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            false
        }
        Err(error) => {
            return Err(AppError::api(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorErrorKind::FolderCheckFailed,
                format!(
                    "cannot check the folder {}: stat: {error}",
                    folder.display()
                ),
            ))
        }
    };
    if !is_folder {
        return Err(AppError::api(
            StatusCode::BAD_REQUEST,
            ApiErrorErrorKind::NotAFolder,
            format!("{} is no folder", folder.display()),
        ));
    }
    let names = pdf_names_in_folder(folder).await?;
    let files = stream::iter(names)
        .map(|name| import_one(&state, folder, name))
        .buffered(concurrency(&state.config.app.rebuild))
        .collect()
        .await;
    Ok(Json(FolderImportResponse { files }))
}

/// A stat(2) or access(2) call on the bucket root that failed without answering what it asked;
/// the caller gets the operating system's own error.
fn storage_check_failed(root: &FsPath, call: &str, error: impl std::fmt::Display) -> AppError {
    AppError::api(
        StatusCode::INTERNAL_SERVER_ERROR,
        ApiErrorErrorKind::StorageCheckFailed,
        format!(
            "cannot check the bucket root {}: {call}: {error}",
            root.display()
        ),
    )
}

/// Whether the bucket root is a directory this process may write into. Only the operating
/// system's answer that the directory is missing (ENOENT, ENOTDIR from stat(2)) or not writable
/// (EACCES, EROFS, EPERM from access(2) with W_OK) is a storage state; any other error is a
/// failure of the check.
async fn root_storage(root: &FsPath) -> AppResult<ServerStatusStorage> {
    let root_exists = match tokio::fs::metadata(root).await {
        Ok(metadata) => metadata.is_dir(),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            false
        }
        Err(error) => return Err(storage_check_failed(root, "stat", error)),
    };
    if !root_exists {
        return Ok(ServerStatusStorage {
            root_exists,
            root_writable: false,
        });
    }
    let root_writable = match access(root, AccessFlags::W_OK) {
        Ok(()) => true,
        Err(Errno::EACCES | Errno::EROFS | Errno::EPERM) => false,
        Err(errno) => return Err(storage_check_failed(root, "access", errno)),
    };
    Ok(ServerStatusStorage {
        root_exists,
        root_writable,
    })
}

/// `GET /status`: the capture extension and the library read it to tell whether the bucket is
/// up and able to store captures.
async fn status(State(state): State<Shared>, headers: HeaderMap) -> AppResult<Json<ServerStatus>> {
    let root = &state.config.root;
    let storage = root_storage(root).await?;
    let writable = storage.root_writable;
    Ok(Json(ServerStatus {
        backend_url: origin(&headers)?,
        root: root
            .to_string_lossy()
            .into_owned()
            .try_into()
            .expect("the bucket root is not empty"),
        service: ServerStatusService {
            name: ServerStatusServiceName::PdfBucket,
            version: VERSION.try_into().expect("the crate version is not empty"),
        },
        storage,
        capabilities: ServerStatusCapabilities { capture: writable },
        ready: writable,
        index_export: state.exporter.state(),
    }))
}

/// A stored PDF, with range requests (which PDF.js makes for a large PDF) and its SHA-256 as the
/// entity tag, both taken from the one file opened.
async fn pdf(
    State(state): State<Shared>,
    Path(file): Path<String>,
    range: Option<TypedHeader<Range>>,
) -> AppResult<Response> {
    let Some(key) = file.strip_suffix(".pdf") else {
        return Err(AppError::unknown_item(&file));
    };
    let Some(opened) = state.store.open(key).await? else {
        return Err(AppError::unknown_item(key));
    };
    let body = KnownSize::file(opened.file).await?;
    let ranged = Ranged::new(range.map(|TypedHeader(range)| range), body);
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/pdf".parse().expect("a media type"),
            ),
            (header::ETAG, entity_tag(&opened.sha256)),
        ],
        ranged,
    )
        .into_response())
}

async fn read(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let Some(indexed) = state.indexed(&key).await? else {
        return Err(AppError::unknown_item(&key));
    };
    let organization = state.organizations.read().await?;
    let item = bucket_item(&indexed, &organization)?;
    let page = reader_page(&item, &origin(&headers)?, &organization.preferences);
    Ok(Html(page).into_response())
}

pub fn router(state: Shared) -> Router {
    let pdfjs = ServeDir::new(&state.config.pdfjs_dir);
    let web = ServeDir::new(&state.config.web_dir);
    Router::new()
        .route("/status", get(status))
        .route("/capture-bytes", post(capture_bytes))
        .route("/api/import-url", post(import_url))
        .route("/api/import-folder", post(import_folder))
        .route("/api/events", get(events::stream))
        .route("/pdf/{file}", get(pdf))
        .route("/read/{key}", get(read))
        .merge(library::routes())
        .merge(send::routes())
        .merge(source_routes::routes())
        .merge(sessions::routes())
        .merge(extractions::routes())
        .merge(thumbnails::routes())
        .nest_service("/pdfjs", pdfjs)
        .fallback_service(web)
        // PDFs arrive whole in one request (a capture, a reader save); axum's 2 MB default
        // would refuse most of them.
        .layer(DefaultBodyLimit::disable())
        .layer(axum::middleware::from_fn(guard::guard))
        .with_state(state)
}
