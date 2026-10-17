//! Forward GTK's native tablet events to the reader in View mode.
//!
//! WebKitGTK currently exposes a pen to DOM Pointer Events as `pointerType: "mouse"` (WebKit
//! bug 204115). GDK supplies the actual device tool on native events, distinguishing the pen
//! from ordinary mouse events and distinguishing its eraser. Do not attach a GtkGestureStylus in
//! the capture phase: it can consume a tablet sequence before WebKit receives it, even when the
//! widget's later "event" handler permits propagation. Annotate requires that native stream for
//! toolbar clicks and EmbedPDF's real pointer-capture-based ink tools.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gdk, glib};
use tauri::{Emitter, Listener, Manager, WebviewWindow};

/// Decode a Lucide cursor asset with GTK's image loader, preserving its nib hotspot.
fn cursor_from_png(
    display: &gdk::Display,
    image: &[u8],
    hotspot: (i32, i32),
) -> Option<gdk::Cursor> {
    let loader = gtk::gdk_pixbuf::PixbufLoader::with_type("png").ok()?;
    loader.write(image).ok()?;
    loader.close().ok()?;
    Some(gdk::Cursor::from_pixbuf(
        display,
        &loader.pixbuf()?,
        hotspot.0,
        hotspot.1,
    ))
}

/// Observe GDK tablet events on the webview without claiming the native input sequence.
pub fn attach(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    window.with_webview(move |platform| {
        let webview = platform.inner();
        let display = webview.display();
        let pencil = cursor_from_png(&display, include_bytes!("cursors/pen.png"), (3, 32));
        let highlighter =
            cursor_from_png(&display, include_bytes!("cursors/highlighter.png"), (4, 30));
        let eraser_cursor =
            cursor_from_png(&display, include_bytes!("cursors/eraser.png"), (4, 30));
        let default_cursor = gdk::Cursor::from_name(&display, "default")
            .or_else(|| gdk::Cursor::for_display(&display, gdk::CursorType::Arrow));
        if pencil.is_none() || highlighter.is_none() || eraser_cursor.is_none() {
            eprintln!("stylus: could not load pen cursors from GTK's PNG loader");
        }
        // Only the visible reader's mode changes this state; the GTK widget remains the
        // authority on device identity and distinguishes its cursor from mouse input.
        // No PDF is open at startup. Before the active reader explicitly reports View,
        // pen clicks in the Library must be ordinary native WebKit input.
        let view_mode = Arc::new(AtomicBool::new(false));
        let mode_from_page = view_mode.clone();
        app.listen("bucket-stylus-view-mode", move |event| {
            if let Ok(view) = serde_json::from_str::<bool>(event.payload()) {
                mode_from_page.store(view, Ordering::Release);
            }
        });
        // A tablet press uses one routing path for its *whole* sequence, even if its press
        // selects Annotate (or another toolbar) before release. GTK and WebKit must never each
        // handle a different half of the same button press.
        // None outside contact; Some(true) uses the View bridge, Some(false) sends the
        // unmodified native sequence to WebKit's annotation tools.
        let stroke_route = Cell::new(None);
        let last = Cell::new((0.0, 0.0, false));
        webview.connect_event(move |webview, event| {
            let kind = match event.event_type() {
                gdk::EventType::ButtonPress => Some("pointerdown"),
                gdk::EventType::MotionNotify => Some("pointermove"),
                gdk::EventType::ButtonRelease => Some("pointerup"),
                gdk::EventType::ProximityIn => Some("pointerhover"),
                _ => None,
            };
            // A tablet grab can end a View stroke without an ordinary button-release.
            if event.event_type() == gdk::EventType::GrabBroken && stroke_route.take() == Some(true)
            {
                let (x, y, eraser) = last.get();
                if let Err(error) = app.emit_to(
                    "main",
                    "stylus-pointer",
                    serde_json::json!({ "kind": "pointercancel", "x": x, "y": y, "eraser": eraser }),
                ) {
                    eprintln!("stylus: pointercancel could not reach the reader: {error}");
                }
            }
            let Some(tool) = event.device_tool() else {
                // Leave the normal mouse pointer, I-beam and clickable hand alone. Styling
                // unrelated devices with a default GDK cursor overrides WebKit's CSS cursors.
                return glib::Propagation::Proceed;
            };
            if matches!(
                event.event_type(),
                gdk::EventType::MotionNotify
                    | gdk::EventType::ButtonPress
                    | gdk::EventType::ButtonRelease
                    | gdk::EventType::ProximityIn
                    | gdk::EventType::ProximityOut
            ) {
                if let (Some(device), Some(target)) =
                    (event.device(), event.window().or_else(|| webview.window()))
                {
                    let cursor = if event.event_type() == gdk::EventType::ProximityOut {
                        default_cursor.as_ref()
                    } else if view_mode.load(Ordering::Acquire) {
                        if tool.tool_type() == gdk::DeviceToolType::Eraser {
                            eraser_cursor.as_ref()
                        } else {
                            highlighter.as_ref()
                        }
                    } else {
                        pencil.as_ref()
                    };
                    if let Some(cursor) = cursor {
                        target.set_device_cursor(&device, cursor);
                    }
                }
            }
            let in_view = view_mode.load(Ordering::Acquire);
            let bridge = match event.event_type() {
                gdk::EventType::ButtonPress => {
                    stroke_route.set(Some(in_view));
                    in_view
                }
                gdk::EventType::ButtonRelease => stroke_route.take().unwrap_or(in_view),
                // Hover is not a highlighter stroke. Let WebKit handle its native hover,
                // hit testing and tooltips, even when the next press would use View's bridge.
                gdk::EventType::MotionNotify => stroke_route.get() == Some(true),
                _ => false,
            };
            // In editing modes, pass the *real* GDK pen event to WebKit unchanged. EmbedPDF
            // needs trusted mouse-compatible pointer events for click activation and capture.
            if bridge {
                if let (Some(kind), Some((x, y))) = (kind, event.coords()) {
                    let eraser = tool.tool_type() == gdk::DeviceToolType::Eraser;
                    last.set((x, y, eraser));
                    if let Err(error) = app.emit_to(
                        "main",
                        "stylus-pointer",
                        serde_json::json!({ "kind": kind, "x": x, "y": y, "eraser": eraser }),
                    ) {
                        eprintln!("stylus: {kind} could not reach the reader: {error}");
                    }
                }
                if matches!(
                    event.event_type(),
                    gdk::EventType::ButtonPress
                        | gdk::EventType::ButtonRelease
                        | gdk::EventType::MotionNotify
                )
                {
                    return glib::Propagation::Stop;
                }
            }
            glib::Propagation::Proceed
        });
    })
}
