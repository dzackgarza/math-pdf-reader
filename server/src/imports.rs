//! Adding PDFs without the browser: from a URL (a PDF, or a page that names its PDF with the
//! Highwire `citation_pdf_url` tag, as arXiv, journals and the bucket's own reader pages do),
//! and from a folder on this computer.
use std::cell::RefCell;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use lol_html::{element, rewrite_str, text, RewriteStrSettings};
use percent_encoding::percent_decode_str;
use url::Url;

use crate::contract::AppConfigRebuild;
use crate::layout::is_pdf;
use crate::store::Upload;

/// The name a URL offers its PDF under: the URL's last path segment, or None when the path
/// ends in `/` (the store then keys the PDF by its hash).
fn url_filename(url: &Url) -> Option<String> {
    let segment = url
        .path()
        .rsplit('/')
        .next()
        .expect("rsplit yields a last part");
    (!segment.is_empty()).then(|| percent_decode_str(segment).decode_utf8_lossy().into_owned())
}

/// Why a URL gave no PDF to store; its text is the message Import URL shows.
#[derive(Debug)]
pub enum NoPdf {
    BadUrl {
        url: String,
        reason: url::ParseError,
    },
    Unreachable {
        url: Url,
        reason: reqwest::Error,
    },
    Status {
        url: Url,
        status: u16,
    },
    Unparsable {
        url: Url,
        reason: lol_html::errors::RewritingError,
    },
    NoCitationPdfUrl {
        url: Url,
    },
    NotPdf {
        url: Url,
    },
}

impl fmt::Display for NoPdf {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUrl { url, reason } => write!(formatter, "{url}: {reason}"),
            Self::Unreachable { url, reason } => write!(formatter, "{url}: {reason}"),
            Self::Status { url, status } => write!(formatter, "{url}: HTTP {status}"),
            Self::Unparsable { url, reason } => write!(formatter, "{url}: {reason}"),
            Self::NoCitationPdfUrl { url } => {
                write!(formatter, "{url} names no PDF (no citation_pdf_url)")
            }
            Self::NotPdf { url } => write!(formatter, "{url} serves no PDF"),
        }
    }
}

enum Answer {
    Page(String),
    Bytes(Vec<u8>),
}

async fn get(url: &Url, settings: &AppConfigRebuild) -> Result<Answer, NoPdf> {
    let unreachable = |reason| NoPdf::Unreachable {
        url: url.clone(),
        reason,
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.download_timeout_seconds.get()))
        .build()
        .map_err(unreachable)?;
    let response = client.get(url.clone()).send().await.map_err(unreachable)?;
    if !response.status().is_success() {
        return Err(NoPdf::Status {
            url: url.clone(),
            status: response.status().as_u16(),
        });
    }
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .is_some_and(|value| String::from_utf8_lossy(value.as_bytes()).contains("text/html"));
    if html {
        return response.text().await.map(Answer::Page).map_err(unreachable);
    }
    response
        .bytes()
        .await
        .map(|body| Answer::Bytes(body.to_vec()))
        .map_err(unreachable)
}

#[derive(Default)]
struct PageTags {
    pdf_url: String,
    citation_title: String,
    title: String,
}

// The Highwire tags and <title> of a page, read with lol_html (Cloudflare's HTMLRewriter, the
// engine behind Bun's).
fn page_tags(url: &Url, html: &str) -> Result<PageTags, NoPdf> {
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
    .map_err(|reason| NoPdf::Unparsable {
        url: url.clone(),
        reason,
    })?;
    Ok(tags.into_inner())
}

/// The PDF at URL, or on the page at URL; a failure says why there is none. A PDF URL given
/// directly has no linking page; a page's PDF was linked from that page.
pub async fn find_pdf_at(url: &str, settings: &AppConfigRebuild) -> Result<Upload, NoPdf> {
    let page_url = Url::parse(url).map_err(|reason| NoPdf::BadUrl {
        url: url.to_string(),
        reason,
    })?;
    let html = match get(&page_url, settings).await? {
        Answer::Bytes(bytes) if is_pdf(&bytes) => {
            let filename = url_filename(&page_url);
            return Ok(Upload {
                bytes,
                title_hint: match &filename {
                    Some(name) => name.clone(),
                    None => url.to_string(),
                },
                filename,
                pdf_url: url.to_string(),
                source_url: None,
            });
        }
        Answer::Bytes(_) => return Err(NoPdf::NotPdf { url: page_url }),
        Answer::Page(html) => html,
    };
    let tags = page_tags(&page_url, &html)?;
    if tags.pdf_url.is_empty() {
        return Err(NoPdf::NoCitationPdfUrl { url: page_url });
    }
    let pdf_url = page_url
        .join(&tags.pdf_url)
        .map_err(|reason| NoPdf::BadUrl {
            url: tags.pdf_url.clone(),
            reason,
        })?;
    let bytes = match get(&pdf_url, settings).await? {
        Answer::Bytes(bytes) if is_pdf(&bytes) => bytes,
        _ => return Err(NoPdf::NotPdf { url: pdf_url }),
    };
    // The page's citation title, else its <title>, else the PDF URL.
    let named = [tags.citation_title.trim(), tags.title.trim()]
        .into_iter()
        .find(|hint| !hint.is_empty());
    let title_hint = match named {
        Some(hint) => hint.to_string(),
        None => pdf_url.to_string(),
    };
    Ok(Upload {
        bytes,
        filename: url_filename(&pdf_url),
        pdf_url: pdf_url.to_string(),
        source_url: Some(url.to_string()),
        title_hint,
    })
}

/// The files directly inside FOLDER whose names end in `.pdf` (any case), in name order.
pub async fn pdf_names_in_folder(folder: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(folder).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await?.is_file() && name.to_lowercase().ends_with(".pdf") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// One file of a folder, read.
pub enum FolderFile {
    Pdf(Upload),
    /// A `.pdf` name on bytes with no PDF header.
    NotPdf,
}

/// The file NAME in FOLDER as an upload, with `file:` URLs for its provenance: the file's own
/// URL, linked from the folder's.
pub async fn folder_upload(folder: &Path, name: &str) -> std::io::Result<FolderFile> {
    let path = folder.join(name);
    let bytes = tokio::fs::read(&path).await?;
    if !is_pdf(&bytes) {
        return Ok(FolderFile::NotPdf);
    }
    let absolute =
        |path: &Path| std::io::Error::other(format!("{} is not an absolute path", path.display()));
    let pdf_url = Url::from_file_path(&path).map_err(|()| absolute(&path))?;
    let folder_url = Url::from_directory_path(folder).map_err(|()| absolute(folder))?;
    Ok(FolderFile::Pdf(Upload {
        bytes,
        title_hint: name[..name.len() - ".pdf".len()].to_string(),
        filename: Some(name.to_string()),
        pdf_url: pdf_url.to_string(),
        source_url: Some(folder_url.to_string()),
    }))
}
