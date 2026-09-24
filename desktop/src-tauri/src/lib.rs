use serde::Deserialize;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // Registered first, as the plugin requires: a second launch (the desktop entry while the
        // unit's window runs) exits and brings back this process's window instead.
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
            // that it loads the bucket origin, under `tauri dev` and as the built binary alike,
            // and carries the follower script.
            for window in &app.config().app.windows {
                let mut window = window.clone();
                window.url = WebviewUrl::External(origin.parse()?);
                WebviewWindowBuilder::from_config(app.handle(), &window)?
                    .initialization_script(follower.clone())
                    .build()?;
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
