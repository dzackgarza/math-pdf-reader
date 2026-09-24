mod server;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use server::{Failure, Server};
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// The bucket origin has one owner, pdf-bucket.config.json; it is read at compile time.
#[derive(Deserialize)]
struct BucketConfig {
    server: ServerConfig,
}

#[derive(Deserialize)]
struct ServerConfig {
    host: String,
    port: u16,
}

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

// Puts the failure report into the window's own page (src/index.html reads the fragment) and
// brings the window forward, so a stopped server is never silent.
fn show_failure(app: &AppHandle, page: &Url, failure: &Failure) {
    // The URL parser drops newlines from a fragment, so the report travels percent-encoded.
    let mut report = page.clone();
    report.set_fragment(Some(
        &utf8_percent_encode(&failure.0, NON_ALPHANUMERIC).to_string(),
    ));
    let window = app
        .get_webview_window("main")
        .expect("the main window is built in setup and never destroyed");
    window
        .navigate(report)
        .expect("the main window navigates to its own page");
    show_main_window(app).expect("the main window accepts show and focus");
}

// Release builds start the server and load its origin once `/status` answers. Under `tauri
// dev` the server runs from `beforeDevCommand`, which the CLI waits for before starting the app.
fn start_server(app: &AppHandle, origin: String, page: Url) -> Result<Server, Failure> {
    let stopped = Arc::new(AtomicBool::new(false));
    let on_stop = {
        let (app, page, stopped) = (app.clone(), page.clone(), Arc::clone(&stopped));
        move |failure: Failure| {
            stopped.store(true, Ordering::SeqCst);
            show_failure(&app, &page, &failure);
        }
    };
    let server = Server::start(on_stop)?;
    let app = app.clone();
    thread::spawn(move || match server::wait_until_ready(&origin, &stopped) {
        Ok(()) => app
            .get_webview_window("main")
            .expect("the main window is built in setup and never destroyed")
            .navigate(origin.parse().expect("the bucket origin is a URL"))
            .expect("the main window navigates to the bucket"),
        // A server that stopped has already reported why.
        Err(failure) if !stopped.load(Ordering::SeqCst) => show_failure(&app, &page, &failure),
        Err(_) => {}
    });
    Ok(server)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // Registered first, as the plugin requires: a second launch (the desktop entry while the
        // app runs) exits before starting a server and brings back this process's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app).expect("the main window accepts show and focus");
        }))
        .plugin(tauri_plugin_opener::init())
        // Closing the window hides it; the process, its event stream and the tray icon stay, and
        // the tray's Quit item exits. Pattern: Tauri's `CloseRequested` + `prevent_close`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.hide().expect("the main window accepts hide");
            }
        })
        .setup(|app| {
            let config: BucketConfig =
                serde_json::from_str(include_str!("../../../pdf-bucket.config.json"))?;
            let origin = format!("http://{}:{}", config.server.host, config.server.port);
            // The follower script calls these window commands from the bucket's pages.
            app.add_capability(
                CapabilityBuilder::new("bucket-window-follow")
                    .remote(origin.clone())
                    .window("main")
                    .permission("core:window:allow-show")
                    .permission("core:window:allow-set-focus")
                    .permission("core:window:allow-unminimize"),
            )?;
            // The file is one function expression statement; binding it in a block keeps the
            // call valid whatever the statement's terminator.
            let follower = format!(
                "{{ const followOpenEvents = {}\nfollowOpenEvents({}); }}",
                include_str!("follow-open-events.js"),
                serde_json::to_string(&origin)?
            );
            // tauri.conf.json declares the window with `create: false`; it is built here so
            // that it carries the follower script, and loads the bucket origin under `tauri dev`
            // or the app's own page while the release build starts the server.
            let mut config = app
                .config()
                .app
                .windows
                .first()
                .expect("tauri.conf.json declares the main window")
                .clone();
            config.url = if tauri::is_dev() {
                WebviewUrl::External(origin.parse()?)
            } else {
                WebviewUrl::App("index.html".into())
            };
            let window = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(follower)
                .build()?;
            if !tauri::is_dev() {
                let page = window.url()?;
                match start_server(app.handle(), origin, page.clone()) {
                    Ok(server) => {
                        app.manage(server);
                    }
                    Err(failure) => show_failure(app.handle(), &page, &failure),
                }
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
        .build(tauri::generate_context!())?
        .run(|app, event| {
            // Tray Quit and every other orderly exit stop the server with the app.
            if let RunEvent::Exit = event {
                if let Some(server) = app.try_state::<Server>() {
                    server.stop();
                }
            }
        });
    Ok(())
}
