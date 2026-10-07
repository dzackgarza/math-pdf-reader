//! The reader page (templates/reader.html): the head the Zotero Connector reads, with the
//! Highwire `citation_*` tags, over the reader the web bundle mounts (src/web/reader/main.tsx).
use askama::Template;
use percent_encoding::utf8_percent_encode;

use crate::config::URI_COMPONENT;
use crate::contract::{BucketItem, Preferences};

pub fn pdf_url_path(key: &str) -> String {
    format!("/pdf/{}.pdf", utf8_percent_encode(key, URI_COMPONENT))
}

pub fn reader_url_path(key: &str) -> String {
    format!("/read/{}", utf8_percent_encode(key, URI_COMPONENT))
}

#[derive(Template)]
#[template(path = "reader.html")]
struct ReaderPage {
    theme: String,
    title: String,
    authors: Vec<String>,
    origin: String,
    pdf_path: String,
    key: String,
}

pub fn reader_page(item: &BucketItem, origin: &str, preferences: &Preferences) -> String {
    ReaderPage {
        theme: preferences.theme.to_string(),
        title: item.title.to_string(),
        authors: item
            .authors
            .iter()
            .map(|author| author.to_string())
            .collect(),
        origin: origin.to_string(),
        pdf_path: pdf_url_path(&item.id),
        key: item.id.to_string(),
    }
    .render()
    .expect("the reader template renders")
}
