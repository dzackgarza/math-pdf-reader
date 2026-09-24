//! Adding PDFs without the browser: from a URL (a PDF, or a page that names its PDF with the
//! Highwire `citation_pdf_url` tag, as arXiv, journals and the bucket's own reader pages do),
//! and from a folder on this computer.
use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;

use lol_html::{element, rewrite_str, text, RewriteStrSettings};
use percent_encoding::percent_decode_str;
use url::Url;

use crate::contract::AppConfigRebuild;
use crate::store::Upload;

pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// The name the store keys a PDF under: the URL's last path segment.
fn url_filename(url: &Url) -> String {
    let segment = url
        .path()
        .rsplit('/')
        .next()
        .expect("rsplit yields a last part");
    if segment.is_empty() {
        return "download.pdf".to_string();
    }
    percent_decode_str(segment).decode_utf8_lossy().into_owned()
}

enum Answer {
    Page(String),
    Bytes(Vec<u8>),
}

async fn get(url: &Url, settings: &AppConfigRebuild) -> Result<Answer, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.download_timeout_seconds.get()))
        .build()
        .map_err(|error| format!("{url}: {error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("{url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status().as_u16()));
    }
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .is_some_and(|value| String::from_utf8_lossy(value.as_bytes()).contains("text/html"));
    if html {
        return response
            .text()
            .await
            .map(Answer::Page)
            .map_err(|error| format!("{url}: {error}"));
    }
    response
        .bytes()
        .await
        .map(|body| Answer::Bytes(body.to_vec()))
        .map_err(|error| format!("{url}: {error}"))
}

#[derive(Default)]
struct PageTags {
    pdf_url: String,
    citation_title: String,
    title: String,
}

// The Highwire tags and <title> of a page, read with lol_html (Cloudflare's HTMLRewriter, the
// engine behind Bun's).
fn page_tags(html: &str) -> Result<PageTags, String> {
    let tags = RefCell::new(PageTags::default());
    rewrite_str(
        html,
        RewriteStrSettings::new()
            .append_element_content_handler(element!(r#"meta[name="citation_pdf_url"]"#, |meta| {
                if let Some(content) = meta.get_attribute("content") {
                    tags.borrow_mut().pdf_url = content;
                }
                Ok(())
            }))
            .append_element_content_handler(element!(r#"meta[name="citation_title"]"#, |meta| {
                if let Some(content) = meta.get_attribute("content") {
                    tags.borrow_mut().citation_title = content;
                }
                Ok(())
            }))
            .append_element_content_handler(text!("title", |chunk| {
                tags.borrow_mut().title.push_str(chunk.as_str());
                Ok(())
            })),
    )
    .map_err(|error| error.to_string())?;
    Ok(tags.into_inner())
}

/// The PDF at URL, or on the page at URL; a failure says why there is none.
pub async fn find_pdf_at(url: &str, settings: &AppConfigRebuild) -> Result<Upload, String> {
    let page_url = Url::parse(url).map_err(|error| format!("{url}: {error}"))?;
    let html = match get(&page_url, settings).await? {
        Answer::Bytes(bytes) if is_pdf(&bytes) => {
            let name = url_filename(&page_url);
            return Ok(Upload {
                bytes,
                filename: name.clone(),
                pdf_url: url.to_string(),
                source_url: url.to_string(),
                title_hint: name,
            });
        }
        Answer::Bytes(_) => return Err(format!("{url} serves no PDF")),
        Answer::Page(html) => html,
    };
    let tags = page_tags(&html)?;
    if tags.pdf_url.is_empty() {
        return Err(format!("{url} names no PDF (no citation_pdf_url)"));
    }
    let pdf_url = page_url
        .join(&tags.pdf_url)
        .map_err(|error| format!("{}: {error}", tags.pdf_url))?;
    let bytes = match get(&pdf_url, settings).await? {
        Answer::Bytes(bytes) if is_pdf(&bytes) => bytes,
        _ => return Err(format!("{pdf_url} serves no PDF")),
    };
    // The page's citation title, else its <title>, else the PDF's file name.
    let named = [tags.citation_title.trim(), tags.title.trim()]
        .into_iter()
        .find(|hint| !hint.is_empty());
    let title_hint = match named {
        Some(hint) => hint.to_string(),
        None => url_filename(&pdf_url),
    };
    Ok(Upload {
        bytes,
        filename: url_filename(&pdf_url),
        pdf_url: pdf_url.to_string(),
        source_url: url.to_string(),
        title_hint,
    })
}

/// The PDFs directly inside FOLDER, by name, as uploads with `file:` URLs for provenance.
pub async fn pdfs_in_folder(folder: &Path) -> std::io::Result<Vec<Upload>> {
    let folder_url = Url::from_directory_path(folder).map_err(|()| {
        std::io::Error::other(format!("{} is not an absolute path", folder.display()))
    })?;
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(folder).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await?.is_file() && name.to_lowercase().ends_with(".pdf") {
            names.push(name);
        }
    }
    names.sort();
    let mut uploads = Vec::new();
    for name in names {
        let path = folder.join(&name);
        let bytes = tokio::fs::read(&path).await?;
        if !is_pdf(&bytes) {
            continue;
        }
        let pdf_url = Url::from_file_path(&path).map_err(|()| {
            std::io::Error::other(format!("{} is not an absolute path", path.display()))
        })?;
        uploads.push(Upload {
            bytes,
            title_hint: name[..name.len() - ".pdf".len()].to_string(),
            filename: name,
            pdf_url: pdf_url.to_string(),
            source_url: folder_url.to_string(),
        });
    }
    Ok(uploads)
}
