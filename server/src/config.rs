//! Where the bucket's settings come from: pdf-bucket.config.json (compiled in), the checkout
//! this binary was built from (the PDF.js viewer, the library bundle and the plugin manifests
//! live there), the installed Python environment, the XDG directories, and the tunables below.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;

use crate::contract::AppConfig;

/// The checkout the binary was built from.
pub const CHECKOUT: &str = env!("PDF_BUCKET_CHECKOUT");

const CONFIG_JSON: &str = include_str!("../../pdf-bucket.config.json");

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A comment line this often on the event stream shows a quiet stream is alive and lets the
/// server drop a subscriber whose window went away.
pub const EVENT_KEEPALIVE: Duration = Duration::from_secs(5);

/// How long the desktop app's Quit waits for the open readers to save their annotations before
/// it asks whether to quit anyway.
pub const QUIT_SAVE_WAIT: Duration = Duration::from_secs(30);

/// Filing changes kept per bucket, newest last.
pub const ACTIVITY_KEPT: usize = 500;

/// Thumbnail renders at once: each is a store process, and a grid of new items asks for many.
pub const THUMBNAIL_RENDERS: usize = 2;

/// The longest name a file system allows for one path component (Linux NAME_MAX).
pub const NAME_MAX: usize = 255;

/// The suffix of a stored item's extraction directory, the longest suffix a key's files carry.
pub const EXTRACTION_SUFFIX: &str = ".extraction";

/// Bytes a key may take, so every file named after it fits NAME_MAX.
pub const MAX_KEY_BYTES: usize = NAME_MAX - EXTRACTION_SUFFIX.len();

/// Hex digits of the original SHA-256 that tell apart two PDFs offered under one name.
pub const KEY_HASH_PREFIX: usize = 12;

/// Bytes at the start of a file within which a PDF's `%PDF-` header may begin (ISO 32000-2,
/// 7.5.2, and the implementation note that readers accept it there).
pub const PDF_HEADER_WINDOW: usize = 1024;

/// What an extraction plugin writes in its output directory: the Markdown, and optionally a
/// directory of further artifacts.
pub const EXTRACTION_MARKDOWN: &str = "extraction.md";
pub const EXTRACTION_ARTIFACTS: &str = "artifacts";

/// Exit status of a `pdfbucket` command that could not read its PDF (src/pdfbucket/cli.py).
pub const STORE_REFUSED_EXIT: i32 = 3;

/// Widths a thumbnail may be asked for, in pixels.
pub const THUMBNAIL_WIDTHS: std::ops::RangeInclusive<u32> = 16..=2000;

pub fn app_config() -> AppConfig {
    serde_json::from_str(CONFIG_JSON).expect("pdf-bucket.config.json matches its schema")
}

pub fn checkout() -> PathBuf {
    Path::new(CHECKOUT).to_path_buf()
}

/// The prebuilt PDF.js viewer, unpacked from the pinned release by `just fetch-pdfjs`.
pub fn pdfjs_dir(config: &AppConfig) -> PathBuf {
    checkout()
        .join("vendor")
        .join(format!("pdfjs-{}", *config.pdfjs.version))
}

/// The library UI bundle, built by `just build-web`.
pub fn web_dir() -> PathBuf {
    checkout().join("dist/web")
}

pub fn extractions_manifest() -> PathBuf {
    checkout().join("plugins/manifests/extractions.json")
}

pub fn resolvers_manifest() -> PathBuf {
    checkout().join("plugins/manifests/resolvers.json")
}

/// The checkout's Python environment (`uv sync --locked`), whose bin directory holds
/// `pdfbucket` and the extraction plugins' entry points: what `pdf-bucket serve` and the
/// maintenance commands run.
pub fn checkout_python_bin() -> PathBuf {
    checkout().join(".venv/bin")
}

/// The installed app's own Python environment, which `just provision` builds from a wheel of
/// the package; switching the checkout's branch leaves it as installed.
pub fn app_python_bin() -> PathBuf {
    xdg_data_home().join("pdf-bucket-app/venv/bin")
}

/// Permanent data (stored PDFs, the filing) lives in the XDG data directory:
/// $XDG_DATA_HOME/pdf-bucket, which is ~/.local/share/pdf-bucket when XDG_DATA_HOME is unset.
pub fn data_root() -> PathBuf {
    xdg_data_home().join("pdf-bucket")
}

/// The index export is permanent user data too, kept beside the data root rather than in it,
/// so that wiping or losing the store leaves the export that rebuilds it.
pub fn index_export_file() -> PathBuf {
    xdg_data_home().join("pdf-bucket-export/index.json")
}

/// Derived files the app can always make again (first-page thumbnails) live in the XDG cache
/// directory: $XDG_CACHE_HOME/pdf-bucket, which is ~/.cache/pdf-bucket when it is unset.
pub fn cache_root() -> PathBuf {
    dirs::cache_dir()
        .expect("the XDG cache directory is known: XDG_CACHE_HOME or HOME is set")
        .join("pdf-bucket")
}

fn xdg_data_home() -> PathBuf {
    dirs::data_dir().expect("the XDG data directory is known: XDG_DATA_HOME or HOME is set")
}

/// Changes to the environment of the commands the bucket runs (the store, the plugins): a
/// value sets a variable, `None` removes it. The desktop app fills it from the checkout's
/// `.envrc`, which carries the extraction providers' keys.
pub type ProcessEnv = HashMap<String, Option<String>>;

/// One bucket served over one root.
#[derive(Clone, Debug)]
pub struct BucketConfig {
    pub root: PathBuf,
    pub pdfjs_dir: PathBuf,
    pub web_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Zotero's local HTTP server, which carries the write API the send action uses.
    pub zotero_url: String,
    pub extractions_manifest: PathBuf,
    pub resolvers_manifest: PathBuf,
    /// The index export the server rewrites after every change.
    pub index_export: PathBuf,
    /// The bin directory of the Python environment the store's commands and the plugins run
    /// from.
    pub python_bin: PathBuf,
    pub app: AppConfig,
    pub process_env: ProcessEnv,
}

impl BucketConfig {
    /// The configured bucket: the XDG data root, the configured Zotero, the checkout's plugins.
    pub fn configured(process_env: ProcessEnv) -> Self {
        let app = app_config();
        Self {
            root: data_root(),
            pdfjs_dir: pdfjs_dir(&app),
            web_dir: web_dir(),
            cache_dir: cache_root(),
            zotero_url: app.zotero.url.clone(),
            extractions_manifest: extractions_manifest(),
            resolvers_manifest: resolvers_manifest(),
            index_export: index_export_file(),
            python_bin: app_python_bin(),
            app,
            process_env,
        }
    }
}

/// The characters JavaScript's `encodeURIComponent` leaves as they are, so the PDF and reader
/// paths the server writes match the ones the library builds.
pub const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// The three rewrites that take an arXiv id out of an identifier the arXiv resolver accepts.
pub static ARXIV_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^arxiv:").expect("a valid pattern"));
pub static ARXIV_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^https?://arxiv\.org/(?:abs|pdf)/").expect("a valid pattern")
});
pub static PDF_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.pdf$").expect("a valid pattern"));

/// Minutes without input after which the reader stops counting time as reading.
pub const READER_IDLE_MINUTES: u32 = 10;
