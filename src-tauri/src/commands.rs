use crate::{conversion, metadata, model::*, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
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
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: Value,
) -> Result<Settings, String> {
    let settings = write_settings(window.app_handle(), state.inner().clone(), payload).await?;
    for (label, other) in window.app_handle().webview_windows() {
        if label != window.label() {
            let _ = other.emit_to(label, "settings:changed", ());
        }
    }
    Ok(settings)
}

async fn write_settings(
    app: &AppHandle,
    state: Arc<AppState>,
    payload: Value,
) -> Result<Settings, String> {
    // Save and apply in one critical section, so that an older save cannot apply its
    // values after a newer one.
    static APPLY: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _apply = APPLY
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = state.preferences.set(payload)?;
        state
            .logs
            .debug
            .store(next.debug_logging_enabled, Ordering::Relaxed);
        state
            .previews
            .disk
            .configure(next.preview_cache_enabled, next.preview_cache_limit);
        if crate::menu::set_language(&next.language) {
            if let Err(error) = crate::menu::refresh(&app) {
                state.logs.write("error", error.to_string());
            }
        }
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
        .filter(|p| p.extension().is_some_and(crate::model::is_source_extension))
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
        state.previews.import(&paths)
    );
    // The renderer matches the results to its rows by index, so keep the input order.
    let mut dtos = dtos.map_err(|e| e.to_string())??;
    for dto in &mut dtos {
        if let Some(meta) = meta.remove(&dto.path) {
            dto.orientation = meta.orientation;
            dto.aspect_ratio = meta.aspect_ratio;
            dto.exif = Some(meta.exif);
        }
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        for dto in &mut dtos {
            match state.editor.load(&dto.path) {
                // Stored defaults that could not be removed are not edits.
                Ok(edit) => dto.edit = edit.filter(|edit| edit.edited),
                Err(error) => dto.edit_error = Some(error),
            }
        }
        state.editor.edits.flush_fingerprints();
        for dto in &mut dtos {
            dto.cull = state.culling.get(&dto.path);
        }
        dtos
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct CullRequest {
    paths: Vec<PathBuf>,
    flag: Option<crate::culling::Flag>,
    rating: Option<u8>,
}

#[tauri::command]
pub async fn culling_set(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: CullRequest,
) -> Result<(), String> {
    main_window(&window)?;
    let state = state.inner().clone();
    // The renderer queues later saves until this one returns, so the backend cannot see
    // them. From now on, a close asks the renderer to finish its queue first.
    state.culling.used.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .culling
            .set(&payload.paths, payload.flag, payload.rating)
    })
    .await
    .map_err(|e| e.to_string())?
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
    mut payload: StartRequest,
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
    state.editor.paused.store(true, Ordering::SeqCst);
    state.editor.cancel_preview();
    let state = state.inner().clone();
    let result = async {
        payload.settings.concurrency = state.preferences.get().batch.concurrency;
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
        let settings = batch_settings_patch(&payload.settings)?;
        payload.settings.concurrency = write_settings(&app, state.clone(), settings)
            .await?
            .batch
            .concurrency;
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
    state.editor.resume_previews();
    crate::finish_shutdown(&app, &state);
    result
}

fn batch_settings_patch(settings: &BatchSettings) -> Result<Value, String> {
    let mut patch = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    let fields = patch
        .as_object_mut()
        .ok_or("Expected a batch settings object")?;
    fields.remove("concurrency");
    patch["hasPreviousConversion"] = true.into();
    Ok(patch)
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
            .add_filter("X3F RAW", &["x3f", "X3F", "x3i", "X3I"]);
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
pub async fn dialog_pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PathBuf>, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    let title = crate::menu::translate("dialog.select_folders.title");
    tauri::async_runtime::spawn_blocking(move || {
        let last = state.preferences.get().last_import_directory;
        let mut dialog = app.dialog().file().set_parent(&window).set_title(title);
        if let Some(last) = last {
            dialog = dialog.set_directory(last);
        }
        let folders = dialog
            .blocking_pick_folders()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(parent) = folders.first().and_then(|p| p.parent()) {
            state
                .preferences
                .set(json!({"lastImportDirectory":parent}))?;
        }
        folder_sources(&folders)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The X3F and X3I files directly inside the folders, sorted by path. Hidden files,
/// such as the "._" files that macOS writes on memory cards, are not photos.
fn folder_sources(folders: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for folder in folders {
        let entries =
            std::fs::read_dir(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        for path in entries.flatten().map(|entry| entry.path()) {
            let hidden = path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'));
            if !hidden && path.is_file() && path.extension().is_some_and(is_source_extension) {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
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
    let settings = app.state::<Arc<AppState>>().preferences.get();
    let (pinned, theme, color) = settings.window_theme(crate::system_dark());
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html#settings".into()),
    )
    // The title stays for the Window menu and accessibility. On macOS the
    // React titlebar shows it in place of the hidden native title.
    .title(crate::menu::translate("menu.file.settings"))
    .inner_size(600.0, 640.0)
    .min_inner_size(460.0, 420.0)
    .theme(pinned)
    .background_color(color)
    .initialization_script(crate::model::theme_script(theme))
    .disable_drag_drop_handler()
    .on_navigation(|url| {
        matches!(url.scheme(), "tauri" | "http" | "https")
            && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
    });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|e| e.to_string())?;
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
/// Open the bundled third-party licence notices. CC BY-SA 4.0 requires the
/// film model's attribution to be reachable from the app itself.
#[tauri::command]
pub async fn licenses_open(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("resources/licenses");
        if !dir.is_dir() {
            return Err("Bundled licenses are unavailable in this build".into());
        }
        app.opener()
            .open_path(dir.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
/// The bytes in the preview disk cache.
#[tauri::command]
pub async fn cache_size(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.previews.disk.size())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn cache_clear(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.previews.disk.clear())
        .await
        .map_err(|e| e.to_string())?
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
/// Sync commands run on the main thread, as AppKit expects. Force Touch
/// trackpads only play this while a finger is on the trackpad.
#[tauri::command]
pub fn haptics_detent() {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::{class, msg_send, runtime::AnyObject};
        let performer: *mut AnyObject =
            msg_send![class!(NSHapticFeedbackManager), defaultPerformer];
        // NSHapticFeedbackPatternAlignment, NSHapticFeedbackPerformanceTimeNow
        let _: () = msg_send![performer, performFeedbackPattern: 1isize, performanceTime: 1usize];
    }
}

#[tauri::command]
pub async fn editor_open(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: PathRequest,
) -> Result<crate::editor::EditorSession, String> {
    main_window(&window)?;
    if state.running.load(Ordering::SeqCst) {
        return Err("Wait for conversion to finish before editing".into());
    }
    let state = state.inner().clone();
    state.editor.begin_open()?;
    tauri::async_runtime::spawn_blocking(move || state.editor.open(payload.path))
        .await
        .map_err(|e| e.to_string())?
}

/// Prepares the selected photo in the background, so that Edit opens it fast.
#[tauri::command]
pub async fn editor_warm(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: PathRequest,
) -> Result<(), String> {
    main_window(&window)?;
    if state.running.load(Ordering::SeqCst) {
        return Err("Preview rendering pauses during export".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.editor.warm(payload.path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn editor_render(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: crate::editor::RenderRequest,
) -> Result<crate::editor::RenderedPreview, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    let job = state.editor.begin_render(payload)?;
    let persist = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || state.editor.render_job(job))
        .await
        .map_err(|e| e.to_string())?;
    // Persist medium PNGs after the frame is returned, not before.
    tauri::async_runtime::spawn_blocking(move || persist.editor.persist_previews());
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditRequest {
    path: PathBuf,
    recipe: x3f_render::EditRecipe,
    revision: u64,
    source_revision: Option<String>,
}

#[tauri::command]
pub async fn editor_save(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: SaveEditRequest,
) -> Result<crate::editor::EditRecord, String> {
    main_window(&window)?;
    state.editor.begin_save()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        struct Saving(Arc<AppState>);
        impl Drop for Saving {
            fn drop(&mut self) {
                self.0.editor.saving.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _saving = Saving(state.clone());
        state.editor.save(
            &payload.path,
            payload.recipe,
            payload.revision,
            payload.source_revision.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn editor_load(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: Paths,
) -> Result<Vec<Value>, String> {
    main_window(&window)?;
    if payload.paths.len() > 1024 {
        return Err("Load edits in smaller batches".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let records = payload
            .paths
            .into_iter()
            .map(|path| match state.editor.load(&path) {
                Ok(Some(record)) => {
                    let mut value = serde_json::to_value(record).unwrap();
                    value["path"] = json!(path);
                    value
                }
                // Paste starts from the camera defaults, with the as-shot crop and seed.
                Ok(None) => match state
                    .editor
                    .edits
                    .source_revision(&path)
                    .and_then(|revision| {
                        state
                            .editor
                            .default_recipe(&path, &revision, &AtomicBool::new(false))
                            .map(|recipe| (revision, recipe))
                    }) {
                    Ok((source_revision, recipe)) => json!({"path":path,"revision":0,
                        "sourceRevision":source_revision,"recipe":recipe}),
                    Err(error) => json!({"path":path,"revision":0,"error":error}),
                },
                Err(error) => json!({"path":path,"revision":0,"error":error}),
            })
            .collect();
        state.editor.edits.flush_fingerprints();
        records
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRenderRequest {
    session_id: String,
    revision: u64,
}

#[tauri::command]
pub fn editor_cancel_render(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: CancelRenderRequest,
) -> Result<(), String> {
    main_window(&window)?;
    state
        .editor
        .cancel_render(&payload.session_id, payload.revision)
}

#[tauri::command]
pub fn editor_begin_image_request(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    main_window(&window)?;
    Ok(json!({ "requestId": state.editor.begin_image_request()? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    request_id: String,
}

#[tauri::command]
pub fn editor_end_image_request(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: ImageRequest,
) -> Result<(), String> {
    main_window(&window)?;
    state.editor.end_image_request(&payload.request_id)
}

#[tauri::command]
pub async fn editor_close(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: SessionRequest,
) -> Result<(), String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.editor.close(&payload.session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct X3iRequest {
    path: PathBuf,
    recipe: x3f_render::EditRecipe,
}

#[tauri::command]
pub async fn editor_x3i_status(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: X3iRequest,
) -> Result<Option<crate::editor::X3iStatus>, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.editor.x3i_status(&payload.path, &payload.recipe)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merges an X3I. It returns when the merge ends; `editor:x3iStatus` reports progress.
#[tauri::command]
pub async fn editor_x3i_process(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: X3iRequest,
) -> Result<(), String> {
    main_window(&window)?;
    if state.running.load(Ordering::SeqCst) {
        return Err("Wait for conversion to finish before editing".into());
    }
    // Register before the blocking task, so that a Cancel sent next finds the merge.
    let Some(merge) = state.editor.x3i_begin(&payload.path)? else {
        return Ok(());
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.editor.x3i_run(merge, &payload.recipe))
        .await
        .map_err(|e| e.to_string())?
}

/// Removes the merged image of an X3I from the cache.
#[tauri::command]
pub async fn editor_x3i_delete(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: X3iRequest,
) -> Result<(), String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.editor.x3i_delete(&payload.path, &payload.recipe)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn editor_x3i_cancel(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: PathRequest,
) -> Result<(), String> {
    main_window(&window)?;
    state.editor.x3i_cancel(&payload.path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEditRequest {
    path: PathBuf,
    /// Missing for an unedited photo: render its camera defaults.
    #[serde(default)]
    recipe: Option<x3f_render::EditRecipe>,
    #[serde(default)]
    source_revision: Option<String>,
}

#[tauri::command]
pub async fn editor_preview(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: PreviewEditRequest,
) -> Result<Value, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source_revision = state.editor.edits.source_revision(&payload.path)?;
        let recipe = match payload.recipe {
            Some(recipe) => recipe,
            None => state.editor.default_recipe(
                &payload.path,
                &source_revision,
                &AtomicBool::new(false),
            )?,
        };
        let url = state.editor.preview(
            &payload.path,
            &recipe,
            Some(
                payload
                    .source_revision
                    .as_deref()
                    .unwrap_or(&source_revision),
            ),
        )?;
        Ok(json!({"url":url,"sourceRevision":source_revision}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickWhiteBalanceRequest {
    session_id: String,
    x: f32,
    y: f32,
    #[serde(default)]
    recipe: x3f_render::EditRecipe,
}

#[tauri::command]
pub async fn editor_pick_white_balance(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: PickWhiteBalanceRequest,
) -> Result<Value, String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .editor
            .pick_white_balance(&payload.session_id, payload.recipe, payload.x, payload.y)
            .map(|(temperature, tint)| json!({"temperature":temperature,"tint":tint}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct FinishCloseRequest {
    quit: bool,
}

#[tauri::command]
pub async fn editor_finish_close(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    payload: FinishCloseRequest,
) -> Result<(), String> {
    main_window(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.editor.finish_close())
        .await
        .map_err(|e| e.to_string())??;
    if payload.quit {
        app.exit(0);
    } else {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_preferences_keep_current_global_concurrency() {
        let directory = tempfile::tempdir().unwrap();
        let preferences = crate::storage::Preferences::load(directory.path().join("settings.json"));
        let captured = BatchSettings {
            output_format: OutputFormat::Tiff,
            concurrency: 8,
            ..Default::default()
        };
        let patch = batch_settings_patch(&captured).unwrap();
        assert!(patch.get("concurrency").is_none());
        for concurrency in [0, 2, 5] {
            preferences.set(json!({"concurrency":concurrency})).unwrap();
            let current = preferences.set(patch.clone()).unwrap();
            assert_eq!(current.batch.concurrency, concurrency);
            assert_eq!(current.batch.output_format, OutputFormat::Tiff);
            assert!(current.has_previous_conversion);
        }
    }

    #[test]
    fn folder_sources_lists_photos_directly_inside() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("folder.X3F")).unwrap();
        for name in ["b.x3i", "a.X3F", "c.jpg", "._a.X3F", "sub/d.x3f"] {
            std::fs::write(root.join(name), b"x3f").unwrap();
        }
        assert_eq!(
            folder_sources(&[root.to_path_buf()]).unwrap(),
            [root.join("a.X3F"), root.join("b.x3i")]
        );
    }
}
