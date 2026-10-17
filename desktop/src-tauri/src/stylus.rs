//! Forward GTK's native stylus gestures to the reader.
//!
//! WebKitGTK currently exposes a pen to DOM Pointer Events as `pointerType: "mouse"` (WebKit
//! bug 204115). GTK 3 already has the stylus recognizer: `GtkGestureStylus`. It distinguishes
//! pen events from ordinary mouse events even when both devices are in range. The gesture sends
//! its positions to the page; WebKit handles non-pen input normally. A pen event must not also
//! enter WebKit as a *mouse* event, or the stroke would be handled twice.

use std::cell::Cell;
use std::rc::Rc;
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

/// Attach GTK's stylus gesture recognizer to the webview widget.
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
        let view_mode = Arc::new(AtomicBool::new(true));
        let mode_from_page = view_mode.clone();
        app.listen("bucket-stylus-view-mode", move |event| {
            if let Ok(view) = serde_json::from_str::<bool>(event.payload()) {
                mode_from_page.store(view, Ordering::Release);
            }
        });
        let stylus = gtk::GestureStylus::new(&webview);
        // Recognize the pen before WebKit handles the original event as a mouse event.
        stylus.set_propagation_phase(gtk::PropagationPhase::Capture);

        let last = Rc::new(Cell::new((0.0, 0.0, false)));
        let route = view_mode.clone();
        let forward = Rc::new(move |kind: &str, x: f64, y: f64, eraser: bool| {
            // Edit modes need WebKit's *trusted* native stream: EmbedPDF's pen, shapes and ink
            // handlers use setPointerCapture, which cannot capture synthetic PointerEvents.
            // The bridge owns pen events only in View, for forced highlights and erasing.
            if !route.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = app.emit_to(
                "main",
                "stylus-pointer",
                serde_json::json!({ "kind": kind, "x": x, "y": y, "eraser": eraser }),
            ) {
                eprintln!("stylus: {kind} could not reach the reader: {error}");
            }
        });

        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_down(move |gesture, x, y| {
            let eraser = gesture
                .device_tool()
                .is_some_and(|tool| tool.tool_type() == gdk::DeviceToolType::Eraser);
            point.set((x, y, eraser));
            emit("pointerdown", x, y, eraser);
        });
        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_motion(move |gesture, x, y| {
            let eraser = gesture
                .device_tool()
                .is_some_and(|tool| tool.tool_type() == gdk::DeviceToolType::Eraser);
            point.set((x, y, eraser));
            emit("pointermove", x, y, eraser);
        });
        let emit = forward.clone();
        stylus.connect_proximity(move |gesture, x, y| {
            let eraser = gesture
                .device_tool()
                .is_some_and(|tool| tool.tool_type() == gdk::DeviceToolType::Eraser);
            emit("pointerhover", x, y, eraser);
        });
        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_up(move |gesture, x, y| {
            let eraser = gesture
                .device_tool()
                .is_some_and(|tool| tool.tool_type() == gdk::DeviceToolType::Eraser);
            point.set((x, y, eraser));
            emit("pointerup", x, y, eraser);
        });
        // GTK can cancel a gesture on a grab or focus change. Close the unfinished stroke.
        let emit = forward.clone();
        stylus.connect_cancel(move |_, _| {
            let (x, y, eraser) = last.get();
            emit("pointercancel", x, y, eraser);
        });

        // GTK's own GestureStylus recognizes events with a GdkDeviceTool. Do not deliver the
        // exact same events to WebKit as extra mouse input. A mouse/trackpad is unaffected
        // regardless of whether a stylus is also hovering.
        webview.connect_event(move |webview, event| {
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
                    // GTK's per-device cursor: View pen = highlighter, editing pen = pencil,
                    // View eraser = eraser; a mouse receives the ordinary system cursor.
                    let cursor = if event.event_type() == gdk::EventType::ProximityOut {
                        default_cursor.as_ref()
                    } else if let Some(tool) = event.device_tool() {
                        if view_mode.load(Ordering::Acquire) {
                            if tool.tool_type() == gdk::DeviceToolType::Eraser {
                                eraser_cursor.as_ref()
                            } else {
                                highlighter.as_ref()
                            }
                        } else {
                            pencil.as_ref()
                        }
                    } else {
                        default_cursor.as_ref()
                    };
                    if let Some(cursor) = cursor {
                        target.set_device_cursor(&device, cursor);
                    }
                }
            }
            if view_mode.load(Ordering::Acquire)
                && event.device_tool().is_some()
                && matches!(
                    event.event_type(),
                    gdk::EventType::ButtonPress
                        | gdk::EventType::ButtonRelease
                        | gdk::EventType::MotionNotify
                )
            {
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        // GTK 3 does not retain ownership of event controllers (GTK 4 does). Keep the
        // recognizer alive exactly as long as the webview, and drop it on finalization.
        // SAFETY: this key is assigned once on GTK's main thread, never accessed through a
        // raw pointer, and the widget's finalizer owns destruction of the attached value.
        unsafe { webview.set_data("pdf-bucket-stylus-gesture", stylus) };
    })
}
