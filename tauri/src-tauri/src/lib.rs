mod commands;
pub mod conversion;
pub mod editor;
mod edits;
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
use tauri::{Emitter, Manager};

pub struct AppState {
    pub preferences: storage::Preferences,
    pub logs: Arc<storage::Logs>,
    pub exif: Arc<metadata::ExifTool>,
    pub previews: preview::Previews,
    pub editor: editor::Editor,
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
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("system-appearance")
            .on_webview_ready(|webview| {
                if let Err(error) = webview.with_webview(|platform| unsafe {
                    use objc2::{msg_send, runtime::AnyObject, sel};
                    unsafe extern "C" {
                        fn x3fuse_install_smooth_zoom(window: *mut std::ffi::c_void) -> bool;
                    }
                    // The native installer borrows this window on the main thread.
                    if !x3fuse_install_smooth_zoom(platform.ns_window()) {
                        eprintln!("Could not enable smooth macOS window zoom");
                    }
                    // WebKit gates -apple-visual-effect behind this private preference.
                    // with_webview runs on the main thread; the pointer is borrowed here only.
                    let view = &*platform.inner().cast::<AnyObject>();
                    let supported: bool =
                        msg_send![view, respondsToSelector: sel!(_setUseSystemAppearance:)];
                    if supported {
                        let _: () = msg_send![view, _setUseSystemAppearance: true];
                    }
                }) {
                    eprintln!("Could not configure macOS webview: {error}");
                }
            })
            .build(),
    );
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
                editor: editor::Editor::new(app.path().app_data_dir()?.join("edits")),
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
        .register_asynchronous_uri_scheme_protocol("x3f-edit", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<Arc<AppState>>();
                let result = state.editor.image_uri(&request.uri().to_string());
                let (status, bytes) = match result {
                    Ok(bytes) => (200, bytes.as_ref().clone()),
                    Err(error) => {
                        state
                            .logs
                            .write("debug", format!("Edited preview: {error}"));
                        (400, error.into_bytes())
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
                            "image/png"
                        } else {
                            "text/plain"
                        },
                    )
                    .header(
                        "Cache-Control",
                        if status == 200 {
                            "private, max-age=86400, immutable"
                        } else {
                            "no-store"
                        },
                    )
                    .header("Access-Control-Allow-Origin", origin)
                    .body(bytes)
                    .unwrap();
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::editor_open,
            commands::editor_render,
            commands::editor_save,
            commands::editor_load,
            commands::editor_close,
            commands::editor_cancel_render,
            commands::editor_begin_image_request,
            commands::editor_end_image_request,
            commands::editor_preview,
            commands::editor_pick_white_balance,
            commands::editor_finish_close,
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
            commands::licenses_open,
            commands::logs_clear,
            commands::logs_sizes,
            commands::app_info,
            commands::update_check
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<Arc<AppState>>();
                    if state.editor.needs_close_flush() {
                        api.prevent_close();
                        let _ = window.emit("editor:closing", serde_json::json!({"quit":false}));
                        return;
                    }
                    state.editor.cancel_preview();
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
            // Closing the last macOS window is not an application Quit.
            if state.editor.needs_close_flush() && (code.is_some() || !cfg!(target_os = "macos")) {
                api.prevent_exit();
                let _ = app.emit_to("main", "editor:closing", serde_json::json!({"quit":true}));
                return;
            }
            state.editor.cancel_preview();
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
            app.state::<Arc<AppState>>().editor.reopen();
            if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") {
                let _ = tauri::WebviewWindowBuilder::from_config(app, config)
                    .and_then(|builder| builder.build());
            }
        }
        _ => {}
    });
}
