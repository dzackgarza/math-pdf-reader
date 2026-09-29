//! Where the bucket's settings come from: pdf-bucket.config.json (compiled in), the runtime
//! files (the PDF.js viewer, the library bundle, the plugin manifest and the Python environment)
//! under the checkout this binary was built from or under the installed app's own copy of them,
//! the XDG directories, and the tunables below.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};

use crate::contract::AppConfig;

/// The checkout the binary was built from.
pub const CHECKOUT: &str = env!("PDF_BUCKET_CHECKOUT");

const CONFIG_JSON: &str = include_str!("../../pdf-bucket.config.json");

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A comment line this often on the event stream shows a quiet stream is alive and lets the
/// server drop a subscriber whose window went away.
pub const EVENT_KEEPALIVE: Duration = Duration::from_secs(5);

/// How often the server asks Zotero's health check whether Zotero runs with its local write API,
/// for the library's status bar; every Zotero action also checks first.
pub const ZOTERO_CHECK_INTERVAL: Duration = Duration::from_secs(5);

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

/// The installed app's copy of the runtime files, in the checkout's layout, which
/// `just provision` writes (scripts/provision.sh): the installed binary runs against the files
/// it was built with, whatever the checkout later holds.
pub fn installed() -> PathBuf {
    xdg_data_home().join("pdf-bucket-app")
}

/// The prebuilt PDF.js viewer under RUNTIME, unpacked from the pinned release by
/// `just fetch-pdfjs`.
pub fn pdfjs_dir(runtime: &Path, config: &AppConfig) -> PathBuf {
    runtime
        .join("vendor")
        .join(format!("pdfjs-{}", *config.pdfjs.version))
}

/// The library UI bundle under RUNTIME, built by `just build-web`.
pub fn web_dir(runtime: &Path) -> PathBuf {
    runtime.join("dist/web")
}

/// The capture extensions under RUNTIME, which `just provision` writes: the Chrome build
/// (`chrome-mv3`, which Chromium loads unpacked), the Firefox build (`firefox-mv2`) and that build
/// as addons.mozilla.org signed it (`firefox.xpi`), which Firefox installs from the bucket.
pub fn extensions_dir(runtime: &Path) -> PathBuf {
    runtime.join("extensions")
}

pub fn extractions_manifest(runtime: &Path) -> PathBuf {
    runtime.join("plugins/manifests/extractions.json")
}

/// The Python environment under RUNTIME, whose bin directory holds `pdfbucket` and the
/// extraction plugins' entry points: the checkout's is `uv sync --locked`; the installed app's
/// is a wheel of the package with the locked dependencies.
pub fn python_bin(runtime: &Path) -> PathBuf {
    runtime.join(".venv/bin")
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
    /// The index export the server rewrites after every change.
    pub index_export: PathBuf,
    /// The capture extension builds the bucket offers (config::extensions_dir).
    pub extensions_dir: PathBuf,
    /// The bin directory of the Python environment the store's commands and the plugins run
    /// from.
    pub python_bin: PathBuf,
    pub app: AppConfig,
    pub process_env: ProcessEnv,
}

impl BucketConfig {
    /// The installed app's bucket: the XDG data root, the configured Zotero, the installed
    /// runtime files.
    pub fn configured(process_env: ProcessEnv) -> Self {
        let app = app_config();
        let runtime = installed();
        Self {
            root: data_root(),
            pdfjs_dir: pdfjs_dir(&runtime, &app),
            web_dir: web_dir(&runtime),
            cache_dir: cache_root(),
            zotero_url: app.zotero.url.clone(),
            extractions_manifest: extractions_manifest(&runtime),
            index_export: index_export_file(),
            extensions_dir: extensions_dir(&runtime),
            python_bin: python_bin(&runtime),
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

/// Minutes without input after which the reader stops counting time as reading.
pub const READER_IDLE_MINUTES: u32 = 10;
