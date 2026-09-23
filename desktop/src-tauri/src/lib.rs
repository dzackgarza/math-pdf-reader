use serde::Deserialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, WebviewWindowBuilder};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config: BucketConfig =
                serde_json::from_str(include_str!("../../../pdf-bucket.config.json"))?;
            let origin = format!("http://{}:{}", config.server.host, config.server.port);
            // The follower script calls these two window commands from the bucket's pages.
            app.add_capability(
                CapabilityBuilder::new("bucket-window-follow")
                    .remote(origin.clone())
                    .window("main")
                    .permission("core:window:allow-set-focus")
                    .permission("core:window:allow-unminimize"),
            )?;
            let follower = format!(
                "({})({});",
                include_str!("follow-open-events.js"),
                serde_json::to_string(&origin)?
            );
            // tauri.conf.json declares the window with `create: false`; it is built here so
            // that it carries the follower script.
            for window in &app.config().app.windows {
                WebviewWindowBuilder::from_config(app.handle(), window)?
                    .initialization_script(follower.clone())
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
}
