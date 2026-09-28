//! Server-sent events for the library: after every capture, new or existing, each open library
//! opens the item's reader in a tab (src/web/tabs.tsx), and the desktop window comes to the
//! front (desktop/src-tauri follows `open-reader`); the outcome of each Retrieve metadata a new
//! PDF runs in the background (`metadata`); and each new state of the index export
//! (`index-export`) and of Zotero's health (`zotero`), the current ones first, which the
//! library's status bar shows.
use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use futures::StreamExt;
use tokio::sync::broadcast;
use tokio_stream::wrappers::{BroadcastStream, WatchStream};

use crate::config::EVENT_KEEPALIVE;
use crate::contract::{MetadataEvent, OpenReader};
use crate::state::Shared;

pub struct Events {
    open_reader: broadcast::Sender<OpenReader>,
    metadata: broadcast::Sender<MetadataEvent>,
}

impl Events {
    pub fn new() -> Self {
        let (open_reader, _) = broadcast::channel(16);
        let (metadata, _) = broadcast::channel(64);
        Self {
            open_reader,
            metadata,
        }
    }

    /// Tells every open library to show the reader.
    pub fn publish_open_reader(&self, event: OpenReader) {
        match self.open_reader.send(event) {
            Ok(_windows) => {}
            // No window is listening: the capture stands, and the next window opens the library.
            Err(broadcast::error::SendError(_unheard)) => {}
        }
    }

    /// Tells every open library the outcome of a background Retrieve metadata.
    pub fn publish_metadata(&self, event: MetadataEvent) {
        match self.metadata.send(event) {
            Ok(_windows) => {}
            // No window is listening: the outcome is already recorded in the item.
            Err(broadcast::error::SendError(_unheard)) => {}
        }
    }
}

impl Default for Events {
    fn default() -> Self {
        Self::new()
    }
}

fn event(name: &str, data: &impl serde::Serialize) -> Event {
    Event::default()
        .event(name)
        .data(serde_json::to_string(data).expect("an event serializes"))
}

fn broadcast<T: serde::Serialize + Clone + Send + 'static>(
    name: &'static str,
    sender: &broadcast::Sender<T>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    BroadcastStream::new(sender.subscribe()).filter_map(move |received| async move {
        // A subscriber that fell behind the channel skips what it missed.
        match received {
            Ok(sent) => Some(Ok(event(name, &sent))),
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => None,
        }
    })
}

pub async fn stream(
    State(state): State<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let readers = broadcast("open-reader", &state.events.open_reader);
    let metadata = broadcast("metadata", &state.events.metadata);
    let exports = WatchStream::new(state.exporter.subscribe())
        .map(|exported| Ok(event("index-export", &exported)));
    let zotero =
        WatchStream::new(state.zotero.subscribe()).map(|health| Ok(event("zotero", &health)));
    Sse::new(futures::stream::select_all([
        readers.boxed(),
        metadata.boxed(),
        exports.boxed(),
        zotero.boxed(),
    ]))
    .keep_alive(KeepAlive::new().interval(EVENT_KEEPALIVE).text("keepalive"))
}
