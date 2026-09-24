//! `pdf-bucket`: the bucket server without a window, and the index export's maintenance
//! commands over the configured data root.
//!
//! - `serve <root> <zotero url> <extractions manifest> [--resolvers <manifest>] [--index-export
//!   <file>]` serves any existing bucket root on a free port and prints its origin; the test
//!   suites and evidence runs use it so that they never touch the configured bucket or its port.
//! - `export-index`, `import-index` and `rebuild-cache` take an optional export file (default:
//!   the configured one).
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use pdf_bucket::config::{self, BucketConfig, ProcessEnv};
use pdf_bucket::contract::RebuildOutcome;
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
    /// Serve an existing bucket root on a free port and print its origin.
    Serve {
        root: PathBuf,
        zotero_url: String,
        extractions_manifest: PathBuf,
        /// The identifier resolvers (default: the checkout's manifest).
        #[arg(long)]
        resolvers: Option<PathBuf>,
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

#[tokio::main]
async fn main() -> Result<ExitCode, String> {
    let fail = |error: pdf_bucket::error::AppError| format!("{error:?}");
    match Cli::parse().command {
        Command::Serve {
            root,
            zotero_url,
            extractions_manifest,
            resolvers,
            index_export,
        } => {
            if !root.is_dir() {
                return Err(format!("{} is not an existing bucket root", root.display()));
            }
            let app = config::app_config();
            let bucket = BucketConfig {
                root,
                pdfjs_dir: config::pdfjs_dir(&app),
                web_dir: config::web_dir(),
                cache_dir: config::cache_root(),
                zotero_url,
                extractions_manifest,
                resolvers_manifest: match resolvers {
                    Some(manifest) => manifest,
                    None => config::resolvers_manifest(),
                },
                index_export,
                process_env: ProcessEnv::new(),
                app: app.clone(),
            };
            let serving = pdf_bucket::serve(bucket, &app.server.host, 0)
                .await
                .map_err(|error| error.to_string())?;
            println!("{}", serving.origin);
            serving
                .task
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
            Ok(ExitCode::SUCCESS)
        }
        Command::ExportIndex { file } => {
            let file = export_file(file);
            let index = export_index(&configured_store(), &file, &Default::default())
                .await
                .map_err(fail)?;
            println!("exported {} items to {}", index.items.len(), file.display());
            Ok(ExitCode::SUCCESS)
        }
        Command::ImportIndex { file } => {
            let root = config::data_root();
            let organization = import_index(&root, &export_file(file))
                .await
                .map_err(fail)?;
            println!(
                "imported the filing of {} items into {}",
                organization.items.len(),
                root.display()
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::RebuildCache { file } => {
            let settings = config::app_config().rebuild;
            let outcomes = rebuild_cache(&configured_store(), &export_file(file), &settings)
                .await
                .map_err(fail)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&outcomes).map_err(|error| error.to_string())?
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
