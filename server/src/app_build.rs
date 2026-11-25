//! `GET /api/app-build`: whether the running app build is the checkout's current source, an
//! older build, or the build a failed rebuild left running (the provisioning contract of
//! specs/007-branding-provisioning).
use std::io::ErrorKind;
use std::path::Path;
use std::time::SystemTime;

use axum::extract::State;
use axum::Json;

use crate::contract::AppBuild;
use crate::error::{AppError, AppResult};
use crate::state::Shared;

const STAMP: &str = "source-fingerprint";
const FAILURE: &str = "rebuild-failure";
const LOG: &str = "rebuild.log";

/// The file's text and modification time; None when it does not exist.
async fn read(path: &Path) -> AppResult<Option<(String, SystemTime)>> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::internal(format!(
                "cannot read {}: {error}",
                path.display()
            )))
        }
    };
    let modified = tokio::fs::metadata(path)
        .await
        .and_then(|metadata| metadata.modified())
        .map_err(|error| AppError::internal(format!("cannot stat {}: {error}", path.display())))?;
    Ok(Some((text.trim().to_string(), modified)))
}

async fn source_fingerprint(checkout: &Path) -> AppResult<String> {
    let script = checkout.join("scripts/source-fingerprint");
    let output = tokio::process::Command::new(&script)
        .current_dir(checkout)
        .output()
        .await
        .map_err(|error| AppError::internal(format!("cannot run {}: {error}", script.display())))?;
    if !output.status.success() {
        return Err(AppError::internal(format!(
            "{} failed ({}): {}",
            script.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn app_build(State(state): State<Shared>) -> AppResult<Json<AppBuild>> {
    let dir = &state.config.app_build_dir;
    let Some((stamp, stamped)) = read(&dir.join(STAMP)).await? else {
        return Ok(Json(AppBuild::Unprovisioned));
    };
    if stamp == source_fingerprint(&state.config.checkout).await? {
        return Ok(Json(AppBuild::Current));
    }
    let failure = read(&dir.join(FAILURE)).await?;
    let Some((exit_status, _)) = failure.filter(|(_, failed)| *failed >= stamped) else {
        return Ok(Json(AppBuild::Stale));
    };
    let exit_status = exit_status.parse().map_err(|error| {
        AppError::internal(format!(
            "{} holds {exit_status:?}, not an exit status: {error}",
            dir.join(FAILURE).display()
        ))
    })?;
    Ok(Json(AppBuild::Failed {
        exit_status,
        log: dir
            .join(LOG)
            .to_string_lossy()
            .into_owned()
            .try_into()
            .expect("a path is not empty"),
    }))
}
