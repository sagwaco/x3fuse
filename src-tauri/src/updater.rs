use crate::{menu::translate, AppState};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

fn start_check(manual: bool, automatic: bool, checking: &AtomicBool) -> bool {
    (manual || automatic) && !checking.swap(true, Ordering::SeqCst)
}

async fn dialog(app: &tauri::AppHandle, message: String, buttons: MessageDialogButtons) -> bool {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("X3Fuse")
        .buttons(buttons)
        .show(move |accepted| {
            let _ = send.send(accepted);
        });
    receive.await.unwrap_or(false)
}

async fn check(app: &tauri::AppHandle, manual: bool) -> Result<bool, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        if manual {
            dialog(
                app,
                translate("updates.up_to_date"),
                MessageDialogButtons::Ok,
            )
            .await;
        }
        return Ok(false);
    };
    let automatic_download = app
        .state::<Arc<AppState>>()
        .preferences
        .get()
        .auto_download_updates;
    if !automatic_download
        && !dialog(
            app,
            format!(
                "{} {}\n\n{}",
                translate("updates.available"),
                update.version,
                update.body.as_deref().unwrap_or_default()
            ),
            MessageDialogButtons::OkCancelCustom(
                translate("updates.download"),
                translate("updates.later"),
            ),
        )
        .await
    {
        return Ok(false);
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    if !dialog(
        app,
        translate("updates.ready_to_install"),
        MessageDialogButtons::OkCancelCustom(
            translate("updates.install"),
            translate("updates.later"),
        ),
    )
    .await
    {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(dialog(
        app,
        translate("updates.ready_to_relaunch"),
        MessageDialogButtons::OkCancelCustom(
            translate("updates.relaunch"),
            translate("updates.later"),
        ),
    )
    .await)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, manual: Option<bool>) -> bool {
    static CHECKING: AtomicBool = AtomicBool::new(false);
    static LAUNCH_CHECKED: AtomicBool = AtomicBool::new(false);
    let manual = manual.unwrap_or(true);
    if !cfg!(target_os = "macos") || (!manual && LAUNCH_CHECKED.swap(true, Ordering::SeqCst)) {
        return false;
    }
    let state = app.state::<Arc<AppState>>();
    if !start_check(
        manual,
        state.preferences.get().auto_check_updates,
        &CHECKING,
    ) {
        return false;
    }
    let result = check(&app, manual).await;
    CHECKING.store(false, Ordering::SeqCst);
    match result {
        Ok(relaunch) => relaunch,
        Err(error) => {
            state.logs.write("debug", format!("Update check: {error}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_respect_the_preference_and_do_not_overlap() {
        let checking = AtomicBool::new(false);
        assert!(!start_check(false, false, &checking));
        assert!(!checking.load(Ordering::SeqCst));
        assert!(start_check(true, false, &checking));
        assert!(!start_check(true, true, &checking));
        assert!(!start_check(false, true, &checking));
        checking.store(false, Ordering::SeqCst);
        assert!(start_check(false, true, &checking));
    }
}
