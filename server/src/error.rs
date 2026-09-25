//! What a route answers when it cannot do what was asked. Every error answers the contract's
//! `{ error: { kind, message } }` body (ApiError in src/contract/library.ts) as JSON, with the
//! status that fits it.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::contract::{ApiError, ApiErrorError, ApiErrorErrorKind, NonEmpty};

#[derive(Debug)]
pub enum AppError {
    Api {
        status: StatusCode,
        kind: ApiErrorErrorKind,
        message: String,
    },
    /// Zotero refused a write or did not answer.
    Zotero(String),
    /// A fault in the bucket itself: an unreadable file, a document that fails its schema.
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn api(status: StatusCode, kind: ApiErrorErrorKind, message: impl Into<String>) -> Self {
        Self::Api {
            status,
            kind,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::api(
            StatusCode::BAD_REQUEST,
            ApiErrorErrorKind::InvalidRequest,
            message,
        )
    }

    pub fn unknown_item(key: &str) -> Self {
        Self::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownItem,
            format!("no stored PDF has key {key}"),
        )
    }

    /// The store could not write or move a file.
    pub fn store_failed(message: impl std::fmt::Display) -> Self {
        Self::api(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorErrorKind::StoreFailed,
            message.to_string(),
        )
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(error.to_string())
    }

    /// The error's own text, as the error body carries it.
    pub fn message(&self) -> &str {
        match self {
            Self::Api { message, .. } | Self::Zotero(message) | Self::Internal(message) => message,
        }
    }

    fn parts(self) -> (StatusCode, ApiErrorErrorKind, String) {
        match self {
            Self::Api {
                status,
                kind,
                message,
            } => (status, kind, message),
            Self::Zotero(message) => (
                StatusCode::BAD_GATEWAY,
                ApiErrorErrorKind::ZoteroFailed,
                message,
            ),
            Self::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorErrorKind::Internal,
                message,
            ),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(error)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind, message) = self.parts();
        if status.is_server_error() {
            eprintln!("pdf-bucket: {kind}: {message}");
        }
        let message = NonEmpty::try_from(message).expect("every error names what failed");
        (
            status,
            Json(ApiError {
                error: ApiErrorError { kind, message },
            }),
        )
            .into_response()
    }
}
