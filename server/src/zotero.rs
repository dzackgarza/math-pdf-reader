//! The Zotero local write API: the endpoints the local-write-api addon adds to Zotero's own
//! HTTP server (`POST /write` with an `operation`, `POST /attach`), plus the read of Zotero's
//! local API (`/api/users/0/...`) that a send needs. The send action is the only caller;
//! nothing else in the bucket writes to Zotero.
use std::time::Duration;

use base64::Engine;
use reqwest::{RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::error::{AppError, AppResult};

/// Zotero answers on loopback, so a connection that takes longer is a Zotero that is down.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// An identifier import runs Zotero's translator against the publisher's site, and an attach
/// carries a whole PDF; either may take this long before Zotero counts as stalled.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
/// The local API's largest page.
const PAGE: usize = 100;

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
struct NoteAttached {
    note_key: String,
}

#[derive(Deserialize)]
struct LibraryItem {
    key: String,
    data: LibraryItemData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItemData {
    item_type: String,
    #[serde(rename = "DOI")]
    doi: Option<String>,
    url: Option<String>,
    date_added: String,
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

pub struct ZoteroWriteApi {
    base: Url,
    client: reqwest::Client,
}

impl ZoteroWriteApi {
    pub fn new(base_url: &str) -> Self {
        Self {
            base: Url::parse(base_url).expect("the configured Zotero URL is a URL"),
            client: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("a reqwest client with timeouts builds"),
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

    /// Sends the request and parses a 2xx answer as `T`. Any other status is Zotero's
    /// failure: the addon's JSON refusal when it gave one, otherwise the status and body.
    async fn answer<T: DeserializeOwned>(&self, what: &str, request: RequestBuilder) -> AppResult<T> {
        let response: Response = request.send().await.map_err(|error| self.unanswered(error))?;
        let status = response.status();
        let answer = response
            .bytes()
            .await
            .map_err(|error| self.unanswered(error))?;
        if !status.is_success() {
            return Err(AppError::Zotero(match serde_json::from_slice::<Refusal>(&answer) {
                Ok(refusal) => format!(
                    "Zotero refused {} ({status}): {}",
                    refusal.operation, refusal.error
                ),
                Err(_not_a_refusal) => format!(
                    "Zotero answered {status} to {what}: {}",
                    String::from_utf8_lossy(&answer).trim()
                ),
            }));
        }
        serde_json::from_slice(&answer).map_err(|error| {
            AppError::Zotero(format!("Zotero's answer to {what} is not what it documents: {error}"))
        })
    }

    async fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> AppResult<T> {
        self.answer(path, self.client.post(self.url(path)).json(body))
            .await
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

    /// The top-level regular item (not an attachment or note) that the local API's `everything`
    /// search finds for `term` and `matches` accepts, the earliest added when the library holds
    /// several; Zotero's duplicate merge keeps the earliest too. Trashed items are left out.
    async fn item_where(
        &self,
        what: &str,
        term: &str,
        matches: impl Fn(&LibraryItemData) -> bool,
    ) -> AppResult<Option<String>> {
        let mut found: Vec<LibraryItem> = Vec::new();
        for start in (0..).step_by(PAGE) {
            let mut url = self.url("/api/users/0/items/top");
            url.query_pairs_mut().extend_pairs([
                ("q", term),
                ("qmode", "everything"),
                ("format", "json"),
                ("limit", &PAGE.to_string()),
                ("start", &start.to_string()),
            ]);
            let page: Vec<LibraryItem> = self.answer(what, self.client.get(url)).await?;
            let last = page.len() < PAGE;
            found.extend(page.into_iter().filter(|item| {
                !matches!(item.data.item_type.as_str(), "attachment" | "note") && matches(&item.data)
            }));
            if last {
                break;
            }
        }
        Ok(found
            .into_iter()
            .min_by(|a, b| a.data.date_added.cmp(&b.data.date_added))
            .map(|item| item.key))
    }

    /// The item whose DOI is `doi`; DOIs compare without case.
    pub async fn item_with_doi(&self, doi: &str) -> AppResult<Option<String>> {
        self.item_where("a search by DOI", doi, |data| {
            data.doi
                .as_deref()
                .is_some_and(|found| found.eq_ignore_ascii_case(doi))
        })
        .await
    }

    /// The item whose URL field is exactly `url`.
    pub async fn item_with_url(&self, url: &str) -> AppResult<Option<String>> {
        self.item_where("a search by URL", url, |data| data.url.as_deref() == Some(url))
            .await
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
