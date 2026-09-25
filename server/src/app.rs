//! The bucket's HTTP surface: capture, import, status, the PDF and reader URLs, the event
//! stream, the API route groups, the PDF.js viewer and the library UI bundle.
use std::io::ErrorKind;
use std::path::Path as FsPath;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Multipart, Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nix::errno::Errno;
use nix::unistd::{access, AccessFlags};
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use url::Url;

use crate::config::VERSION;
use crate::contract::{
    ApiErrorErrorKind, CaptureResponse, FolderImportRequest, FolderImportResponse,
    ImportUrlRequest, ImportUrlResponse, ServerStatus, ServerStatusCapabilities,
    ServerStatusService, ServerStatusServiceName, ServerStatusStorage,
};
use crate::contract::{OpenReader, RetrieveMetadataOutcome, StoredItemTitle, TitleSource};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::imports::{find_pdf_at, is_pdf, pdfs_in_folder};
use crate::reader::{pdf_url_path, reader_page, reader_url_path};
use crate::state::{bucket_item, parse_body, Shared};
use crate::store::Upload;
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

/// Stores an upload; a new item takes its title from a resolver when one knows its identifier,
/// and a resolver that fails leaves the title the PDF itself gives. The result carries the
/// item's title as stored once that is done.
async fn store(state: &Shared, upload: &Upload) -> AppResult<crate::contract::CaptureResult> {
    let mut result = state.store.capture(upload).await?;
    if !result.existing {
        state.organizations.claim(&result.item.key).await?;
        match retrieve_metadata(
            &state.store,
            &result.item.key,
            &state.config.resolvers_manifest,
        )
        .await?
        {
            RetrieveMetadataOutcome::Resolved { title, .. } => {
                result.item.title = StoredItemTitle {
                    text: title,
                    source: TitleSource::Resolver,
                };
            }
            RetrieveMetadataOutcome::Unidentified | RetrieveMetadataOutcome::Failed { .. } => {}
        }
    }
    state.stored();
    Ok(result)
}

fn web_url(value: &str) -> bool {
    match Url::parse(value) {
        Ok(url) => matches!(url.scheme(), "http" | "https"),
        Err(_unparsed) => false,
    }
}

// Why the capture form was refused; it answers 400 `invalid_capture_form`.
struct InvalidCapture(String);

impl IntoResponse for InvalidCapture {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_capture_form", "issues": [{ "message": self.0 }] })),
        )
            .into_response()
    }
}

fn invalid_capture(issue: impl Into<String>) -> InvalidCapture {
    InvalidCapture(issue.into())
}

// The capture extension's form: the PDF's bytes, where it was linked from, and a title hint.
async fn capture_form(mut form: Multipart) -> Result<Upload, InvalidCapture> {
    let (mut pdf, mut pdf_url, mut source_url, mut title_hint) = (None, None, None, None);
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|error| invalid_capture(error.body_text()))?
    {
        let name = field.name().map(str::to_string);
        match name.as_deref() {
            Some("pdf") => {
                let filename = match field.file_name() {
                    Some(filename) => filename.to_string(),
                    None => return Err(invalid_capture("pdf is not a file")),
                };
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|error| invalid_capture(error.body_text()))?;
                pdf = Some((filename, bytes.to_vec()));
            }
            Some(text @ ("pdf_url" | "source_url" | "title_hint")) => {
                let value = field
                    .text()
                    .await
                    .map_err(|error| invalid_capture(error.body_text()))?;
                let slot = match text {
                    "pdf_url" => &mut pdf_url,
                    "source_url" => &mut source_url,
                    _ => &mut title_hint,
                };
                *slot = Some(value);
            }
            other => return Err(invalid_capture(format!("unexpected field {other:?}"))),
        }
    }
    let (Some((filename, bytes)), Some(pdf_url), Some(source_url), Some(title_hint)) =
        (pdf, pdf_url, source_url, title_hint)
    else {
        return Err(invalid_capture(
            "pdf, pdf_url, source_url and title_hint are required",
        ));
    };
    if !web_url(&pdf_url) || !web_url(&source_url) {
        return Err(invalid_capture(
            "pdf_url and source_url must be http or https URLs",
        ));
    }
    if title_hint.is_empty() {
        return Err(invalid_capture("title_hint must not be empty"));
    }
    Ok(Upload {
        bytes,
        filename,
        pdf_url,
        source_url,
        title_hint,
    })
}

async fn capture_bytes(
    State(state): State<Shared>,
    headers: HeaderMap,
    form: Multipart,
) -> AppResult<Response> {
    let upload = match capture_form(form).await {
        Ok(upload) => upload,
        Err(invalid) => return Ok(invalid.into_response()),
    };
    if !is_pdf(&upload.bytes) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "not_a_pdf" })),
        )
            .into_response());
    }
    let result = store(&state, &upload).await?;
    let origin = origin(&headers)?;
    let key = result.item.key.to_string();
    let response = CaptureResponse {
        existing: result.existing,
        stored_sha256: result.stored_sha256,
        reader_url: format!("{origin}{}", reader_url_path(&key)),
        pdf_url: format!("{origin}{}", pdf_url_path(&key)),
        provenance: result.item.provenance,
        key: result.item.key,
    };
    state.events.publish_open_reader(OpenReader {
        reader_url: response.reader_url.clone(),
        title: result.item.title.text,
    });
    Ok(Json(response).into_response())
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
    let result = store(&state, &upload).await?;
    Ok(Json(ImportUrlResponse {
        key: result.item.key,
        existing: result.existing,
    }))
}

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
    let mut response = FolderImportResponse {
        stored: Vec::new(),
        existing: Vec::new(),
    };
    for upload in pdfs_in_folder(folder).await? {
        let result = store(&state, &upload).await?;
        if result.existing {
            response.existing.push(result.item.key);
        } else {
            response.stored.push(result.item.key);
        }
    }
    Ok(Json(response))
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

async fn pdf(
    State(state): State<Shared>,
    Path(file): Path<String>,
    request: Request,
) -> AppResult<Response> {
    let Some(path) = file
        .strip_suffix(".pdf")
        .and_then(|key| state.store.pdf_path(key))
    else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    // ServeFile answers range requests, which PDF.js makes for a large PDF.
    let served = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(AppError::internal)?;
    Ok(served.map(Body::new))
}

async fn read(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let Some(indexed) = state.indexed(&key).await? else {
        return Ok(StatusCode::NOT_FOUND.into_response());
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
