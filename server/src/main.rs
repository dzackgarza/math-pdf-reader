//! `pdf-bucket`: the bucket server without a window, and the index export's maintenance
//! commands over the configured data root.
//!
//! - `serve <root> <zotero url> <extractions manifest> <resolvers manifest> --index-export
//!   <file> --config <file>` serves any bucket root on a free port, prints its origin and
//!   serves until its standard input closes; the test suites and evidence runs use it so that
//!   they never touch the configured bucket or its port. The config file has the schema of
//!   pdf-bucket.config.json and sets the time limits and the other tunables in place of the
//!   compiled-in copy, so a test can run the server with short limits.
//! - `export-index`, `import-index`, `rebuild-cache` and `forget` take an optional export file
//!   (default: the configured one).
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use pdf_bucket::config::{self, BucketConfig, ProcessEnv};
use pdf_bucket::contract::{from_json, AppConfig, ContractViolation, RebuildOutcome};
use pdf_bucket::error::AppError;
use pdf_bucket::export::{
    export_index, forget_missing, import_index, rebuild_cache, BucketDocuments, ExportOutcome,
};
use pdf_bucket::index::LibraryIndex;
use pdf_bucket::organization::OrganizationStore;
use pdf_bucket::python::Python;
use pdf_bucket::sessions::SessionStore;
use pdf_bucket::store::Store;
use tokio::sync::Notify;

#[derive(Parser)]
#[command(name = "pdf-bucket", version, about = "The PDF Bucket server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve a bucket root on a free port and print its origin, until standard input closes.
    Serve {
        root: PathBuf,
        zotero_url: String,
        extractions_manifest: PathBuf,
        resolvers_manifest: PathBuf,
        /// Rewrite this index export after every change.
        #[arg(long)]
        index_export: PathBuf,
        /// The app config (the schema of pdf-bucket.config.json) this server runs with.
        #[arg(long)]
        config: PathBuf,
    },
    /// Write the index export: every stored item's provenance and filing.
    ExportIndex { file: Option<PathBuf> },
    /// Restore the filing and reading sessions from an index export into a data root whose
    /// filing document holds no filing.
    ImportIndex { file: Option<PathBuf> },
    /// Re-download every PDF the index export lists and the data root lacks.
    RebuildCache { file: Option<PathBuf> },
    /// Forget an item the index export lists whose PDF the data root lost: drop its filing and
    /// write the export without it.
    Forget { key: String, file: Option<PathBuf> },
}

fn export_file(file: Option<PathBuf>) -> PathBuf {
    match file {
        Some(file) => file,
        None => config::index_export_file(),
    }
}

/// The store over the configured data root, running the checkout's Python environment.
fn configured_store() -> Store {
    Store::new(
        config::data_root(),
        Python::new(
            config::checkout_python_bin(),
            ProcessEnv::new(),
            Duration::from_secs(config::app_config().store.command_timeout_seconds.get()),
        ),
    )
}

/// The configured data root's documents; nothing in this process listens for their changes.
struct Documents {
    index: LibraryIndex,
    organizations: OrganizationStore,
    sessions: SessionStore,
}

impl Documents {
    async fn configured() -> Result<Self, Failure> {
        let store = configured_store();
        tokio::fs::create_dir_all(store.root()).await?;
        let unheard = Arc::new(Notify::new());
        Ok(Self {
            sessions: SessionStore::new(store.root(), Arc::clone(&unheard)),
            organizations: OrganizationStore::new(store.clone(), unheard),
            index: LibraryIndex::new(store),
        })
    }

    fn documents(&self) -> BucketDocuments<'_> {
        BucketDocuments {
            index: &self.index,
            organizations: &self.organizations,
            sessions: &self.sessions,
        }
    }
}

/// Why a command stopped; `main` prints it and exits non-zero.
enum Failure {
    Io(std::io::Error),
    Server(tokio::task::JoinError),
    Bucket(AppError),
    Json(serde_json::Error),
    Config(PathBuf, ContractViolation),
    Refused(PathBuf, Vec<String>),
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::Bucket(error)
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Server(error) => write!(formatter, "the server stopped: {error}"),
            Self::Bucket(error) => write!(formatter, "{error:?}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::Config(file, violation) => write!(formatter, "{}: {violation}", file.display()),
            Self::Refused(file, missing) => write!(
                formatter,
                "{} lists {}, which have no PDF in the store; run `just rebuild-cache`, or \
                 `pdf-bucket forget <key>` for an item removed on purpose",
                file.display(),
                missing.join(", ")
            ),
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse().command).await {
        Ok(code) => code,
        Err(failure) => {
            eprintln!("pdf-bucket: {failure}");
            ExitCode::FAILURE
        }
    }
}

async fn export(documents: &Documents, file: PathBuf) -> Result<ExitCode, Failure> {
    match export_index(&documents.documents(), &file).await? {
        ExportOutcome::Written(index) => {
            println!("exported {} items to {}", index.items.len(), file.display());
            Ok(ExitCode::SUCCESS)
        }
        ExportOutcome::Refused(missing) => Err(Failure::Refused(file, missing)),
    }
}

async fn run(command: Command) -> Result<ExitCode, Failure> {
    match command {
        Command::Serve {
            root,
            zotero_url,
            extractions_manifest,
            resolvers_manifest,
            index_export,
            config: config_file,
        } => {
            let app: AppConfig = from_json(&tokio::fs::read(&config_file).await?)
                .map_err(|violation| Failure::Config(config_file, violation))?;
            let bucket = BucketConfig {
                root,
                pdfjs_dir: config::pdfjs_dir(&app),
                web_dir: config::web_dir(),
                cache_dir: config::cache_root(),
                zotero_url,
                extractions_manifest,
                resolvers_manifest,
                index_export,
                python_bin: config::checkout_python_bin(),
                process_env: ProcessEnv::new(),
                app: app.clone(),
            };
            let serving = pdf_bucket::serve(bucket, &app.server.host, 0).await?;
            println!("{}", serving.origin);
            // Serves until its standard input closes, so a test process that dies takes its
            // servers with it.
            let (mut stdin, mut sink) = (tokio::io::stdin(), tokio::io::sink());
            let stdin_closed = tokio::io::copy(&mut stdin, &mut sink);
            tokio::select! {
                served = serving.task => served.map_err(Failure::Server)??,
                closed = stdin_closed => {
                    closed?;
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::ExportIndex { file } => {
            export(&Documents::configured().await?, export_file(file)).await
        }
        Command::ImportIndex { file } => {
            let root = config::data_root();
            let documents = Documents::configured().await?;
            let organization =
                import_index(&documents.documents(), &root, &export_file(file)).await?;
            println!(
                "imported the filing of {} items into {}",
                organization.items.len(),
                root.display()
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::RebuildCache { file } => {
            let settings = config::app_config().rebuild;
            let outcomes =
                rebuild_cache(&configured_store(), &export_file(file), &settings).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&outcomes).map_err(Failure::Json)?
            );
            let unrestored = outcomes
                .iter()
                .any(|outcome| matches!(outcome, RebuildOutcome::Unrestored { .. }));
            Ok(if unrestored {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Forget { key, file } => {
            let file = export_file(file);
            let documents = Documents::configured().await?;
            forget_missing(&documents.organizations, &file, &key).await?;
            println!("forgot {key}");
            export(&documents, file).await
        }
    }
}
