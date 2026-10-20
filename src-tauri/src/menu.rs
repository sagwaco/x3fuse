use crate::{commands, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

const LOCALES: [(&str, &str); 6] = [
    ("en", include_str!("../../src/shared/i18n/locales/en.json")),
    ("es", include_str!("../../src/shared/i18n/locales/es.json")),
    ("ja", include_str!("../../src/shared/i18n/locales/ja.json")),
    ("ko", include_str!("../../src/shared/i18n/locales/ko.json")),
    (
        "zh-Hans",
        include_str!("../../src/shared/i18n/locales/zh-Hans.json"),
    ),
    (
        "zh-Hant",
        include_str!("../../src/shared/i18n/locales/zh-Hant.json"),
    ),
];

/// The locale that the `language` setting selects. None follows the system.
static LANGUAGE: RwLock<Option<&str>> = RwLock::new(None);

fn system_locale() -> &'static str {
    static LOCALE: OnceLock<&str> = OnceLock::new();
    LOCALE.get_or_init(|| {
        let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
        if locale.starts_with("zh") {
            if ["hant", "tw", "hk", "mo"]
                .iter()
                .any(|v| locale.contains(v))
            {
                "zh-Hant"
            } else {
                "zh-Hans"
            }
        } else {
            ["es", "ja", "ko"]
                .into_iter()
                .find(|name| locale.starts_with(name))
                .unwrap_or("en")
        }
    })
}

/// Sets the locale of native text from the `language` setting ("auto" or a locale).
/// Returns true when the locale changes.
pub fn set_language(setting: &str) -> bool {
    let next = LOCALES
        .iter()
        .find(|(name, _)| *name == setting)
        .map(|(name, _)| *name);
    let mut language = LANGUAGE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::mem::replace(&mut *language, next) != next
}

pub fn translate(key: &str) -> String {
    static STRINGS: OnceLock<Vec<(&str, Value)>> = OnceLock::new();
    let strings = STRINGS.get_or_init(|| {
        LOCALES
            .iter()
            .map(|(name, text)| (*name, serde_json::from_str(text).unwrap()))
            .collect()
    });
    let locale = LANGUAGE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .unwrap_or_else(system_locale);
    let text = |name: &str| {
        strings
            .iter()
            .find(|(locale, _)| *locale == name)
            .and_then(|(_, value)| value[key].as_str())
    };
    text(locale)
        .or_else(|| text("en"))
        .unwrap_or(key)
        .to_string()
}

fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, key: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, translate(key), true, accelerator)
    };
    let settings = item("settings", "menu.file.settings", Some("CmdOrCtrl+,"))?;
    // Keep the native label, but route Quit through ExitRequested so exports drain.
    let quit = MenuItem::with_id(
        app,
        "quit",
        PredefinedMenuItem::quit(app, None)?.text()?,
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let updates = MenuItem::with_id(
        app,
        "updates",
        translate("updates.check_for_updates"),
        cfg!(target_os = "macos"),
        None::<&str>,
    )?;
    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = {
        let application = SubmenuBuilder::new(app, "X3Fuse")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .item(&updates)
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&quit)
            .build()?;
        menu.item(&application)
    };
    let mut file = SubmenuBuilder::new(app, "File").item(&item(
        "addFiles",
        "menu.file.add_x3f_files",
        Some("CmdOrCtrl+O"),
    )?);
    if !cfg!(target_os = "macos") {
        file = file
            .separator()
            .item(&settings)
            .item(&updates)
            .separator()
            .item(&quit);
    }
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&item("undoEdit", "editor.undo", None)?)
        .item(&item("redoEdit", "editor.redo", None)?)
        .item(&item(
            "copyEdits",
            "editor.copy",
            Some("CmdOrCtrl+Shift+C"),
        )?)
        .item(&item(
            "pasteEdits",
            "editor.paste",
            Some("CmdOrCtrl+Shift+V"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .separator()
        .item(&item(
            "selectAll",
            "menu.edit.select_all_files",
            Some("CmdOrCtrl+A"),
        )?)
        .item(&item(
            "deselectAll",
            "menu.edit.deselect_all_files",
            Some("CmdOrCtrl+D"),
        )?)
        .item(&item(
            "removeSelected",
            "menu.edit.remove_selected_files",
            None,
        )?)
        .build()?;
    // The renderer handles the single-key culling shortcuts. Native key equivalents
    // without a modifier could also take keys typed in text fields.
    let mut photo = SubmenuBuilder::new(app, translate("menu.photo.title"))
        .item(&item("pick", "cull.pick", None)?)
        .item(&item("reject", "cull.reject", None)?)
        .item(&item("unflag", "cull.unflagged", None)?)
        .separator()
        .item(&item("rate0", "cull.no_rating", None)?);
    for stars in 1..=5 {
        photo = photo.item(&MenuItem::with_id(
            app,
            format!("rate{stars}"),
            "★".repeat(stars),
            true,
            None::<&str>,
        )?);
    }
    let conversion = SubmenuBuilder::new(app, translate("menu.conversion.title"))
        .item(&item(
            "convertAll",
            "menu.conversion.convert_all_files",
            Some("CmdOrCtrl+R"),
        )?)
        .item(&item(
            "stop",
            "menu.conversion.stop_conversion",
            Some("CmdOrCtrl+S"),
        )?)
        .separator()
        .item(&item(
            "clearQueue",
            "menu.conversion.clear_queue",
            Some("CmdOrCtrl+K"),
        )?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(
            "showLogs",
            "menu.help.show_debug_logs",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&item("clearLogs", "menu.help.clear_debug_logs", None)?)
        .build()?;
    menu.item(&file.build()?)
        .item(&edit)
        .item(&photo.build()?)
        .item(&conversion)
        .item(&window)
        .item(&help)
        .build()
}

/// Builds the menu again in the current language.
pub fn refresh(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
    if let Some(window) = app.get_webview_window("settings") {
        window.set_title(&translate("menu.file.settings"))?;
    }
    Ok(())
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
    app.on_menu_event(|app, event| {
        let state = app.state::<Arc<AppState>>();
        let result = match event.id().as_ref() {
            "quit" => {
                app.exit(0);
                Ok(())
            }
            "updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::updater::update_check(
                        app,
                        crate::updater::CheckRequest { manual: true },
                    )
                    .await;
                });
                Ok(())
            }
            name @ ("settings" | "showLogs" | "clearLogs") => {
                let app = app.clone();
                let name = name.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<Arc<AppState>>();
                    let result = match name.as_str() {
                        "settings" => commands::open_settings(&app),
                        "showLogs" => commands::open_logs(&app, &state),
                        _ => state.logs.clear(),
                    };
                    if let Err(error) = result {
                        state.logs.write("error", error);
                    }
                });
                Ok(())
            }
            name @ ("addFiles" | "selectAll" | "deselectAll" | "removeSelected" | "convertAll"
            | "stop" | "clearQueue" | "undoEdit" | "redoEdit" | "copyEdits"
            | "pasteEdits" | "pick" | "reject" | "unflag" | "rate0" | "rate1" | "rate2"
            | "rate3" | "rate4" | "rate5") => app
                .emit_to("main", "menu:command", json!({"name":name}))
                .map_err(|e| e.to_string()),
            _ => Ok(()),
        };
        if let Err(e) = result {
            let logs = state.logs.clone();
            tauri::async_runtime::spawn_blocking(move || logs.write("error", e));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_setting_selects_native_text() {
        assert!(set_language("ja"));
        assert!(!set_language("ja"));
        assert_eq!(translate("menu.file.settings"), "設定");
        // A key without a translation uses English, then the key itself.
        assert_eq!(translate("missing.key"), "missing.key");
        assert!(set_language("en"));
        assert_eq!(translate("menu.file.settings"), "Settings");
        assert!(set_language("auto"));
    }
}
