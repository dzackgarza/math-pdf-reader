//! The Zotero local write API: the endpoints the local-write-api addon adds to Zotero's own
//! HTTP server (`POST /write` with an `operation`, `POST /attach`), plus the reads of Zotero's
//! local API (`/api/users/0/...`) that a send needs. The send action is the only caller;
//! nothing else in the bucket writes to Zotero.
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::sources::sha256;

#[derive(Deserialize)]
struct Refusal {
    operation: String,
    error: String,
}

#[derive(Deserialize)]
struct Created {
    item_key: String,
    details: CreatedCount,
}

#[derive(Deserialize)]
struct CreatedCount {
    item_count: u64,
}

impl Created {
    // One entry or one identifier makes exactly one item.
    fn one(self) -> AppResult<String> {
        if self.details.item_count != 1 {
            return Err(AppError::Zotero(format!(
                "Zotero made {} items where one was asked for",
                self.details.item_count
            )));
        }
        Ok(self.item_key)
    }
}

#[derive(Deserialize)]
struct FieldsUpdated {
    details: UpdatedItem,
}

#[derive(Deserialize)]
struct UpdatedItem {
    item_key: String,
}

#[derive(Deserialize)]
struct Attached {
    attachment_key: String,
}

#[derive(Deserialize)]
struct Child {
    key: String,
    data: ChildData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildData {
    content_type: Option<String>,
    link_mode: Option<String>,
}

/// An existing PDF attachment of an item, for the send's `pdf` step.
pub enum ExistingPdf {
    Found(String),
    Absent,
}

/// update_item_fields merges the fields into the item's API JSON, where Zotero reads a
/// date-time only in the API's ISO 8601 UTC form `YYYY-MM-DDTHH:MM:SSZ` and drops any other.
pub fn zotero_date_time(timestamp: &crate::contract::Timestamp) -> String {
    timestamp.instant().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub struct ZoteroWriteApi {
    base: Url,
    client: reqwest::Client,
}

impl ZoteroWriteApi {
    pub fn new(base_url: &str) -> Self {
        Self {
            base: Url::parse(base_url).expect("the configured Zotero URL is a URL"),
            client: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> Url {
        self.base
            .join(path)
            .expect("a Zotero API path joins its base")
    }

    fn unanswered(&self, error: reqwest::Error) -> AppError {
        AppError::Zotero(format!(
            "Zotero did not answer at {}: {error}",
            self.base.origin().ascii_serialization()
        ))
    }

    async fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> AppResult<T> {
        let response = self
            .client
            .post(self.url(path))
            .json(body)
            .send()
            .await
            .map_err(|error| self.unanswered(error))?;
        let status = response.status();
        let answer = response
            .bytes()
            .await
            .map_err(|error| self.unanswered(error))?;
        if !status.is_success() {
            let refusal: Refusal = serde_json::from_slice(&answer)?;
            return Err(AppError::Zotero(format!(
                "Zotero refused {}: {}",
                refusal.operation, refusal.error
            )));
        }
        Ok(serde_json::from_slice(&answer)?)
    }

    /// Creates one item in the library root from one BibTeX entry; answers its key.
    pub async fn import_bibtex(&self, bibtex: &str) -> AppResult<String> {
        let body = json!({ "operation": "import_bibtex", "bibtex": bibtex });
        self.post::<Created>("/write", &body).await?.one()
    }

    /// Creates one item in the library root with Zotero's own translator for the identifier
    /// (for `arXiv:<id>`, its arXiv translator, which makes a preprint); answers its key.
    pub async fn import_by_identifier(&self, identifier: &str) -> AppResult<String> {
        let body = json!({ "operation": "import_by_identifier", "identifier": identifier });
        self.post::<Created>("/write", &body).await?.one()
    }

    /// A stored PDF attachment of the item whose file hashes to `sha256`. Zotero's identifier
    /// import downloads the publisher's PDF itself (arXiv's, for a preprint); when those are
    /// the bytes the bucket captured, the send keeps that attachment instead of adding a second
    /// copy. The local API names each attachment's file with `/file/view/url`.
    pub async fn pdf_with_hash(&self, item_key: &str, sha256_hex: &str) -> AppResult<ExistingPdf> {
        let children: Vec<Child> = self
            .client
            .get(self.url(&format!(
                "/api/users/0/items/{item_key}/children?format=json"
            )))
            .send()
            .await
            .map_err(|error| self.unanswered(error))?
            .json()
            .await
            .map_err(|error| self.unanswered(error))?;
        let stored = children.into_iter().filter(|child| {
            child.data.content_type.as_deref() == Some("application/pdf")
                && child
                    .data
                    .link_mode
                    .as_deref()
                    .is_some_and(|mode| mode.starts_with("imported"))
        });
        for child in stored {
            let file_url = self
                .client
                .get(self.url(&format!("/api/users/0/items/{}/file/view/url", child.key)))
                .send()
                .await
                .map_err(|error| self.unanswered(error))?
                .text()
                .await
                .map_err(|error| self.unanswered(error))?;
            let path = Url::parse(file_url.trim())
                .map_err(AppError::internal)?
                .to_file_path()
                .map_err(|()| AppError::internal(format!("{file_url} names no local file")))?;
            if sha256(&tokio::fs::read(path).await?) == sha256_hex {
                return Ok(ExistingPdf::Found(child.key));
            }
        }
        Ok(ExistingPdf::Absent)
    }

    pub async fn set_url_and_access_date(
        &self,
        item_key: &str,
        url: &str,
        accessed_at: &crate::contract::Timestamp,
    ) -> AppResult<()> {
        let fields = json!({ "url": url, "accessDate": zotero_date_time(accessed_at) });
        let body =
            json!({ "operation": "update_item_fields", "item_key": item_key, "fields": fields });
        let updated: FieldsUpdated = self.post("/write", &body).await?;
        if updated.details.item_key != item_key {
            return Err(AppError::Zotero(format!(
                "Zotero updated {} where {item_key} was asked for",
                updated.details.item_key
            )));
        }
        Ok(())
    }

    /// Stores the bytes as a child attachment of the item; answers the attachment's key.
    pub async fn attach_bytes(
        &self,
        item_key: &str,
        file_name: &str,
        title: &str,
        bytes: &[u8],
    ) -> AppResult<String> {
        let body = json!({
            "item_key": item_key,
            "title": title,
            "file_name": file_name,
            "file_bytes_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        Ok(self
            .post::<Attached>("/attach", &body)
            .await?
            .attachment_key)
    }
}
