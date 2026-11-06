//! The app's log: what the window's renderer, its GTK window and the page did, kept on disk.
//!
//! [`record`] sends the process's stderr through a pipe that copies every line to the original
//! stderr (the systemd journal, when systemd started the app) and, with a local timestamp, to a
//! file in `$XDG_STATE_HOME/pdf-bucket/logs`. WebKit's web and network processes inherit fd 2,
//! so their own warnings land in the same file. The journal on this machine is size-capped and
//! shared with everything else; the file keeps one run's lines for as long as [`KEPT_RUNS`]
//! allows. Pattern: the `dup2(2)` stderr redirection that `nix::unistd::dup2_stderr` documents.
//!
//! [`attach`] logs, each as one `diag:` line: WebKit's web-process termination and
//! responsiveness, failed loads, the webview's and the window's map, unmap, size, scale and
//! window state, system suspend and resume (logind's `PrepareForSleep`), and frame probes.
//! A probe evaluates `__bucketDiagnostics.probe` (diagnostics.js) in the page, every
//! [`PROBE_EVERY`] and after each resume, and logs the page's two answers or their absence.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gtk::prelude::*;
use gtk::{gio, glib};
use serde::Deserialize;
use tauri::{Listener, WebviewWindow};
use webkit2gtk::{SettingsExt, WebViewExt};

/// The number of runs whose log files are kept; older ones are deleted at startup.
const KEPT_RUNS: usize = 30;
/// How often a frame probe runs while the app is up.
const PROBE_EVERY: Duration = Duration::from_secs(300);
/// How long a probe waits for the page's answers before logging their absence.
const PROBE_WAIT: Duration = Duration::from_secs(5);

macro_rules! diag {
    ($($arg:tt)*) => { eprintln!("diag: {}", format_args!($($arg)*)) };
}

fn log_dir() -> io::Result<PathBuf> {
    let state = match std::env::var_os("XDG_STATE_HOME") {
        Some(state) if !state.is_empty() => PathBuf::from(state),
        _ => std::env::home_dir()
            .ok_or_else(|| io::Error::other("HOME is not set"))?
            .join(".local/state"),
    };
    Ok(state.join("pdf-bucket/logs"))
}

// Delete all but the newest KEPT_RUNS - 1 run logs, leaving room for this run's.
fn prune(dir: &PathBuf) -> io::Result<()> {
    let mut runs = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    runs.retain(|path| path.extension().is_some_and(|extension| extension == "log"));
    // Names start with the run's RFC 3339 start time, so name order is time order.
    runs.sort();
    let surplus = runs.len().saturating_sub(KEPT_RUNS - 1);
    for old in &runs[..surplus] {
        fs::remove_file(old)?;
    }
    Ok(())
}

fn timestamp() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// Copy the process's stderr, and its children's, to this run's log file. Returns the file's
/// path. Call before anything else writes to stderr or starts a child process.
pub fn record() -> io::Result<PathBuf> {
    let dir = log_dir()?;
    fs::create_dir_all(&dir)?;
    prune(&dir)?;
    let path = dir.join(format!("{}-{}.log", timestamp(), std::process::id()));
    let mut file = File::create_new(&path)?;
    let mut console = File::from(nix::unistd::dup(io::stderr())?);
    let (reader, writer) = io::pipe()?;
    nix::unistd::dup2_stderr(&writer)?;
    drop(writer);
    std::thread::Builder::new()
        .name("log".into())
        .spawn(move || {
            for line in BufReader::new(reader).split(b'\n') {
                // fd 2 is this pipe: a lost line could be reported nowhere, so it aborts.
                let line = line.expect("the stderr pipe is readable");
                console
                    .write_all(&[line.as_slice(), b"\n"].concat())
                    .expect("the original stderr is writable");
                writeln!(file, "{} {}", timestamp(), String::from_utf8_lossy(&line))
                    .expect("the log file is writable");
            }
        })?;
    diag!(
        "start pid={} log={} env={:?}",
        std::process::id(),
        path.display(),
        std::env::vars()
            .filter(|(name, _)| ["WEBKIT_", "GDK_", "GSK_", "WAYLAND_", "XDG_SESSION", "LIBGL_", "MESA_"]
                .iter()
                .any(|prefix| name.starts_with(prefix)))
            .collect::<Vec<_>>()
    );
    Ok(path)
}

/// A `diag-page` event from diagnostics.js; only the fields the probe bookkeeping reads.
#[derive(Deserialize)]
struct PageReport {
    kind: String,
    id: Option<u64>,
}

/// The ids of the newest probe asked and the newest one each answer arrived for.
#[derive(Default)]
struct Probes {
    asked: AtomicU64,
    answered: AtomicU64,
    framed: AtomicU64,
}

fn widget_state(name: &str, widget: &impl IsA<gtk::Widget>) -> String {
    let allocation = widget.allocation();
    format!(
        "{name}: mapped={} visible={} realized={} size={}x{} scale={}",
        widget.is_mapped(),
        widget.is_visible(),
        widget.is_realized(),
        allocation.width(),
        allocation.height(),
        widget.scale_factor()
    )
}

fn probe(window: &WebviewWindow, webview: &webkit2gtk::WebView, probes: &Arc<Probes>, why: &str) {
    let id = probes.asked.fetch_add(1, Ordering::SeqCst) + 1;
    let toplevel = webview.toplevel();
    diag!(
        "probe {id} ({why}): web process responsive={}; {}; {}",
        webview.is_web_process_responsive(),
        widget_state("webview", webview),
        toplevel.map_or_else(|| "no toplevel".to_string(), |top| widget_state("window", &top))
    );
    if let Err(error) = window.eval(format!("window.__bucketDiagnostics?.probe({id})")) {
        diag!("probe {id}: could not be sent to the page: {error}");
    }
    let probes = Arc::clone(probes);
    glib::timeout_add_local_once(PROBE_WAIT, move || {
        let answered = probes.answered.load(Ordering::SeqCst) >= id;
        let framed = probes.framed.load(Ordering::SeqCst) >= id;
        if !(answered && framed) {
            diag!(
                "probe {id}: after {}s the page answered={answered} drew a frame={framed}",
                PROBE_WAIT.as_secs()
            );
        }
    });
}

/// Log the renderer's, the window's and the page's state for the main window.
pub fn attach(window: &WebviewWindow) -> tauri::Result<()> {
    let probes = Arc::new(Probes::default());
    let listening = Arc::clone(&probes);
    window.listen("diag-page", move |event| {
        let payload = event.payload();
        diag!("page {payload}");
        match serde_json::from_str::<PageReport>(payload) {
            Ok(PageReport { kind, id: Some(id) }) if kind == "probe" => {
                listening.answered.fetch_max(id, Ordering::SeqCst);
            }
            Ok(PageReport { kind, id: Some(id) }) if kind == "frame" => {
                listening.framed.fetch_max(id, Ordering::SeqCst);
            }
            Ok(_) => {}
            Err(error) => diag!("page report not understood: {error}"),
        }
    });
    let main = window.clone();
    // Signal handlers run on GTK's main thread, which owns the webview.
    let installed = Mutex::new(Some(probes));
    window.with_webview(move |platform| {
        let Some(probes) = installed.lock().expect("never poisoned").take() else {
            return;
        };
        let webview = platform.inner();
        diag!(
            "webkit hardware acceleration policy={:?}",
            WebViewExt::settings(&webview).map(|settings| settings.hardware_acceleration_policy())
        );
        webview.connect_web_process_terminated(|_, reason| {
            diag!("web process terminated: {reason:?}");
        });
        webview.connect_is_web_process_responsive_notify(|webview| {
            diag!("web process responsive={}", webview.is_web_process_responsive());
        });
        webview.connect_load_failed(|_, event, uri, error| {
            diag!("load failed at {event:?} for {uri}: {error}");
            false
        });
        webview.connect_map(|widget| diag!("{}", widget_state("webview map", widget)));
        webview.connect_unmap(|widget| diag!("{}", widget_state("webview unmap", widget)));
        let last_size = std::cell::Cell::new((0, 0));
        webview.connect_size_allocate(move |_, allocation| {
            let size = (allocation.width(), allocation.height());
            if size != last_size.replace(size) {
                diag!("webview size={}x{}", size.0, size.1);
            }
        });
        webview.connect_scale_factor_notify(|widget| {
            diag!("webview scale={}", widget.scale_factor());
        });
        if let Some(toplevel) = webview.toplevel() {
            toplevel.connect_map(|widget| diag!("{}", widget_state("window map", widget)));
            toplevel.connect_unmap(|widget| diag!("{}", widget_state("window unmap", widget)));
            toplevel.connect_window_state_event(|_, event| {
                diag!("window state={:?}", event.new_window_state());
                glib::Propagation::Proceed
            });
        }

        let resumed = (main.clone(), webview.clone(), Arc::clone(&probes));
        let system = match gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE) {
            Ok(system) => {
                system.signal_subscribe(
                    Some("org.freedesktop.login1"),
                    Some("org.freedesktop.login1.Manager"),
                    Some("PrepareForSleep"),
                    Some("/org/freedesktop/login1"),
                    None,
                    gio::DBusSignalFlags::NONE,
                    move |_, _, _, _, _, parameters| {
                        let Some((sleeping,)) = parameters.get::<(bool,)>() else {
                            diag!("PrepareForSleep with parameters {parameters}");
                            return;
                        };
                        if sleeping {
                            diag!("system suspending");
                            return;
                        }
                        diag!("system resumed");
                        let (window, webview, probes) = &resumed;
                        for (after, why) in [(0, "resume"), (2, "resume+2s"), (15, "resume+15s")] {
                            let (window, webview, probes) =
                                (window.clone(), webview.clone(), Arc::clone(probes));
                            glib::timeout_add_local_once(Duration::from_secs(after), move || {
                                probe(&window, &webview, &probes, why);
                            });
                        }
                    },
                );
                Some(system)
            }
            Err(error) => {
                diag!("suspend and resume are not logged: the system bus is unreachable: {error}");
                None
            }
        };
        // The resume subscription lives as long as its connection, which this timer, running
        // for the life of the process, holds.
        glib::timeout_add_local(PROBE_EVERY, move || {
            let _subscribed = &system;
            probe(&main, &webview, &probes, "periodic");
            glib::ControlFlow::Continue
        });
    })
}

/// One `diag:` line for a window event.
pub fn window_event(event: &tauri::WindowEvent) {
    diag!("window event {event:?}");
}
