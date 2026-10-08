//! The Zotero local write API: the endpoints the local-write-api addon adds to Zotero's own
//! HTTP server (`GET /version`, its health check; `POST /write` with an `operation`;
//! `POST /attach`). The send action is the only caller that writes to Zotero; Retrieve metadata
//! only asks it to resolve a URL, which saves nothing. Every action checks Zotero's health
//! first, then waits for Zotero's answer as long as Zotero takes, as the Zotero Connector does.
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

/// What `GET /version` answers when the write API runs.
#[derive(Deserialize)]
struct Version {
    healthy: bool,
    version: NonEmpty,
    message: String,
    capabilities: Vec<String>,
}

/// The capability of a write API whose `import_from_url` takes `store_attachments`. The send
/// attaches the bucket's own copy, so the import must store no PDF of its own.
const IMPORT_STORE_ATTACHMENTS: &str = "import_store_attachments";

#[derive(Deserialize)]
struct Refusal {
    operation: String,
    error: String,
}

/// The item `import_from_url` made or found. `existing`: the library already held the work.
#[derive(Deserialize)]
pub struct Imported {
    pub item_key: String,
    pub existing: bool,
    pub method: ImportMethod,
}

/// A CSL-JSON name: a person's parts, or an institution's name as one literal.
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

/// A CSL-JSON date part: Zotero writes the year as a string, the month and day as numbers.
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

/// The CSL-JSON fields of a resolved item that the bucket records.
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

/// The answer `resolve_url` gives when no method identified the source (422).
#[derive(Deserialize)]
struct Unidentified {
    stage: String,
    details: UnidentifiedDetails,
}

/// What `resolve_url` made of a URL: the method that identified it and the item's CSL-JSON,
/// or each method's attempt when none identified it.
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
struct NoteAttached {
    note_key: String,
}

/// update_item_fields merges the fields into the item's API JSON, where Zotero reads a
/// date-time only in the API's ISO 8601 UTC form `YYYY-MM-DDTHH:MM:SSZ` and drops any other.
pub fn zotero_date_time(timestamp: &crate::contract::Timestamp) -> String {
    timestamp.instant().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A plain-text bucket note as the HTML a Zotero note holds: special characters escaped, a
/// blank line starts a paragraph, a single line break stays a line break; the paragraph and
/// line-break rules of Zotero's own `Zotero.Utilities.text2html(str, false)` (zotero/utilities,
/// utilities.js).
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
    /// Must run on a tokio runtime: the health check repeats on a task started here.
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

    /// Asks the write API's health check whether Zotero can take a request, and publishes the
    /// answer when it differs from the last one.
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
            }) if capabilities.iter().any(|name| name == IMPORT_STORE_ATTACHMENTS) => {
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

    /// Fails with `zotero_unavailable` unless the health check finds Zotero ready.
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

    /// Sends the request and answers its status and body.
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

    /// Sends the request and parses a 2xx answer as `T`. Any other status is Zotero's
    /// failure: the addon's JSON refusal when it gave one, otherwise the status and body.
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

    /// The item for the source at `url`: the write API identifies the source by its own
    /// methods, and answers the library's item for that work when it already holds one. A new
    /// item gets no attachment: the send attaches the bucket's copy.
    pub async fn import_from_url(&self, url: &str) -> AppResult<Imported> {
        let body = json!({ "operation": "import_from_url", "url": url, "store_attachments": false });
        self.post("/write", &body).await
    }

    /// The metadata Zotero's methods resolve for the source at `url`, without saving an item.
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

    /// Stores the bytes as a standalone attachment, with no parent item, in the collection
    /// selected in Zotero (the library root when none is); answers the attachment's key.
    pub async fn attach_standalone(
        &self,
        file_name: &str,
        title: &str,
        bytes: &[u8],
    ) -> AppResult<String> {
        let body = json!({
            "title": title,
            "file_name": file_name,
            "file_bytes_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        Ok(self
            .post::<Attached>("/attach", &body)
            .await?
            .attachment_key)
    }

    /// Adds a child note holding `html` to the item; answers the note's key.
    pub async fn attach_note(&self, item_key: &str, html: &str) -> AppResult<String> {
        let body = json!({
            "operation": "attach_note",
            "parent_item_key": item_key,
            "note_text": html,
        });
        Ok(self.post::<NoteAttached>("/write", &body).await?.note_key)
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
