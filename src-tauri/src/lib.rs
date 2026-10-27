pub mod cache;
mod commands;
pub mod conversion;
mod culling;
pub mod editor;
mod edits;
mod menu;
pub mod metadata;
pub mod model;
pub mod preview;
#[cfg(debug_assertions)]
mod smoke;
pub mod source;
pub mod storage;
mod updater;
mod x3i;

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, OnceLock,
    },
};
use tauri::{Emitter, Manager, WebviewWindow};

pub struct AppState {
    pub preferences: storage::Preferences,
    /// The shared preview disk cache, and the backend half of the memory budget.
    pub cache: Arc<cache::Store>,
    pub memory: Arc<cache::Memory>,
    pub logs: Arc<storage::Logs>,
    pub exif: Arc<metadata::ExifTool>,
    pub previews: preview::Previews,
    pub editor: editor::Editor,
    pub culling: culling::Culling,
    pub resources: PathBuf,
    pub running: AtomicBool,
    pub cancel: Arc<AtomicBool>,
    // 0: running normally, 1: close main window after draining, 2: quit after draining.
    pub shutdown: AtomicU8,
}

impl AppState {
    /// Unsaved edits or queued flags and ratings need the window's close handshake.
    pub fn needs_close_flush(&self) -> bool {
        self.editor.needs_close_flush() || (self.culling.used() && !self.editor.close_allowed())
    }
}

/// Storage roots. Debug builds can put them all under the absolute directory in
/// `X3FUSE_SMOKE_STORAGE`, so that native tests never touch live user data.
struct Directories {
    config: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    log: PathBuf,
}

impl Directories {
    fn resolve(app: &tauri::AppHandle) -> tauri::Result<(Self, bool)> {
        if cfg!(debug_assertions) {
            if let Some(root) = std::env::var_os("X3FUSE_SMOKE_STORAGE").map(PathBuf::from) {
                if !root.is_absolute() {
                    return Err(std::io::Error::other(
                        "X3FUSE_SMOKE_STORAGE must be an absolute path",
                    )
                    .into());
                }
                return Ok((
                    Self {
                        config: root.join("config"),
                        data: root.join("data"),
                        cache: root.join("cache"),
                        log: root.join("logs"),
                    },
                    true,
                ));
            }
        }
        Ok((
            Self {
                config: app.path().app_config_dir()?,
                data: app.path().app_data_dir()?,
                cache: app.path().app_cache_dir()?,
                log: app.path().app_log_dir()?,
            },
            false,
        ))
    }
}

static CORE_LOGS: OnceLock<Arc<storage::Logs>> = OnceLock::new();

fn migrate_directory(old: &Path, new: &Path) -> std::io::Result<Option<String>> {
    if old.is_dir() {
        if new.exists() {
            return Ok(Some(format!(
                "Alpha application data remains at {} because {} already exists",
                old.display(),
                new.display()
            )));
        }
        if let Some(parent) = new.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(old, new)?;
    }
    Ok(None)
}

fn migrate_alpha_directories(app: &tauri::AppHandle) -> Vec<(&'static str, String)> {
    let identifier = &app.config().identifier;
    let old_identifier = format!("{identifier}.tauri");
    [
        app.path().app_config_dir(),
        app.path().app_data_dir(),
        app.path().app_log_dir(),
    ]
    .into_iter()
    .filter_map(|directory| {
        let result = directory.map_err(std::io::Error::other).and_then(|new| {
            let old: PathBuf = new
                .iter()
                .map(|part| {
                    if part == identifier.as_str() {
                        std::ffi::OsStr::new(&old_identifier)
                    } else {
                        part
                    }
                })
                .collect();
            migrate_directory(&old, &new)
        });
        match result {
            Ok(Some(message)) => Some(("info", message)),
            Ok(None) => None,
            Err(error) => {
                let message = format!("Could not migrate alpha application directory: {error}");
                eprintln!("{message}");
                Some(("error", message))
            }
        }
    })
    .collect()
}

/// True when the system appearance is dark. Auto mode never pins the
/// application appearance, so the effective appearance is the system one.
#[cfg(target_os = "macos")]
pub(crate) fn system_dark() -> bool {
    use objc2::{class, msg_send, runtime::AnyObject};
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let appearance: *mut AnyObject = msg_send![app, effectiveAppearance];
        if appearance.is_null() {
            return false;
        }
        let name: *mut AnyObject = msg_send![appearance, name];
        let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
        !utf8.is_null()
            && std::ffi::CStr::from_ptr(utf8)
                .to_string_lossy()
                .contains("Dark")
    }
}

// ponytail: other platforms assume a dark system until a system-appearance
// read exists there; applyTheme in the page corrects the content after load.
#[cfg(not(target_os = "macos"))]
pub(crate) fn system_dark() -> bool {
    true
}

/// Builds the main window from its config, themed before its first frame.
fn build_main_window(app: &tauri::AppHandle, settings: &model::Settings) -> Option<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()?;
    let (pinned, theme, color) = settings.window_theme(system_dark());
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| {
            builder
                .theme(pinned)
                .background_color(color)
                .initialization_script(model::theme_script(theme))
                .build()
        })
        .map_err(|error| eprintln!("Could not create the main window: {error}"))
        .ok()
}

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
                    use objc2::{class, msg_send, runtime::AnyObject, sel};
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
                    // WebKit keeps animation frames near 60 per second unless this
                    // private feature is off. Then they follow the display refresh rate.
                    let configuration: *mut AnyObject = msg_send![view, configuration];
                    let preferences: *mut AnyObject = msg_send![configuration, preferences];
                    let listed: bool =
                        msg_send![class!(WKPreferences), respondsToSelector: sel!(_features)];
                    let settable: bool = msg_send![
                        preferences,
                        respondsToSelector: sel!(_setEnabled:forFeature:)
                    ];
                    if listed && settable {
                        let features: *mut AnyObject = msg_send![class!(WKPreferences), _features];
                        let count: usize = msg_send![features, count];
                        for index in 0..count {
                            let feature: *mut AnyObject = msg_send![features, objectAtIndex: index];
                            let key: *mut AnyObject = msg_send![feature, key];
                            let key: *const std::ffi::c_char = msg_send![key, UTF8String];
                            if std::ffi::CStr::from_ptr(key)
                                == c"PreferPageRenderingUpdatesNear60FPSEnabled"
                            {
                                let _: () =
                                    msg_send![preferences, _setEnabled: false, forFeature: feature];
                            }
                        }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let (directories, isolated) = Directories::resolve(app.handle())?;
            let migration_logs = if isolated {
                vec![]
            } else {
                migrate_alpha_directories(app.handle())
            };
            let logs = Arc::new(storage::Logs::new(directories.log.clone()));
            for (kind, message) in migration_logs {
                logs.write(kind, message);
            }
            let preferences = storage::Preferences::load(directories.config.join("settings.json"));
            logs.debug
                .store(preferences.get().debug_logging_enabled, Ordering::Relaxed);
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                app.path().resource_dir()?.join("resources")
            };
            let edits = directories.data.join("edits");
            let exif = Arc::new(metadata::ExifTool::new(
                resources.join("exiftool"),
                edits.join(x3i::DIRECTORY),
                logs.clone(),
            ));
            tauri::async_runtime::block_on(exif.check()).map_err(std::io::Error::other)?;
            if !resources.join("opcodes").is_dir() {
                return Err(
                    std::io::Error::other("Missing opcodes; run npm run sync:resources").into(),
                );
            }
            let settings = preferences.get();
            // The store reconciles its index and applies its limit on its own
            // thread, without delaying the window.
            let store = cache::Store::open(
                directories.cache.join(cache::DIRECTORY),
                vec![
                    (
                        cache::LEGACY_PREVIEWS,
                        directories.cache.join(cache::LEGACY_PREVIEWS),
                    ),
                    (
                        cache::LEGACY_THUMBNAILS,
                        edits.join(cache::LEGACY_THUMBNAILS),
                    ),
                    (cache::LEGACY_MEDIUMS, edits.join(cache::LEGACY_MEDIUMS)),
                ],
                settings.preview_cache_enabled,
                settings.preview_cache_limit,
                logs.clone(),
            );
            let memory = Arc::new(cache::Memory::new(cache::memory_budget() / 2));
            source::use_store(store.clone());
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
                previews: preview::Previews::new(exif.clone(), store.clone(), memory.clone()),
                editor: editor::Editor::with_cache(edits, store.clone(), memory.clone()),
                culling: culling::Culling::load(directories.data.join("culling.json")),
                cache: store,
                memory,
                exif,
                resources,
                running: AtomicBool::new(false),
                cancel: Arc::new(AtomicBool::new(false)),
                shutdown: AtomicU8::new(0),
            }));
            let settings = app.state::<Arc<AppState>>().preferences.get();
            menu::set_language(&settings.language);
            menu::install(app.handle())?;
            // The page's first IPC call needs the managed state, so the window is built last.
            if build_main_window(app.handle(), &settings).is_none() {
                return Err(std::io::Error::other("Could not create the main window").into());
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("x3f-preview", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<Arc<AppState>>();
                let (result, cache_only) = match preview::protocol_path(&request.uri().to_string())
                {
                    Ok((path, full, cache_only)) => (
                        async {
                            let uri = request.uri().to_string();
                            let url = url::Url::parse(&uri).map_err(|e| e.to_string())?;
                            let region = preview::protocol_region(&url)?;
                            let native = url
                                .query_pairs()
                                .find(|(key, _)| key == "v")
                                .is_some_and(|(_, value)| value == "native");
                            if native {
                                match state.previews.has_embedded_full(&path, cache_only).await? {
                                    Some(true) => {}
                                    Some(false) => {
                                        let state = state.inner().clone();
                                        return tauri::async_runtime::spawn_blocking(move || {
                                            state.editor.original_native(&path, &uri)
                                        })
                                        .await
                                        .map_err(|e| e.to_string())?;
                                    }
                                    None => return Ok(None),
                                }
                            }
                            match region {
                                Some(region) => {
                                    state.previews.get_region(&path, region, cache_only).await
                                }
                                None => state.previews.get(&path, full, cache_only).await,
                            }
                        }
                        .await,
                        cache_only,
                    ),
                    Err(e) => (Err(e), false),
                };
                let (status, bytes) = match result {
                    Ok(Some(bytes)) => (200, bytes.as_ref().clone()),
                    Ok(None) if cache_only => (204, vec![]),
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
                            preview::content_type(&bytes)
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
                let body = state.editor.respond(&request.uri().to_string());
                if body.status != 200 {
                    state.logs.write(
                        "debug",
                        format!("Edited preview: {}", String::from_utf8_lossy(&body.bytes)),
                    );
                }
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
                    .status(body.status)
                    .header("Content-Type", body.content_type)
                    .header(
                        "Cache-Control",
                        if body.status == 200 {
                            "private, max-age=86400, immutable"
                        } else {
                            "no-store"
                        },
                    )
                    .header("Access-Control-Allow-Origin", origin)
                    .body(body.bytes)
                    .unwrap();
                responder.respond(response);
                // A background render may leave a medium PNG to persist.
                state.editor.persist_previews();
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::editor_open,
            commands::editor_warm,
            commands::editor_render,
            commands::editor_save,
            commands::editor_load,
            commands::editor_close,
            commands::editor_cancel_render,
            commands::editor_begin_image_request,
            commands::editor_end_image_request,
            commands::editor_preview,
            commands::editor_pick_white_balance,
            commands::editor_white_balance,
            commands::editor_finish_close,
            commands::editor_x3i_status,
            commands::editor_x3i_process,
            commands::editor_x3i_cancel,
            commands::editor_x3i_delete,
            commands::settings_get,
            commands::settings_set,
            commands::queue_add,
            commands::queue_existing_outputs,
            commands::culling_set,
            commands::convert_start,
            commands::convert_stop,
            commands::exif_full,
            commands::dialog_pick_files,
            commands::dialog_pick_folder,
            commands::dialog_pick_output_dir,
            commands::shell_reveal,
            commands::window_open_settings,
            commands::logs_open,
            commands::licenses_open,
            commands::logs_clear,
            commands::logs_sizes,
            commands::cache_size,
            commands::cache_clear,
            commands::cache_memory_budget,
            commands::cache_sfd_size,
            commands::cache_sfd_clear,
            commands::app_info,
            commands::haptics_detent,
            updater::update_check
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<Arc<AppState>>();
                    if state.needs_close_flush() {
                        api.prevent_close();
                        let _ = window.emit("editor:closing", serde_json::json!({"quit":false}));
                        return;
                    }
                    state.editor.close_window();
                    // The app can stay open without a window on macOS.
                    let app_state = state.inner().clone();
                    std::thread::spawn(move || app_state.editor.release_source());
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
            if state.needs_close_flush() && (code.is_some() || !cfg!(target_os = "macos")) {
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
            let _ = build_main_window(app, &app.state::<Arc<AppState>>().preferences.get());
        }
        _ => {}
    });
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn alpha_directory_moves_only_when_the_destination_is_absent() {
        for (old_exists, new_exists) in [(false, false), (false, true), (true, false), (true, true)]
        {
            let root = tempfile::tempdir().unwrap();
            let old = root.path().join("com.sagwa.X3Fuse.tauri");
            let new = root.path().join("com.sagwa.X3Fuse");
            if old_exists {
                std::fs::create_dir(&old).unwrap();
                std::fs::write(old.join("settings.json"), b"alpha settings").unwrap();
            }
            if new_exists {
                std::fs::create_dir(&new).unwrap();
                std::fs::write(new.join("settings.json"), b"current settings").unwrap();
            }
            let message = migrate_directory(&old, &new).unwrap();
            assert_eq!(message.is_some(), old_exists && new_exists);
            if let Some(message) = message {
                assert!(message.contains(old.to_str().unwrap()));
                assert!(message.contains(new.to_str().unwrap()));
            }
            assert_eq!(old.exists(), old_exists && new_exists);
            assert_eq!(new.exists(), old_exists || new_exists);
            if new_exists {
                assert_eq!(
                    std::fs::read(new.join("settings.json")).unwrap(),
                    b"current settings"
                );
            } else if old_exists {
                assert_eq!(
                    std::fs::read(new.join("settings.json")).unwrap(),
                    b"alpha settings"
                );
            }
        }
    }

    #[test]
    fn alpha_logs_move_when_the_local_data_parent_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("Local/com.sagwa.X3Fuse.tauri/logs");
        let new = root.path().join("Local/com.sagwa.X3Fuse/logs");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("error.log"), b"alpha log").unwrap();
        assert!(!new.parent().unwrap().exists());
        assert!(migrate_directory(&old, &new).unwrap().is_none());
        assert!(!old.exists());
        assert_eq!(std::fs::read(new.join("error.log")).unwrap(), b"alpha log");
    }
}
