//! Server-sent events for the desktop window: after every capture, new or existing, the window
//! moves to the item's reader page (desktop/src-tauri follows `open-reader`).
use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::config::EVENT_KEEPALIVE;
use crate::state::Shared;

#[derive(Clone, Serialize)]
pub struct OpenReader {
    pub reader_url: String,
}

pub struct Events {
    open_reader: broadcast::Sender<OpenReader>,
}

impl Events {
    pub fn new() -> Self {
        let (open_reader, _) = broadcast::channel(16);
        Self { open_reader }
    }

    /// Tells every open window to show the reader.
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

pub async fn stream(
    State(state): State<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let events = BroadcastStream::new(state.events.open_reader.subscribe()).filter_map(
        |received| async move {
            // A subscriber that fell behind the channel skips what it missed.
            let event = match received {
                Ok(event) => event,
                Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => {
                    return None
                }
            };
            let data = serde_json::to_string(&event).expect("an event serializes");
            Some(Ok(Event::default().event("open-reader").data(data)))
        },
    );
    Sse::new(events).keep_alive(KeepAlive::new().interval(EVENT_KEEPALIVE).text("keepalive"))
}
