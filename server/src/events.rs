//! Server-sent events for the library: after every capture, new or existing, each open library
//! opens the item's reader in a tab (src/web/tabs.tsx), and the desktop window comes to the
//! front (desktop/src-tauri follows `open-reader`); and each new state of the index export
//! (`index-export`, the current one first), which the library's status bar shows.
use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use futures::StreamExt;
use tokio::sync::broadcast;
use tokio_stream::wrappers::{BroadcastStream, WatchStream};

use crate::config::EVENT_KEEPALIVE;
use crate::contract::OpenReader;
use crate::state::Shared;

pub struct Events {
    open_reader: broadcast::Sender<OpenReader>,
}

impl Events {
    pub fn new() -> Self {
        let (open_reader, _) = broadcast::channel(16);
        Self { open_reader }
    }

    /// Tells every open library to show the reader.
    pub fn publish_open_reader(&self, event: OpenReader) {
        match self.open_reader.send(event) {
            Ok(_windows) => {}
            // No window is listening: the capture stands, and the next window opens the library.
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

pub async fn stream(
    State(state): State<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let readers = BroadcastStream::new(state.events.open_reader.subscribe()).filter_map(
        |received| async move {
            // A subscriber that fell behind the channel skips what it missed.
            match received {
                Ok(opened) => Some(Ok(event("open-reader", &opened))),
                Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => None,
            }
        },
    );
    let exports = WatchStream::new(state.exporter.subscribe())
        .map(|exported| Ok(event("index-export", &exported)));
    Sse::new(futures::stream::select(readers, exports))
        .keep_alive(KeepAlive::new().interval(EVENT_KEEPALIVE).text("keepalive"))
}
