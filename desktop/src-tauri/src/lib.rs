mod process_config;

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use pdf_bucket::config::{app_config, BucketConfig, QUIT_SAVE_WAIT};
use pdf_bucket::contract::AppConfig;
use pdf_bucket::Serving;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, Listener, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// A failure of a window operation after startup: the process is the bucket's server too, so it
// is shown in a dialog and the app carries on.
fn report(app: &AppHandle, what: &str, error: impl fmt::Display) {
    app.dialog()
        .message(format!("{what}: {error}"))
        .title("PDF Bucket")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

// Unhide, unminimize and focus the main window: the tray's Show item and a second launch.
// Pattern: Tauri's system-tray guide (tauri-apps/tauri-docs, learn/system-tray.mdx).
fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

fn show_or_report(app: &AppHandle) {
    if let Err(error) = show_main_window(app) {
        report(app, "The window could not be shown", error);
    }
}

// The app's own page (src/index.html) with REPORT in its fragment, which the page shows, so a
// bucket that does not serve is never silent. The URL parser drops newlines from a fragment,
// so the report travels percent-encoded.
fn failure_page(page: &Url, report: &str) -> Url {
    let mut url = page.clone();
    url.set_fragment(Some(
        &utf8_percent_encode(report, NON_ALPHANUMERIC).to_string(),
    ));
    url
}

fn show_failure(app: &AppHandle, page: Option<&Url>, failure: &str) {
    let navigated = match (app.get_webview_window("main"), page) {
        (Some(window), Some(page)) => window.navigate(failure_page(page, failure)),
        (None, _) => Err(tauri::Error::WindowNotFound),
        // The app's own page never loaded, so it cannot show the report: the dialog does.
        (Some(_), None) => {
            report(app, "The bucket does not serve", failure);
            return;
        }
    };
    if let Err(error) = navigated {
        report(app, failure, error);
        return;
    }
    show_or_report(app);
}

// Why the bucket does not serve.
enum StartFailure {
    Envrc(process_config::EnvrcFailure),
    Root(PathBuf, std::io::Error),
    NoViewer(PathBuf),
    Port(u64),
    Bind(String, std::io::Error),
}

impl fmt::Display for StartFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Envrc(failure) => write!(formatter, "{failure}"),
            Self::Root(root, error) => {
                write!(
                    formatter,
                    "The bucket root {} could not be made: {error}.",
                    root.display()
                )
            }
            Self::NoViewer(viewer) => write!(
                formatter,
                "The PDF.js viewer is missing at {}; run `just fetch-pdfjs`.",
                viewer.display()
            ),
            Self::Port(port) => write!(
                formatter,
                "pdf-bucket.config.json names port {port}, which is not a TCP port."
            ),
            Self::Bind(origin, error) => {
                write!(formatter, "The bucket could not serve {origin}: {error}.")
            }
        }
    }
}

// The bucket is this process: its port is bound here, on Tauri's tokio runtime, before the
// window loads it, so the window finds a bucket that already answers.
fn start(config: &AppConfig) -> Result<Serving, StartFailure> {
    let bucket =
        BucketConfig::configured(process_config::process_env().map_err(StartFailure::Envrc)?);
    std::fs::create_dir_all(&bucket.root)
        .map_err(|error| StartFailure::Root(bucket.root.clone(), error))?;
    let viewer = bucket.pdfjs_dir.join("web/viewer.html");
    if !viewer.is_file() {
        return Err(StartFailure::NoViewer(viewer));
    }
    let host = config.server.host.to_string();
    let port = u16::try_from(config.server.port.get())
        .map_err(|_too_large| StartFailure::Port(config.server.port.get()))?;
    tauri::async_runtime::block_on(pdf_bucket::serve(bucket, &host, port))
        .map_err(|error| StartFailure::Bind(format!("http://{host}:{port}"), error))
}

// What the library answers `quit-requested` with (follow-open-events.js): every open reader
// saved its annotations, or one could not.
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum QuitSettled {
    Settled,
    Failed { message: String },
}

// Asks before quitting with work that is not saved; the window stays open unless the user
// chooses Quit.
fn ask_before_quitting(app: &AppHandle, reason: &str) {
    show_or_report(app);
    let quitting = app.clone();
    app.dialog()
        .message(format!(
            "{reason}\n\nQuit anyway? Annotations that are not saved are lost."
        ))
        .title("PDF Bucket")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".to_string(),
            "Keep open".to_string(),
        ))
        .show(move |quit| {
            if quit {
                quitting.exit(0);
            }
        });
}

// The tray's Quit: the library settles every open reader's pending saves first and answers
// `quit-settled`; the app exits then, or asks when a save failed or no answer came in time.
fn quit(app: &AppHandle) {
    let (settled, answer) = tokio::sync::oneshot::channel::<String>();
    let settled = Mutex::new(Some(settled));
    app.once("quit-settled", move |event| {
        if let Some(settled) = settled.lock().expect("never poisoned").take() {
            match settled.send(event.payload().to_string()) {
                Ok(()) => {}
                // The wait timed out and the question is already asked.
                Err(_late) => {}
            }
        }
    });
    if let Err(error) = app.emit_to("main", "quit-requested", ()) {
        ask_before_quitting(
            app,
            &format!("The open readers could not be asked to save: {error}."),
        );
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match tokio::time::timeout(QUIT_SAVE_WAIT, answer).await {
            Ok(Ok(payload)) => match serde_json::from_str::<QuitSettled>(&payload) {
                Ok(QuitSettled::Settled) => app.exit(0),
                Ok(QuitSettled::Failed { message }) => {
                    ask_before_quitting(&app, &format!("A reader could not save: {message}"));
                }
                Err(error) => ask_before_quitting(
                    &app,
                    &format!("The library answered the quit with {payload}: {error}."),
                ),
            },
            Ok(Err(_dropped)) => ask_before_quitting(&app, "The library did not answer the quit."),
            Err(_elapsed) => ask_before_quitting(
                &app,
                &format!(
                    "The open readers did not finish saving within {} seconds.",
                    QUIT_SAVE_WAIT.as_secs()
                ),
            ),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // Registered first, as the plugin requires: a second launch (the desktop entry while the
        // app runs) exits before binding the bucket's port and brings back this process's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_or_report(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Closing the window hides it; the process, the bucket it serves and the tray icon stay,
        // and the tray's Quit item exits. Pattern: Tauri's `CloseRequested` + `prevent_close`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    report(window.app_handle(), "The window could not be hidden", error);
                }
            }
        })
        .setup(|app| {
            let config = app_config();
            let origin = format!("http://{}:{}", *config.server.host, config.server.port);
            // The follower script calls these window commands from the bucket's pages.
            app.add_capability(
                CapabilityBuilder::new("bucket-window-follow")
                    .remote(origin.clone())
                    .window("main")
                    .permission("core:window:allow-show")
                    .permission("core:window:allow-set-focus")
                    .permission("core:window:allow-unminimize")
                    // Quit: the follower hears `quit-requested` and answers `quit-settled`.
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten")
                    .permission("core:event:allow-emit")
                    // The library's Open in Browser and Show in Folder (@tauri-apps/plugin-opener):
                    // http(s) URLs in the default browser, files in the file manager.
                    .permission("opener:default")
                    // Add Folder's Browse button: the system folder chooser.
                    .permission("dialog:allow-open"),
            )?;
            // The file is one function expression statement; binding it in a block keeps the
            // call valid whatever the statement's terminator.
            let follower = format!(
                "{{ const followOpenEvents = {}\nfollowOpenEvents({}); }}",
                include_str!("follow-open-events.js"),
                serde_json::to_string(&origin)?
            );

            let started = start(&config);
            let serving = started.is_ok();

            // tauri.conf.json declares the window with `create: false`; it is built here so
            // that it carries the follower script. It opens on the app's own page, whose URL is
            // where a failure report goes, and goes on once that page has loaded: to the bucket,
            // or to the page with the reason the bucket does not serve. A navigation made
            // before the first load finishes can lose to that load.
            let pending = Mutex::new(Some(match &started {
                Ok(serving) => Ok(serving.origin.parse::<Url>()?),
                Err(failure) => Err(failure.to_string()),
            }));
            let page = Arc::new(OnceLock::<Url>::new());
            let loaded = Arc::clone(&page);
            let mut window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or(tauri::Error::WindowNotFound)?
                .clone();
            window_config.url = WebviewUrl::App("index.html".into());
            // A link that asks for a new window (a PDF's external link in a reader tab, a
            // source page on the Timeline) opens in the default browser; the window keeps its
            // tabs.
            let opener = app.handle().clone();
            WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(follower)
                .on_new_window(move |url, _features| {
                    if let Err(error) = opener.opener().open_url(url.as_str(), None::<&str>) {
                        report(&opener, &format!("{url} could not be opened"), error);
                    }
                    NewWindowResponse::Deny
                })
                .on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    let Some(destination) = pending.lock().expect("never poisoned").take() else {
                        return;
                    };
                    let own_page = payload.url().clone();
                    let target = match destination {
                        Ok(origin) => origin,
                        Err(failure) => failure_page(&own_page, &failure),
                    };
                    // The first finished load is the app's own page, and `pending` is taken
                    // once, so this runs once.
                    match loaded.set(own_page) {
                        Ok(()) => {}
                        Err(_set_before) => unreachable!("the app's own page loads first, once"),
                    }
                    if let Err(error) = window.navigate(target.clone()) {
                        report(
                            window.app_handle(),
                            &format!("The window could not open {target}"),
                            error,
                        );
                    }
                })
                .build()?;
            if let Ok(serving) = started {
                let handle = app.handle().clone();
                // The server runs for the life of the process; if it ever stops, say why.
                tauri::async_runtime::spawn(async move {
                    let failure = match serving.task.await {
                        Ok(Ok(())) => "The bucket's server stopped.".to_string(),
                        Ok(Err(error)) => format!("The bucket's server stopped: {error}."),
                        Err(error) => format!("The bucket's server failed: {error}."),
                    };
                    show_failure(&handle, page.get(), &failure);
                });
            }

            // Linux tray icons (StatusNotifierItem through libayatana-appindicator) report no
            // clicks, so every click opens this menu.
            let show = MenuItemBuilder::with_id("show", "Show PDF Bucket").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit PDF Bucket").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit_item)
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(
                    app.default_window_icon()
                        .expect("tauri.conf.json bundles the app icon")
                        .clone(),
                )
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => show_or_report(app),
                    // A bucket that does not serve has no library, so no reader to wait for.
                    "quit" if serving => quit(app),
                    "quit" => app.exit(0),
                    other => report(app, "The tray menu has no item", other),
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
}
