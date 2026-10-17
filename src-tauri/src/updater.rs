use crate::{menu::translate, AppState};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(serde::Deserialize)]
pub struct CheckRequest {
    pub manual: bool,
}

fn installation_notice(debug: bool, executable: &Path) -> Option<&'static str> {
    let path = executable.to_string_lossy();
    if debug || !path.contains(".app/Contents/MacOS/") {
        Some("updates.installed_app_only")
    } else if path.contains("/AppTranslocation/") {
        Some("updates.move_to_applications")
    } else {
        None
    }
}

fn start_check(manual: bool, automatic: bool, checking: &AtomicBool) -> bool {
    (manual || automatic) && !checking.swap(true, Ordering::SeqCst)
}

fn release_notes(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.strip_prefix("- ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn checked_update(
    result: tauri_plugin_updater::Result<Option<Update>>,
    manual: bool,
) -> Result<Option<Update>, String> {
    match result {
        Err(tauri_plugin_updater::Error::ReleaseNotFound) if manual => Ok(None),
        result => result.map_err(|error| error.to_string()),
    }
}

async fn dialog(
    app: &tauri::AppHandle,
    message: String,
    buttons: MessageDialogButtons,
) -> Result<bool, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("X3Fuse")
        .buttons(buttons)
        .show(move |accepted| {
            let _ = send.send(accepted);
        });
    receive.await.map_err(|error| error.to_string())
}

async fn report_failure(app: &tauri::AppHandle, manual: bool, error: String) {
    let state = app.state::<Arc<AppState>>();
    state.logs.write("error", format!("Update check: {error}"));
    if manual {
        if let Err(error) = dialog(
            app,
            format!("{}\n\n{error}", translate("updates.check_failed")),
            MessageDialogButtons::Ok,
        )
        .await
        {
            state.logs.write("error", format!("Update dialog: {error}"));
        }
    }
}

async fn check(app: &tauri::AppHandle, manual: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    if let Some(key) = installation_notice(cfg!(debug_assertions), &executable) {
        if manual {
            dialog(app, translate(key), MessageDialogButtons::Ok).await?;
        }
        return Ok(());
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = checked_update(updater.check().await, manual)? else {
        if manual {
            dialog(
                app,
                translate("updates.up_to_date"),
                MessageDialogButtons::Ok,
            )
            .await?;
        }
        return Ok(());
    };
    let automatic_download = app
        .state::<Arc<AppState>>()
        .preferences
        .get()
        .auto_download_updates;
    let downloaded = if automatic_download {
        Some(
            update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    if !dialog(
        app,
        format!(
            "{} {}\n\n{}",
            translate("updates.available"),
            update.version,
            release_notes(update.body.as_deref().unwrap_or_default())
        ),
        MessageDialogButtons::OkCancelCustom(
            translate("updates.install_and_relaunch"),
            translate("updates.later"),
        ),
    )
    .await?
    {
        return Ok(());
    }
    let bytes = match downloaded {
        Some(bytes) => bytes,
        None => update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    // request_restart lets the existing exit handler save edits and finish exports.
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, payload: CheckRequest) {
    static CHECKING: AtomicBool = AtomicBool::new(false);
    static LAUNCH_CHECKED: AtomicBool = AtomicBool::new(false);
    let manual = payload.manual;
    if !cfg!(target_os = "macos") || (!manual && LAUNCH_CHECKED.swap(true, Ordering::SeqCst)) {
        return;
    }
    let state = app.state::<Arc<AppState>>();
    if !start_check(
        manual,
        state.preferences.get().auto_check_updates,
        &CHECKING,
    ) {
        return;
    }
    if let Err(error) = check(&app, manual).await {
        report_failure(&app, manual, error).await;
    }
    CHECKING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_release_app_bundles_can_update() {
        let app = Path::new("/Applications/X3Fuse.app/Contents/MacOS/x3fuse-tauri");
        assert_eq!(installation_notice(false, app), None);
        assert_eq!(
            installation_notice(true, app),
            Some("updates.installed_app_only")
        );
        for executable in [
            "/work/src-tauri/target/debug/x3fuse-tauri",
            "/work/src-tauri/target/release/x3fuse-tauri",
        ] {
            for debug in [true, false] {
                assert_eq!(
                    installation_notice(debug, Path::new(executable)),
                    Some("updates.installed_app_only")
                );
            }
        }
    }

    #[test]
    fn translocated_bundles_must_move_before_updating() {
        let executable = Path::new("/private/var/folders/user/AppTranslocation/uuid/d/X3Fuse.app/Contents/MacOS/x3fuse-tauri");
        assert_eq!(
            installation_notice(false, executable),
            Some("updates.move_to_applications")
        );
    }

    #[test]
    fn missing_releases_are_current_only_for_manual_checks_and_other_errors_survive() {
        use tauri_plugin_updater::Error;
        assert!(matches!(
            checked_update(Err(Error::ReleaseNotFound), true),
            Ok(None)
        ));
        assert_eq!(
            checked_update(Err(Error::ReleaseNotFound), false).err(),
            Some(Error::ReleaseNotFound.to_string())
        );
        for manual in [false, true] {
            assert_eq!(
                checked_update(Err(Error::Network("connection failed".into())), manual).err(),
                Some("`connection failed`".into())
            );
        }
    }

    #[test]
    fn notes_remove_bullet_markers_and_blank_lines_without_changing_hyphenated_text() {
        assert_eq!(
            release_notes("\n- First fix\r\n\n  - Second fix\n  \nNon-bullet text\n-flag stays\n"),
            "First fix\nSecond fix\nNon-bullet text\n-flag stays"
        );
        assert_eq!(release_notes(" \n\n"), "");
    }

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
