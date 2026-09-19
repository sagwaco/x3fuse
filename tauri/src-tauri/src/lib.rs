mod commands;
pub mod conversion;
mod menu;
pub mod metadata;
pub mod model;
pub mod preview;
#[cfg(debug_assertions)]
mod smoke;
pub mod storage;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, OnceLock,
    },
};
use tauri::Manager;

pub struct AppState {
    pub preferences: storage::Preferences,
    pub logs: Arc<storage::Logs>,
    pub exif: Arc<metadata::ExifTool>,
    pub previews: preview::Previews,
    pub resources: PathBuf,
    pub running: AtomicBool,
    pub cancel: Arc<AtomicBool>,
    // 0: running normally, 1: close main window after draining, 2: quit after draining.
    pub shutdown: AtomicU8,
}

static CORE_LOGS: OnceLock<Arc<storage::Logs>> = OnceLock::new();

pub fn finish_shutdown(app: &tauri::AppHandle, state: &AppState) {
    match state.shutdown.swap(0, Ordering::SeqCst) {
        2 => app.exit(0),
        1 => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        _ => {}
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(|webview, payload| {
        smoke::on_page_load(webview, payload.event());
    });
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let logs = Arc::new(storage::Logs::new(app.path().app_log_dir()?));
            let preferences =
                storage::Preferences::load(app.path().app_config_dir()?.join("settings.json"));
            logs.debug
                .store(preferences.get().debug_logging_enabled, Ordering::Relaxed);
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                app.path().resource_dir()?.join("resources")
            };
            let exif = Arc::new(metadata::ExifTool::new(
                resources.join("exiftool"),
                logs.clone(),
            ));
            tauri::async_runtime::block_on(exif.check()).map_err(std::io::Error::other)?;
            if !resources.join("opcodes").is_dir() {
                return Err(
                    std::io::Error::other("Missing opcodes; run npm run sync:resources").into(),
                );
            }
            let _ = CORE_LOGS.set(logs.clone());
            // Legacy library globals are initialized once before any conversion workers exist.
            x3f_core::set_verbosity(x3f_core::Verbosity::Debug);
            x3f_core::set_log_callback(Some(|level, message| {
                if let Some(logs) = CORE_LOGS.get() {
                    let kind = match level {
                        x3f_core::Verbosity::Error => "error",
                        x3f_core::Verbosity::Debug => "debug",
                        _ => "conversion",
                    };
                    logs.write(kind, message);
                }
            }));
            app.manage(Arc::new(AppState {
                preferences,
                logs,
                previews: preview::Previews::new(exif.clone()),
                exif,
                resources,
                running: AtomicBool::new(false),
                cancel: Arc::new(AtomicBool::new(false)),
                shutdown: AtomicU8::new(0),
            }));
            menu::install(app.handle())?;
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("x3f-preview", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<Arc<AppState>>();
                let result = match preview::protocol_path(&request.uri().to_string()) {
                    Ok((path, full)) => state.previews.get(&path, full).await,
                    Err(e) => Err(e),
                };
                let (status, bytes) = match result {
                    Ok(Some(bytes)) => (200, bytes.as_ref().clone()),
                    Ok(None) => (404, b"No preview".to_vec()),
                    Err(e) => {
                        state.logs.write("debug", format!("Preview: {e}"));
                        (400, b"Preview unavailable".to_vec())
                    }
                };
                let origin = request
                    .headers()
                    .get("origin")
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| {
                        matches!(
                            *v,
                            "tauri://localhost"
                                | "http://tauri.localhost"
                                | "https://tauri.localhost"
                                | "http://localhost:1420"
                        )
                    })
                    .unwrap_or("tauri://localhost");
                let response = tauri::http::Response::builder()
                    .status(status)
                    .header(
                        "Content-Type",
                        if status == 200 {
                            "image/jpeg"
                        } else {
                            "text/plain"
                        },
                    )
                    .header(
                        "Cache-Control",
                        preview::cache_control(&request.uri().to_string(), status),
                    )
                    .header("Access-Control-Allow-Origin", origin)
                    .body(bytes)
                    .unwrap();
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_set,
            commands::queue_add,
            commands::queue_existing_outputs,
            commands::convert_start,
            commands::convert_stop,
            commands::exif_full,
            commands::dialog_pick_files,
            commands::dialog_pick_output_dir,
            commands::shell_reveal,
            commands::window_open_settings,
            commands::logs_open,
            commands::logs_clear,
            commands::logs_sizes,
            commands::app_info,
            commands::update_check
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<Arc<AppState>>();
                    if state.running.load(Ordering::SeqCst) {
                        api.prevent_close();
                        state.shutdown.fetch_max(1, Ordering::SeqCst);
                        state.cancel.store(true, Ordering::SeqCst);
                        // The last worker may have drained between the initial check and this request.
                        if !state.running.load(Ordering::SeqCst) {
                            finish_shutdown(window.app_handle(), &state);
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize X3Fuse; check resources and platform prerequisites");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let state = app.state::<Arc<AppState>>();
            if state.running.load(Ordering::SeqCst) {
                api.prevent_exit();
                state.shutdown.store(2, Ordering::SeqCst);
                state.cancel.store(true, Ordering::SeqCst);
                if !state.running.load(Ordering::SeqCst) {
                    finish_shutdown(app, &state);
                }
            } else if cfg!(target_os = "macos") && code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } if app.get_webview_window("main").is_none() => {
            if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") {
                let _ = tauri::WebviewWindowBuilder::from_config(app, config)
                    .and_then(|builder| builder.build());
            }
        }
        _ => {}
    });
}
