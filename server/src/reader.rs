//! The reader page (templates/reader.html): the prebuilt PDF.js viewer over the stored PDF, with
//! the Highwire `citation_*` tags the Zotero Connector reads.
use askama::Template;
use percent_encoding::utf8_percent_encode;

use crate::config::{READER_IDLE_MINUTES, URI_COMPONENT};
use crate::contract::{BucketItem, LibraryViewKey, Preferences, Reading, Theme, MIN_PAGE_SECONDS};

pub fn pdf_url_path(key: &str) -> String {
    format!("/pdf/{}.pdf", utf8_percent_encode(key, URI_COMPONENT))
}

pub fn reader_url_path(key: &str) -> String {
    format!("/read/{}", utf8_percent_encode(key, URI_COMPONENT))
}

// PDF.js's SidebarView values (web/ui_utils.js): NONE, OUTLINE.
fn sidebar_view(outline_on_open: bool) -> u8 {
    if outline_on_open {
        2
    } else {
        0
    }
}

// PDF.js's viewerCssTheme values (web/app_options.js): automatic, light, dark.
fn viewer_css_theme(theme: Theme) -> u8 {
    match theme {
        Theme::System => 0,
        Theme::Light => 1,
        Theme::Dark => 2,
    }
}

#[derive(Template)]
#[template(path = "reader.html")]
struct ReaderPage {
    theme: String,
    sidebar_view: u8,
    viewer_css_theme: u8,
    title: String,
    authors: Vec<String>,
    origin: String,
    pdf_path: String,
    /// The URL from which the captured PDF came.
    pdf_url: String,
    /// The page the PDF was linked from, when one is known.
    source_url: Option<String>,
    key: String,
    library_view_key: String,
    idle_minutes: u32,
    min_page_seconds: f64,
    item_path: String,
    /// The view the reader opens at when its address names none: the page last viewed.
    resume_hash: String,
    viewer: String,
}

pub fn reader_page(item: &BucketItem, origin: &str, preferences: &Preferences) -> String {
    let pdf_path = pdf_url_path(&item.id);
    let resume_hash = match &item.reading {
        Reading::Viewed { page, .. } => format!("#page={page}"),
        Reading::Unread => String::new(),
    };
    ReaderPage {
        theme: preferences.theme.to_string(),
        sidebar_view: sidebar_view(preferences.outline_on_open),
        viewer_css_theme: viewer_css_theme(preferences.theme),
        title: item.title.to_string(),
        authors: item
            .authors
            .iter()
            .map(|author| author.to_string())
            .collect(),
        origin: origin.to_string(),
        viewer: format!(
            "/pdfjs/web/viewer.html?file={}",
            utf8_percent_encode(&pdf_path, URI_COMPONENT)
        ),
        pdf_path,
        pdf_url: item.provenance.pdf_url.clone(),
        source_url: item.provenance.source_url.clone(),
        key: item.id.to_string(),
        library_view_key: LibraryViewKey::PdfBucketLibraryView.to_string(),
        idle_minutes: READER_IDLE_MINUTES,
        min_page_seconds: MIN_PAGE_SECONDS,
        item_path: format!(
            "/api/items/{}",
            utf8_percent_encode(&item.id, URI_COMPONENT)
        ),
        resume_hash,
    }
    .render()
    .expect("the reader template renders")
}
