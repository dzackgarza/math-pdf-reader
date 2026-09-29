//! Adding PDFs without the browser: from a URL (a PDF, or a page that names its PDF with the
//! Highwire `citation_pdf_url` tag, as arXiv, journals and the bucket's own reader pages do),
//! and from a folder on this computer. Every body is staged in the store's root as it arrives,
//! never held in memory.
use std::cell::RefCell;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use axum::http::StatusCode;
use lol_html::{element, text, HtmlRewriter, Settings};
use percent_encoding::percent_decode_str;
use url::Url;

use crate::contract::{ApiErrorErrorKind, AppConfigRebuild};
use crate::error::{AppError, AppResult};
use crate::store::{blocking, stage, stage_file, StageFailure, Staged, Upload};

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

impl From<NoPdf> for AppError {
    fn from(failure: NoPdf) -> Self {
        AppError::api(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorErrorKind::NoPdfAtUrl,
            failure.to_string(),
        )
    }
}

/// A URL's body, staged in the store's root, and whether the server called it an HTML page.
struct Answer {
    body: Staged,
    html: bool,
}

async fn get(url: &Url, settings: &AppConfigRebuild, root: &Path) -> AppResult<Answer> {
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
        }
        .into());
    }
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .is_some_and(|value| String::from_utf8_lossy(value.as_bytes()).contains("text/html"));
    let body = stage(root, response.bytes_stream())
        .await
        .map_err(|failure| match failure {
            StageFailure::Read(reason) => AppError::from(unreachable(reason)),
            StageFailure::Write(error) => {
                AppError::store_failed(format!("cannot stage the body of {url}: {error}"))
            }
        })?;
    Ok(Answer { body, html })
}

#[derive(Default)]
struct PageTags {
    pdf_url: String,
    citation_title: String,
    title: String,
}

// The Highwire tags and <title> of the page staged at PAGE, read in chunks with lol_html
// (Cloudflare's HTMLRewriter, the engine behind Bun's). A staged file that cannot be read is
// the outer error; HTML lol_html rejects is the inner one.
fn page_tags(url: &Url, page: &Path) -> std::io::Result<Result<PageTags, NoPdf>> {
    let tags = RefCell::new(PageTags::default());
    let unparsable = |reason| NoPdf::Unparsable {
        url: url.clone(),
        reason,
    };
    let mut rewriter = HtmlRewriter::new(
        Settings::new()
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
        |_: &[u8]| {},
    );
    let mut file = std::fs::File::open(page)?;
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if let Err(reason) = rewriter.write(&chunk[..read]) {
            return Ok(Err(unparsable(reason)));
        }
    }
    if let Err(reason) = rewriter.end() {
        return Ok(Err(unparsable(reason)));
    }
    Ok(Ok(tags.into_inner()))
}

/// The PDF at URL, or the PDF the page at URL names in its citation_pdf_url, staged in ROOT; a
/// failure says why there is none.
pub async fn find_pdf_at(url: &str, settings: &AppConfigRebuild, root: &Path) -> AppResult<Upload> {
    let page_url = Url::parse(url).map_err(|reason| NoPdf::BadUrl {
        url: url.to_string(),
        reason,
    })?;
    let answer = get(&page_url, settings, root).await?;
    if !answer.html {
        if !answer.body.is_pdf() {
            return Err(NoPdf::NotPdf { url: page_url }.into());
        }
        let filename = url_filename(&page_url);
        return Ok(Upload {
            pdf: answer.body,
            title_hint: match &filename {
                Some(name) => name.clone(),
                None => url.to_string(),
            },
            filename,
            pdf_url: url.to_string(),
        });
    }
    let (read_url, page) = (page_url.clone(), answer.body.path().to_path_buf());
    let tags = blocking(move || page_tags(&read_url, &page)).await??;
    drop(answer);
    if tags.pdf_url.is_empty() {
        return Err(NoPdf::NoCitationPdfUrl { url: page_url }.into());
    }
    let pdf_url = page_url
        .join(&tags.pdf_url)
        .map_err(|reason| NoPdf::BadUrl {
            url: tags.pdf_url.clone(),
            reason,
        })?;
    let pdf = get(&pdf_url, settings, root).await?;
    if pdf.html || !pdf.body.is_pdf() {
        return Err(NoPdf::NotPdf { url: pdf_url }.into());
    }
    // The page's citation title, else its <title>, else the PDF URL.
    let named = [tags.citation_title.trim(), tags.title.trim()]
        .into_iter()
        .find(|hint| !hint.is_empty());
    let title_hint = match named {
        Some(hint) => hint.to_string(),
        None => pdf_url.to_string(),
    };
    Ok(Upload {
        pdf: pdf.body,
        filename: url_filename(&pdf_url),
        pdf_url: pdf_url.to_string(),
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

/// The file NAME in FOLDER staged in ROOT as an upload, with `file:` URLs for its provenance:
/// the file's own URL, linked from the folder's. The error is the message the file's outcome
/// shows.
pub async fn folder_upload(root: &Path, folder: &Path, name: &str) -> Result<FolderFile, String> {
    let path = folder.join(name);
    let pdf = stage_file(root, &path)
        .await
        .map_err(|failure| match failure {
            StageFailure::Read(error) => format!("cannot read {name}: {error}"),
            StageFailure::Write(error) => format!("cannot stage {name}: {error}"),
        })?;
    if !pdf.is_pdf() {
        return Ok(FolderFile::NotPdf);
    }
    let absolute = |path: &Path| format!("{} is not an absolute path", path.display());
    let pdf_url = Url::from_file_path(&path).map_err(|()| absolute(&path))?;
    Ok(FolderFile::Pdf(Upload {
        pdf,
        title_hint: name[..name.len() - ".pdf".len()].to_string(),
        filename: Some(name.to_string()),
        pdf_url: pdf_url.to_string(),
    }))
}
