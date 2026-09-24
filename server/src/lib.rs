//! The PDF Bucket server: capture, the PDF and reader URLs, the library API and the index
//! export, served by the desktop app in its own process and by `pdf-bucket serve` for tests and
//! evidence runs.
pub mod app;
pub mod config;
pub mod contract;
pub mod error;
pub mod events;
pub mod export;
pub mod extractions;
pub mod imports;
pub mod index;
pub mod library;
pub mod organization;
pub mod reader;
pub mod send;
pub mod sessions;
pub mod source_routes;
pub mod sources;
pub mod state;
pub mod store;
pub mod thumbnails;
pub mod titles;
pub mod zotero;

use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::config::BucketConfig;
use crate::state::AppState;

/// A bucket serving on a bound port.
pub struct Serving {
    pub origin: String,
    pub task: JoinHandle<std::io::Result<()>>,
}

/// Binds HOST:PORT (port 0 picks a free one) and serves the bucket on the current runtime. The
/// port is bound before this returns, so a caller that loads the origin next finds it answering.
pub async fn serve(config: BucketConfig, host: &str, port: u16) -> std::io::Result<Serving> {
    tokio::fs::create_dir_all(&config.root).await?;
    let listener = TcpListener::bind((host, port)).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let router = app::router(AppState::new(config));
    let task = tokio::spawn(async move { axum::serve(listener, router).await });
    Ok(Serving { origin, task })
}
