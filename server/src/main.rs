//! `pdf-bucket`: the bucket server without a window, and the index export's maintenance
//! commands over the configured data root.
//!
//! - `serve <root> <zotero url> <extractions manifest> <resolvers manifest> [--index-export
//!   <file>]` serves any bucket root on a free port, prints its origin and serves until its
//!   standard input closes; the test
//!   suites and evidence runs use it so that they never touch the configured bucket or its port.
//! - `export-index`, `import-index` and `rebuild-cache` take an optional export file (default:
//!   the configured one).
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use pdf_bucket::config::{self, BucketConfig, ProcessEnv};
use pdf_bucket::contract::RebuildOutcome;
use pdf_bucket::error::AppError;
use pdf_bucket::export::{export_index, import_index, rebuild_cache};
use pdf_bucket::store::Store;

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
        index_export: Option<PathBuf>,
    },
    /// Write the index export: every stored item's provenance and filing.
    ExportIndex { file: Option<PathBuf> },
    /// Restore the filing from an index export into a data root that has none.
    ImportIndex { file: Option<PathBuf> },
    /// Re-download every PDF the index export lists and the data root lacks.
    RebuildCache { file: Option<PathBuf> },
}

fn export_file(file: Option<PathBuf>) -> PathBuf {
    match file {
        Some(file) => file,
        None => config::index_export_file(),
    }
}

fn configured_store() -> Store {
    Store::new(
        config::data_root(),
        config::store_command(),
        ProcessEnv::new(),
    )
}

/// Why a command stopped; `main` prints it and exits non-zero.
enum Failure {
    Io(std::io::Error),
    Server(tokio::task::JoinError),
    Bucket(AppError),
    Json(serde_json::Error),
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

async fn run(command: Command) -> Result<ExitCode, Failure> {
    match command {
        Command::Serve {
            root,
            zotero_url,
            extractions_manifest,
            resolvers_manifest,
            index_export,
        } => {
            let app = config::app_config();
            let bucket = BucketConfig {
                root,
                pdfjs_dir: config::pdfjs_dir(&app),
                web_dir: config::web_dir(),
                cache_dir: config::cache_root(),
                zotero_url,
                extractions_manifest,
                resolvers_manifest,
                index_export,
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
            let file = export_file(file);
            let index = export_index(&configured_store(), &file, &BTreeSet::new()).await?;
            println!("exported {} items to {}", index.items.len(), file.display());
            Ok(ExitCode::SUCCESS)
        }
        Command::ImportIndex { file } => {
            let root = config::data_root();
            let organization = import_index(&root, &export_file(file)).await?;
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
    }
}
