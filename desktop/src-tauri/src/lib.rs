mod process_config;

use std::fmt;
use std::path::PathBuf;

use pdf_bucket::config::{app_config, BucketConfig};
use pdf_bucket::contract::AppConfig;
use pdf_bucket::Serving;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// Unhide, unminimize and focus the main window: the tray's Show item and a second launch.
// Pattern: Tauri's system-tray guide (tauri-apps/tauri-docs, learn/system-tray.mdx).
fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .expect("the main window is built in setup and never destroyed");
    window.show()?;
    window.unminimize()?;
    window.set_focus()
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

fn show_failure(app: &AppHandle, page: &Url, report: &str) {
    app.get_webview_window("main")
        .expect("the main window is built in setup and never destroyed")
        .navigate(failure_page(page, report))
        .expect("the main window navigates to its own page");
    show_main_window(app).expect("the main window accepts show and focus");
}

// Why the bucket does not serve.
enum StartFailure {
    Envrc(process_config::EnvrcFailure),
    Root(PathBuf, std::io::Error),
    NoViewer(PathBuf),
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
    let port =
        u16::try_from(config.server.port.get()).expect("the configured port fits in 16 bits");
    tauri::async_runtime::block_on(pdf_bucket::serve(bucket, &host, port))
        .map_err(|error| StartFailure::Bind(format!("http://{host}:{port}"), error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // Registered first, as the plugin requires: a second launch (the desktop entry while the
        // app runs) exits before binding the bucket's port and brings back this process's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app).expect("the main window accepts show and focus");
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Closing the window hides it; the process, the bucket it serves and the tray icon stay,
        // and the tray's Quit item exits. Pattern: Tauri's `CloseRequested` + `prevent_close`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.hide().expect("the main window accepts hide");
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

            // tauri.conf.json declares the window with `create: false`; it is built here so
            // that it carries the follower script. It opens on the app's own page, whose URL is
            // where a failure report goes, and moves to the bucket once it serves.
            let mut window_config = app
                .config()
                .app
                .windows
                .first()
                .expect("tauri.conf.json declares the main window")
                .clone();
            window_config.url = WebviewUrl::App("index.html".into());
            let window = WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(follower)
                .build()?;
            let page = window.url()?;
            match started {
                Ok(serving) => {
                    window.navigate(serving.origin.parse()?)?;
                    let (handle, page) = (app.handle().clone(), page);
                    // The server runs for the life of the process; if it ever stops, say why.
                    tauri::async_runtime::spawn(async move {
                        let report = match serving.task.await {
                            Ok(Ok(())) => "The bucket's server stopped.".to_string(),
                            Ok(Err(error)) => format!("The bucket's server stopped: {error}."),
                            Err(error) => format!("The bucket's server failed: {error}."),
                        };
                        show_failure(&handle, &page, &report);
                    });
                }
                Err(failure) => window.navigate(failure_page(&page, &failure.to_string()))?,
            }

            // Linux tray icons (StatusNotifierItem through libayatana-appindicator) report no
            // clicks, so every click opens this menu.
            let show = MenuItemBuilder::with_id("show", "Show PDF Bucket").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit PDF Bucket").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(
                    app.default_window_icon()
                        .expect("tauri.conf.json bundles the app icon")
                        .clone(),
                )
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app).expect("the main window accepts show and focus")
                    }
                    "quit" => app.exit(0),
                    other => unreachable!("the tray menu has no item {other}"),
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
}
