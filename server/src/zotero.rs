use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use base64::Engine;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;
use url::Url;

use crate::config::ZOTERO_CHECK_INTERVAL;
use crate::contract::{
    ApiErrorErrorKind, ImportMethod, NonEmpty, RetrieveMetadataOutcomeUnidentifiedAttemptsItem,
    ZoteroHealth,
};
use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
struct Version {
    healthy: bool,
    version: NonEmpty,
    message: String,
    capabilities: Vec<String>,
}

const IMPORT_STORE_ATTACHMENTS: &str = "import_store_attachments";

#[derive(Deserialize)]
struct Selected {
    details: SelectedDetails,
}

#[derive(Deserialize)]
struct SelectedDetails {
    collection_key: String,
}

#[derive(Deserialize)]
struct Refusal {
    operation: String,
    error: String,
}

#[derive(Deserialize)]
pub struct Imported {
    pub item_key: String,
    pub existing: bool,
    pub method: ImportMethod,
}

#[derive(Deserialize)]
pub struct CslName {
    pub given: Option<String>,
    pub family: Option<String>,
    #[serde(rename = "dropping-particle")]
    pub dropping_particle: Option<String>,
    #[serde(rename = "non-dropping-particle")]
    pub non_dropping_particle: Option<String>,
    pub suffix: Option<String>,
    pub literal: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum CslDatePart {
    Number(i64),
    Text(String),
}

#[derive(Deserialize)]
pub struct CslDate {
    #[serde(rename = "date-parts")]
    pub date_parts: Vec<Vec<CslDatePart>>,
}

#[derive(Deserialize)]
pub struct Csl {
    pub title: Option<String>,
    #[serde(default)]
    pub author: Vec<CslName>,
    pub issued: Option<CslDate>,
    #[serde(rename = "abstract")]
    pub abstract_: Option<String>,
}

#[derive(Deserialize)]
struct Resolved {
    method: ImportMethod,
    csl: Csl,
}

#[derive(Deserialize)]
struct UnidentifiedDetails {
    attempts: Vec<RetrieveMetadataOutcomeUnidentifiedAttemptsItem>,
}

#[derive(Deserialize)]
struct Unidentified {
    stage: String,
    details: UnidentifiedDetails,
}

pub enum Resolution {
    Resolved {
        method: ImportMethod,
        csl: Csl,
    },
    Unidentified {
        attempts: Vec<RetrieveMetadataOutcomeUnidentifiedAttemptsItem>,
    },
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
pub struct StandaloneAttached {
    pub attachment_key: String,
    pub details: StandaloneDetails,
}

#[derive(Deserialize)]
pub struct StandaloneDetails {
    pub collection_key: Option<String>,
}

#[derive(Deserialize)]
struct NoteAttached {
    note_key: String,
}

#[derive(Deserialize)]
struct Trashed {
    details: UpdatedItem,
}

#[derive(Deserialize)]
struct Child {
    key: String,
    data: ChildData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildData {
    item_type: String,
    content_type: Option<String>,
}

pub fn zotero_date_time(timestamp: &crate::contract::Timestamp) -> String {
    timestamp.instant().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn note_html(text: &str) -> String {
    let escaped = html_escape::encode_text(text);
    let paragraphs: Vec<String> = escaped
        .split("\n\n")
        .map(|paragraph| format!("<p>{}</p>", paragraph.replace('\n', "<br/>")))
        .collect();
    paragraphs.concat()
}

fn refused(what: &str, status: StatusCode, answer: &[u8]) -> AppError {
    AppError::Zotero(match serde_json::from_slice::<Refusal>(answer) {
        Ok(refusal) => format!(
            "Zotero refused {} ({status}): {}",
            refusal.operation, refusal.error
        ),
        Err(_not_a_refusal) => format!(
            "Zotero answered {status} to {what}: {}",
            String::from_utf8_lossy(answer).trim()
        ),
    })
}

fn parsed<T: DeserializeOwned>(what: &str, answer: &[u8]) -> AppResult<T> {
    serde_json::from_slice(answer).map_err(|error| {
        AppError::Zotero(format!(
            "Zotero's answer to {what} is not what it documents: {error}"
        ))
    })
}

fn unavailable(message: String) -> ZoteroHealth {
    ZoteroHealth::Unavailable {
        message: message.try_into().expect("the message names what failed"),
    }
}

pub struct ZoteroWriteApi {
    base: Url,
    client: reqwest::Client,
    health: watch::Sender<ZoteroHealth>,
}

impl ZoteroWriteApi {
    pub fn start(base_url: &str) -> Arc<Self> {
        let (health, _) = watch::channel(ZoteroHealth::Checking);
        let zotero = Arc::new(Self {
            base: Url::parse(base_url).expect("the configured Zotero URL is a URL"),
            client: reqwest::Client::new(),
            health,
        });
        let checking = Arc::clone(&zotero);
        tokio::spawn(async move {
            loop {
                checking.check().await;
                tokio::time::sleep(ZOTERO_CHECK_INTERVAL).await;
            }
        });
        zotero
    }

    pub fn subscribe(&self) -> watch::Receiver<ZoteroHealth> {
        self.health.subscribe()
    }

    pub async fn check(&self) -> ZoteroHealth {
        let health = match self.client.get(self.url("/version")).send().await {
            Err(error) if error.is_connect() => {
                unavailable("Zotero is not running: start Zotero".to_string())
            }
            Err(error) => unavailable(self.unanswered(error).message().to_string()),
            Ok(response) => self.health_of(response).await,
        };
        self.health.send_if_modified(|published| {
            let changed = *published != health;
            *published = health.clone();
            changed
        });
        health
    }

    async fn health_of(&self, response: Response) -> ZoteroHealth {
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return unavailable("Zotero lacks the local write API addon".to_string());
        }
        let answer = match response.bytes().await {
            Ok(answer) => answer,
            Err(error) => return unavailable(self.unanswered(error).message().to_string()),
        };
        if !status.is_success() {
            return unavailable(
                refused("its health check", status, &answer)
                    .message()
                    .to_string(),
            );
        }
        match parsed::<Version>("its health check", &answer) {
            Err(error) => unavailable(error.message().to_string()),
            Ok(Version {
                healthy: true,
                version,
                capabilities,
                ..
            }) if capabilities
                .iter()
                .any(|name| name == IMPORT_STORE_ATTACHMENTS) =>
            {
                ZoteroHealth::Ready { version }
            }
            Ok(Version {
                healthy: true,
                version,
                ..
            }) => unavailable(format!(
                "Zotero's local write API {} lacks {IMPORT_STORE_ATTACHMENTS}: update the addon",
                version.as_str()
            )),
            Ok(Version { message, .. }) => unavailable(format!(
                "Zotero's local write API reports it is not healthy: {message}"
            )),
        }
    }

    pub async fn require_ready(&self) -> AppResult<()> {
        match self.check().await {
            ZoteroHealth::Unavailable { message } => Err(AppError::api(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorErrorKind::ZoteroUnavailable,
                message.to_string(),
            )),
            ZoteroHealth::Ready { .. } | ZoteroHealth::Checking => Ok(()),
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

    async fn exchange(&self, request: RequestBuilder) -> AppResult<(StatusCode, Bytes)> {
        let response: Response = request
            .send()
            .await
            .map_err(|error| self.unanswered(error))?;
        let status = response.status();
        let answer = response
            .bytes()
            .await
            .map_err(|error| self.unanswered(error))?;
        Ok((status, answer))
    }

    async fn answer<T: DeserializeOwned>(
        &self,
        what: &str,
        request: RequestBuilder,
    ) -> AppResult<T> {
        let (status, answer) = self.exchange(request).await?;
        if !status.is_success() {
            return Err(refused(what, status, &answer));
        }
        parsed(what, &answer)
    }

    async fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> AppResult<T> {
        self.answer(path, self.client.post(self.url(path)).json(body))
            .await
    }

    pub async fn import_from_url(
        &self,
        url: &str,
        collection: Option<&str>,
    ) -> AppResult<Imported> {
        let body = json!({
            "operation": "import_from_url",
            "url": url,
            "store_attachments": false,
            "collection_keys": collection.into_iter().collect::<Vec<_>>(),
        });
        self.post("/write", &body).await
    }

    pub async fn selected_collection(&self) -> AppResult<Option<String>> {
        let what = "get_selected_collection";
        let body = json!({ "operation": what });
        let (status, answer) = self
            .exchange(self.client.post(self.url("/write")).json(&body))
            .await?;
        if status.is_success() {
            let selected: Selected = parsed(what, &answer)?;
            return Ok(Some(selected.details.collection_key));
        }
        if status == StatusCode::NOT_FOUND && serde_json::from_slice::<Refusal>(&answer).is_ok() {
            return Ok(None);
        }
        Err(refused(what, status, &answer))
    }

    pub async fn resolve_url(&self, url: &str) -> AppResult<Resolution> {
        let what = "resolve_url";
        let body = json!({ "operation": what, "url": url });
        let (status, answer) = self
            .exchange(self.client.post(self.url("/write")).json(&body))
            .await?;
        if status.is_success() {
            let resolved: Resolved = parsed(what, &answer)?;
            return Ok(Resolution::Resolved {
                method: resolved.method,
                csl: resolved.csl,
            });
        }
        if status == StatusCode::UNPROCESSABLE_ENTITY {
            if let Ok(unidentified) = serde_json::from_slice::<Unidentified>(&answer) {
                if unidentified.stage == "identify_source" {
                    return Ok(Resolution::Unidentified {
                        attempts: unidentified.details.attempts,
                    });
                }
            }
        }
        Err(refused(what, status, &answer))
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

    pub async fn attach_standalone(
        &self,
        file_name: &str,
        title: &str,
        bytes: &[u8],
    ) -> AppResult<StandaloneAttached> {
        let body = json!({
            "title": title,
            "file_name": file_name,
            "file_bytes_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        self.post("/attach", &body).await
    }

    pub async fn attach_note(&self, item_key: &str, html: &str) -> AppResult<String> {
        let body = json!({
            "operation": "attach_note",
            "parent_item_key": item_key,
            "note_text": html,
        });
        Ok(self.post::<NoteAttached>("/write", &body).await?.note_key)
    }

    pub async fn trash_item(&self, item_key: &str) -> AppResult<()> {
        let body = json!({ "operation": "trash_item", "item_key": item_key });
        let trashed: Trashed = self.post("/write", &body).await?;
        if trashed.details.item_key != item_key {
            return Err(AppError::Zotero(format!(
                "Zotero trashed {} where {item_key} was asked for",
                trashed.details.item_key
            )));
        }
        Ok(())
    }

    async fn read(&self, path: &str) -> AppResult<Response> {
        let response = self
            .client
            .get(self.url(path))
            .send()
            .await
            .map_err(|error| self.unanswered(error))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let answer = response
            .bytes()
            .await
            .map_err(|error| self.unanswered(error))?;
        Err(refused(path, status, &answer))
    }

    pub async fn pdfs(&self, item_key: &str) -> AppResult<Vec<String>> {
        let path = format!("/api/users/0/items/{item_key}/children");
        let answer = self
            .read(&path)
            .await?
            .bytes()
            .await
            .map_err(|error| self.unanswered(error))?;
        let children: Vec<Child> = parsed(&path, &answer)?;
        Ok(children
            .into_iter()
            .filter(|child| {
                child.data.item_type == "attachment"
                    && child.data.content_type.as_deref() == Some("application/pdf")
            })
            .map(|child| child.key)
            .collect())
    }

    pub async fn annotation_items(&self, attachment_key: &str) -> AppResult<u64> {
        let path = format!("/api/users/0/items/{attachment_key}/children?itemType=annotation");
        let response = self.read(&path).await?;
        let total = response.headers().get("Total-Results").ok_or_else(|| {
            AppError::Zotero(format!("Zotero answered {path} with no Total-Results"))
        })?;
        total
            .to_str()
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| {
                AppError::Zotero(format!(
                    "Zotero answered {path} with Total-Results {total:?}"
                ))
            })
    }

    pub async fn attachment_file(&self, attachment_key: &str) -> AppResult<PathBuf> {
        let path = format!("/api/users/0/items/{attachment_key}/file/view/url");
        let answer = self
            .read(&path)
            .await?
            .text()
            .await
            .map_err(|error| self.unanswered(error))?;
        Url::parse(answer.trim())
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| {
                AppError::Zotero(format!(
                    "Zotero answered {path} with {answer:?}, no file URL"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::note_html;

    #[test]
    fn a_note_keeps_its_paragraphs_and_line_breaks_and_escapes_markup() {
        assert_eq!(
            note_html("Lemma 2 <needs> a & b\nsee p. 4\n\nCheck the sign."),
            "<p>Lemma 2 &lt;needs&gt; a &amp; b<br/>see p. 4</p><p>Check the sign.</p>"
        );
    }
}
