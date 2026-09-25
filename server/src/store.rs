//! Bridge to the Python store (`pdfbucket <command>`): provenance embedding, the folder layout,
//! identifier resolution, extraction runs and thumbnails live there. Each call is one process
//! whose stdout is one JSON document of the store contract.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::ProcessEnv;
use crate::contract::{
    CaptureResult, Provenance, Removal, ReplaceOutcome, Resolution, StoredItem, StoredItemList,
    TitleSource,
};
use crate::error::{AppError, AppResult};

/// A PDF offered for storage and where it came from.
pub struct Upload {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub pdf_url: String,
    pub source_url: String,
    pub title_hint: String,
}

/// What a resolver gives an item: title, authors in order, year and abstract where known.
pub struct ResolvedMetadata {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub abstract_: Option<String>,
}

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
    command: Vec<String>,
    env: ProcessEnv,
}

impl Store {
    pub fn new(root: PathBuf, command: Vec<String>, env: ProcessEnv) -> Self {
        Self { root, command, env }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The stored PDF for a key, or `None` when the key names no stored PDF.
    pub fn pdf_path(&self, key: &str) -> Option<PathBuf> {
        let plain = Path::new(key).file_name().is_some_and(|name| name == key);
        if !plain || key == "." || key == ".." {
            return None;
        }
        let path = self.root.join(format!("{key}.pdf"));
        path.is_file().then_some(path)
    }

    fn root_arg(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Runs one store command; `stdin` is written to its standard input when given.
    pub async fn run(&self, args: &[String], stdin: Option<&[u8]>) -> AppResult<String> {
        let (program, prefix) = self
            .command
            .split_first()
            .expect("the store command names a program");
        let mut command = Command::new(program);
        command
            .args(prefix)
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in &self.env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        let mut child = command
            .spawn()
            .map_err(|error| AppError::internal(format!("the store did not start: {error}")))?;
        if let Some(bytes) = stdin {
            let mut pipe = child.stdin.take().expect("stdin is piped");
            pipe.write_all(bytes).await?;
            drop(pipe);
        }
        let output = child.wait_with_output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(match output.status.code() {
                Some(exit_code) => AppError::Store { exit_code, stderr },
                None => AppError::internal(format!("the store was killed ({})", output.status)),
            });
        }
        String::from_utf8(output.stdout).map_err(AppError::internal)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        args: &[String],
        stdin: Option<&[u8]>,
    ) -> AppResult<T> {
        let stdout = self.run(args, stdin).await?;
        serde_json::from_str(&stdout).map_err(|error| {
            AppError::internal(format!(
                "the store printed an answer outside its contract: {error}"
            ))
        })
    }

    pub async fn capture(&self, upload: &Upload) -> AppResult<CaptureResult> {
        let args = [
            "capture",
            "--",
            &self.root_arg(),
            "/dev/stdin",
            &upload.filename,
            &upload.pdf_url,
            &upload.source_url,
            &upload.title_hint,
        ]
        .map(String::from);
        self.json(&args, Some(&upload.bytes)).await
    }

    /// The stored items for these keys (every stored item when `keys` is empty), read from the
    /// PDFs in one store process. `--` ends the options, so a key that starts with a dash stays
    /// a key.
    pub async fn list(&self, keys: &[String]) -> AppResult<Vec<StoredItem>> {
        let mut args = vec!["list".to_string(), self.root_arg(), "--".to_string()];
        args.extend(keys.iter().cloned());
        let listed: StoredItemList = self.json(&args, None).await?;
        Ok(listed.0)
    }

    /// Finds an identifier for the item and resolves it to BibTeX with a plugin in the manifest.
    pub async fn resolve(&self, key: &str, manifest: &Path) -> AppResult<Resolution> {
        let args = [
            "resolve",
            "--",
            &self.root_arg(),
            key,
            &manifest.to_string_lossy(),
        ]
        .map(String::from);
        self.json(&args, None).await
    }

    /// Records METADATA, its title from SOURCE, inside the item's stored PDF.
    pub async fn record_metadata(
        &self,
        key: &str,
        source: TitleSource,
        metadata: &ResolvedMetadata,
    ) -> AppResult<StoredItem> {
        let mut args = vec!["metadata".to_string()];
        for author in &metadata.authors {
            args.extend(["--author".to_string(), author.clone()]);
        }
        if let Some(year) = metadata.year {
            args.extend(["--year".to_string(), year.to_string()]);
        }
        if let Some(abstract_) = &metadata.abstract_ {
            args.extend(["--abstract".to_string(), abstract_.clone()]);
        }
        args.extend(
            [
                "--",
                &self.root_arg(),
                key,
                &metadata.title,
                &source.to_string(),
            ]
            .map(String::from),
        );
        self.json(&args, None).await
    }

    /// Replaces the stored PDF with BYTES, the reader's save with its annotations; the store
    /// keeps the file unless the bytes carry the provenance embedded in it.
    pub async fn replace(&self, key: &str, bytes: &[u8]) -> AppResult<ReplaceOutcome> {
        let args = ["replace", "--", &self.root_arg(), key, "/dev/stdin"].map(String::from);
        self.json(&args, Some(bytes)).await
    }

    /// Moves the stored PDF and its extraction to the desktop trash.
    pub async fn remove(&self, key: &str) -> AppResult<Removal> {
        let args = ["remove", "--", &self.root_arg(), key].map(String::from);
        let removal: Removal = self.json(&args, None).await?;
        if *removal.key != key || removal.trashed.is_empty() {
            return Err(AppError::internal(format!(
                "the store removed {} instead of {key}",
                *removal.key
            )));
        }
        Ok(removal)
    }

    /// Stores bytes re-downloaded for a missing PDF under its key with the provenance recorded
    /// at capture. The store refuses bytes that do not hash to the recorded original.
    pub async fn restore(
        &self,
        key: &str,
        bytes: &[u8],
        provenance: &Provenance,
    ) -> AppResult<CaptureResult> {
        let args = [
            "restore",
            "--",
            &self.root_arg(),
            "/dev/stdin",
            key,
            &provenance.pdf_url,
            &provenance.source_url,
            provenance.captured_at.as_str(),
            &provenance.original_sha256,
            &provenance.title_hint,
        ]
        .map(String::from);
        self.json(&args, Some(bytes)).await
    }
}
