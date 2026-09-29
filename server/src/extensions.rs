//! The capture extension builds the bucket was provisioned with (config::extensions_dir): their
//! versions for `GET /status`, and the signed Firefox build with its update manifest, from which
//! Firefox installs and updates the add-on (the enterprise policy `just firefox-policy` writes).
use std::path::Path;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app::origin;
use crate::contract::{ApiErrorErrorKind, NonEmpty, ServerStatusExtensions};
use crate::error::{AppError, AppResult};
use crate::sources::sha256;
use crate::state::Shared;

const CHROME_BUILD: &str = "chrome-mv3";
const FIREFOX_BUILD: &str = "firefox-mv2";
const FIREFOX_PACKAGE: &str = "firefox.xpi";
const FIREFOX_PACKAGE_PATH: &str = "/extension/firefox.xpi";

/// The fields of a WebExtension manifest the bucket reads.
#[derive(Deserialize)]
struct Manifest {
    version: NonEmpty,
    browser_specific_settings: Option<BrowserSettings>,
}

#[derive(Deserialize)]
struct BrowserSettings {
    gecko: Gecko,
}

#[derive(Deserialize)]
struct Gecko {
    id: String,
}

/// The file DIR/NAME; None when the bucket was given no such file.
async fn optional_file(dir: &Path, name: &str) -> AppResult<Option<Vec<u8>>> {
    match tokio::fs::read(dir.join(name)).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn manifest(dir: &Path, build: &str) -> AppResult<Option<Manifest>> {
    let name = format!("{build}/manifest.json");
    let Some(text) = optional_file(dir, &name).await? else {
        return Ok(None);
    };
    serde_json::from_slice(&text)
        .map(Some)
        .map_err(|error| AppError::internal(format!("{}: {error}", dir.join(name).display())))
}

pub async fn versions(dir: &Path) -> AppResult<ServerStatusExtensions> {
    Ok(ServerStatusExtensions {
        chrome: manifest(dir, CHROME_BUILD).await?.map(|built| built.version),
        firefox: manifest(dir, FIREFOX_BUILD).await?.map(|built| built.version),
    })
}

/// The signed Firefox build and its manifest.
async fn firefox_build(dir: &Path) -> AppResult<(Manifest, Vec<u8>)> {
    let missing = || {
        AppError::api(
            StatusCode::NOT_FOUND,
            ApiErrorErrorKind::UnknownExtensionBuild,
            format!("{} holds no signed Firefox build", dir.display()),
        )
    };
    let manifest = manifest(dir, FIREFOX_BUILD).await?.ok_or_else(missing)?;
    let package = optional_file(dir, FIREFOX_PACKAGE).await?.ok_or_else(missing)?;
    Ok((manifest, package))
}

async fn firefox_package(State(state): State<Shared>) -> AppResult<impl IntoResponse> {
    let (_, package) = firefox_build(&state.config.extensions_dir).await?;
    Ok(([(header::CONTENT_TYPE, "application/x-xpinstall")], package))
}

/// Firefox's update manifest for the signed build: its version, where to download it, and its
/// SHA-256, which lets Firefox take it over plain HTTP (AddonUpdateChecker's sanitizeUpdateURL).
/// Format: https://extensionworkshop.com/documentation/manage/updating-your-extension/
async fn firefox_updates(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let (manifest, package) = firefox_build(&state.config.extensions_dir).await?;
    let id = manifest
        .browser_specific_settings
        .ok_or_else(|| AppError::internal("the Firefox build's manifest names no add-on id"))?
        .gecko
        .id;
    Ok(Json(serde_json::json!({
        "addons": {
            id: {
                "updates": [{
                    "version": manifest.version,
                    "update_link": format!("{}{FIREFOX_PACKAGE_PATH}", origin(&headers)?),
                    "update_hash": format!("sha256:{}", sha256(&package)),
                }]
            }
        }
    })))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route(FIREFOX_PACKAGE_PATH, get(firefox_package))
        .route("/extension/updates.json", get(firefox_updates))
}
