//! Forward GTK's native stylus gestures to the reader.
//!
//! WebKitGTK currently exposes a pen to DOM Pointer Events as `pointerType: "mouse"` (WebKit
//! bug 204115). GTK 3 already has the stylus recognizer: `GtkGestureStylus`. It distinguishes
//! pen events from ordinary mouse events even when both devices are in range. The gesture sends
//! its positions to the page; WebKit handles non-pen input normally. A pen event must not also
//! enter WebKit as a *mouse* event, or the stroke would be handled twice.

use std::cell::Cell;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gdk, glib};
use tauri::{Emitter, Manager, WebviewWindow};

/// Attach GTK's stylus gesture recognizer to the webview widget.
pub fn attach(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    window.with_webview(move |platform| {
        let webview = platform.inner();
        let stylus = gtk::GestureStylus::new(&webview);
        // Recognize the pen before WebKit handles the original event as a mouse event.
        stylus.set_propagation_phase(gtk::PropagationPhase::Capture);

        let last = Rc::new(Cell::new((0.0, 0.0)));
        let forward = Rc::new(move |kind: &str, x: f64, y: f64| {
            if let Err(error) = app.emit_to(
                "main",
                "stylus-pointer",
                serde_json::json!({ "kind": kind, "x": x, "y": y }),
            ) {
                eprintln!("stylus: {kind} could not reach the reader: {error}");
            }
        });

        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_down(move |_, x, y| {
            point.set((x, y));
            emit("pointerdown", x, y);
        });
        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_motion(move |_, x, y| {
            point.set((x, y));
            emit("pointermove", x, y);
        });
        let emit = forward.clone();
        stylus.connect_proximity(move |_, x, y| emit("pointerhover", x, y));
        let emit = forward.clone();
        let point = last.clone();
        stylus.connect_up(move |_, x, y| {
            point.set((x, y));
            emit("pointerup", x, y);
        });
        // GTK can cancel a gesture on a grab or focus change. Close the unfinished stroke.
        let emit = forward.clone();
        stylus.connect_cancel(move |_, _| {
            let (x, y) = last.get();
            emit("pointercancel", x, y);
        });

        // GTK's own GestureStylus recognizes events with a GdkDeviceTool. Do not deliver the
        // exact same events to WebKit as extra mouse input. A mouse/trackpad is unaffected
        // regardless of whether a stylus is also hovering.
        webview.connect_event(|_, event| {
            if event.device_tool().is_some()
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
