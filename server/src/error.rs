//! What a route answers when it cannot do what was asked: an API error with the contract's
//! `{ error: { kind, message } }` body, a store command that failed, or Zotero refusing a write.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::contract::ApiErrorErrorKind;

#[derive(Debug)]
pub enum AppError {
    Api {
        status: StatusCode,
        kind: ApiErrorErrorKind,
        message: String,
    },
    /// The Python store exited non-zero.
    Store { exit_code: i32, stderr: String },
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

    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(error.to_string())
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
        match self {
            Self::Api {
                status,
                kind,
                message,
            } => (
                status,
                Json(json!({ "error": { "kind": kind, "message": message } })),
            )
                .into_response(),
            Self::Store { exit_code, stderr } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "store_command_failed",
                    "exit_code": exit_code,
                    "stderr": stderr,
                })),
            )
                .into_response(),
            Self::Zotero(message) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": { "kind": "zotero_failed", "message": message } })),
            )
                .into_response(),
            Self::Internal(message) => {
                eprintln!("pdf-bucket: {message}");
                (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
            }
        }
    }
}
