use crate::{conversion, metadata, model::*, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        Err("This operation belongs to the main window".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn settings_get(state: State<'_, Arc<AppState>>) -> Result<Settings, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.preferences.get())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, Arc<AppState>>,
    payload: Value,
) -> Result<Settings, String> {
    write_settings(state.inner().clone(), payload).await
}

async fn write_settings(state: Arc<AppState>, payload: Value) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let next = state.preferences.set(payload)?;
        state
            .logs
            .debug
            .store(next.debug_logging_enabled, Ordering::Relaxed);
        Ok(next)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct Paths {
    paths: Vec<PathBuf>,
}

#[tauri::command]
pub async fn queue_add(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: Paths,
) -> Result<Vec<FileDto>, String> {
    main_window(&window)?;
    if payload.paths.len() > 1024 {
        return Err("Import files in smaller batches".into());
    }
    let paths: Vec<_> = payload
        .paths
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("x3f")))
        .collect();
    for path in &paths {
        source_path(path)?;
    }
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let inputs = paths.clone();
    let (dtos, mut meta) = tokio::join!(
        tauri::async_runtime::spawn_blocking(move || inputs
            .into_iter()
            .map(metadata::basic_metadata)
            .collect::<Result<Vec<_>, _>>()),
        state.exif.display(&paths)
    );
    let mut dtos = dtos.map_err(|e| e.to_string())??;
    for dto in &mut dtos {
        if let Some(meta) = meta.remove(&dto.path) {
            dto.orientation = meta.orientation;
            dto.aspect_ratio = meta.aspect_ratio;
            dto.exif = Some(meta.exif);
            if let Some(bytes) = meta.preview {
                state.previews.prime(&dto.path, bytes);
            }
        }
    }
    Ok(dtos)
}

#[tauri::command]
pub async fn queue_existing_outputs(
    window: WebviewWindow,
    payload: BatchRequest,
) -> Result<Vec<OutputConflict>, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        conversion::validate_batch(&payload.files, &payload.settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn convert_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: StartRequest,
) -> Result<(), String> {
    main_window(&window)?;
    if payload.batch_id.is_empty() || payload.batch_id.len() > 128 {
        return Err("Invalid batch ID".into());
    }
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("Application is closing".into());
    }
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An export is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let state = state.inner().clone();
    let result = async {
        let validation = payload.clone();
        let conflicts = tauri::async_runtime::spawn_blocking(move || {
            conversion::validate_batch(&validation.files, &validation.settings)
        })
        .await
        .map_err(|e| e.to_string())??;
        conversion::validate_approvals(&payload, &conflicts)?;
        if state.cancel.load(Ordering::SeqCst) {
            return Err("Export cancelled".into());
        }
        let mut settings = serde_json::to_value(&payload.settings).map_err(|e| e.to_string())?;
        settings["hasPreviousConversion"] = true.into();
        write_settings(state.clone(), settings).await?;
        app.emit_to(
            "main",
            "batch:started",
            json!({"batchId":payload.batch_id,"settings":payload.settings}),
        )
        .map_err(|e| e.to_string())?;
        conversion::run_batch(app.clone(), state.clone(), payload).await
    }
    .await;
    state.running.store(false, Ordering::SeqCst);
    crate::finish_shutdown(&app, &state);
    result
}

#[tauri::command]
pub fn convert_stop(window: WebviewWindow, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    main_window(&window)?;
    state.cancel.store(true, Ordering::SeqCst);
    let logs = state.logs.clone();
    tauri::async_runtime::spawn_blocking(move || logs.write("conversion", "Stop export requested"));
    Ok(())
}

#[derive(Deserialize)]
pub struct PathRequest {
    path: PathBuf,
}

#[tauri::command]
pub async fn exif_full(
    state: State<'_, Arc<AppState>>,
    payload: PathRequest,
) -> Result<Vec<ExifPair>, String> {
    source_path(&payload.path)?;
    match state.exif.full(&payload.path).await {
        Ok(rows) => Ok(rows),
        Err(e) => {
            state
                .logs
                .write("error", format!("Inspector metadata: {e}"));
            Ok(vec![])
        }
    }
}

#[tauri::command]
pub async fn dialog_pick_files(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PathBuf>, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    let title = crate::menu::translate("dialog.select_x3f_files.title");
    tauri::async_runtime::spawn_blocking(move || {
        let last = state.preferences.get().last_import_directory;
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .add_filter("X3F RAW", &["x3f", "X3F"]);
        if let Some(last) = last {
            dialog = dialog.set_directory(last);
        }
        let paths = dialog
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(parent) = paths.first().and_then(|p| p.parent()) {
            state
                .preferences
                .set(json!({"lastImportDirectory":parent}))?;
        }
        Ok(paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dialog_pick_output_dir(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<PathBuf>, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title(crate::menu::translate(
                "dialog.select_output_directory.title",
            ))
            .blocking_pick_folder()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_reveal(app: AppHandle, payload: PathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !payload.path.is_absolute() || !payload.path.exists() {
            return Err("Path does not exist".into());
        }
        app.opener()
            .reveal_item_in_dir(payload.path)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn window_open_settings(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_settings(&app))
        .await
        .map_err(|e| e.to_string())?
}

pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html#settings".into()),
    )
    .title(crate::menu::translate("menu.file.settings"))
    .inner_size(540.0, 640.0)
    .min_inner_size(460.0, 420.0)
    .background_color(tauri::window::Color(10, 10, 10, 255))
    .disable_drag_drop_handler()
    .on_navigation(|url| {
        matches!(url.scheme(), "tauri" | "http" | "https")
            && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
    })
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn logs_open(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open_logs(&app, &state))
        .await
        .map_err(|e| e.to_string())?
}

pub fn open_logs(app: &AppHandle, state: &AppState) -> Result<(), String> {
    std::fs::create_dir_all(&state.logs.dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(state.logs.dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn logs_clear(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let logs = state.logs.clone();
    tauri::async_runtime::spawn_blocking(move || logs.clear())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn logs_sizes(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let logs = state.logs.clone();
    tauri::async_runtime::spawn_blocking(move || logs.sizes())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn app_info(app: AppHandle) -> Value {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    };
    json!({"version":app.package_info().version.to_string(),"platform":platform,"autoConcurrency":auto_concurrency()})
}
#[tauri::command]
pub fn update_check() { /* Release/update work remains out of scope, as in Electron. */
}
