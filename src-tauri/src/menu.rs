use crate::{commands, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::{
    menu::{
        Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    Emitter, Manager,
};

/// Command keys. The renderer uses the same table.
const SHORTCUTS: &str = include_str!("../../src/shared/shortcuts.json");

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

/// The key of a menu item: the first `shortcuts.json` entry of its command. Keys
/// without a modifier stay with the renderer: macOS sends a key that the page does
/// not handle to the menu, so a held X that the renderer ignores would reject photo
/// after photo. Only macOS registers the keys. GTK and Win32 run menu keys before the
/// webview, so that Ctrl+A or Ctrl+Z would not reach a text field. There the renderer
/// handles every key.
fn accelerator(command: &str) -> Option<String> {
    static TABLE: OnceLock<Value> = OnceLock::new();
    if !cfg!(target_os = "macos") {
        return None;
    }
    let table = TABLE.get_or_init(|| serde_json::from_str(SHORTCUTS).unwrap());
    let keys = &table[command];
    let key = keys.get(0).unwrap_or(keys).as_str()?;
    key.contains('+').then(|| key.to_string())
}

/// Translates a top-level title. Windows and Linux show a mnemonic: the first letter
/// of a Latin title, or the English initial after other titles, as in "ファイル(&F)".
fn title(key: &str, initial: char) -> String {
    let text = translate(key);
    if cfg!(target_os = "macos") {
        text
    } else if text.starts_with(|c: char| c.is_ascii_alphabetic()) {
        format!("&{text}")
    } else {
        format!("{text}(&{initial})")
    }
}

fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Item ids are renderer command names (`MenuCommand`), except for the items that
    // `install` handles.
    let labeled = |id: &str, text: String| MenuItem::with_id(app, id, text, true, accelerator(id));
    let item = |id: &str, key: &str| labeled(id, translate(key));
    let settings = MenuItem::with_id(
        app,
        "settings",
        format!("{}…", translate("menu.file.settings")),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    // Keep the native label, but route Quit through ExitRequested so exports drain.
    let quit = MenuItem::with_id(
        app,
        "quit",
        PredefinedMenuItem::quit(app, None)?.text()?,
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = {
        let application = SubmenuBuilder::new(app, "X3Fuse")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .item(&item("updates", "updates.check_for_updates")?)
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

    // The same text as the Export submenu of the photo context menu.
    let export_as = SubmenuBuilder::new(app, translate("menu.file.export_as"))
        .item(&item("exportJpeg", "batch.export_jpeg")?)
        .item(&item("exportTiff", "batch.export_tiff")?)
        .item(&item("exportDng", "batch.export_dng")?)
        .item(&item("exportEmbeddedJpg", "editor.exportEmbeddedJpeg")?)
        .build()?;
    let reveal = if cfg!(target_os = "macos") {
        "context.show_in_finder"
    } else if cfg!(windows) {
        "menu.file.show_in_explorer"
    } else {
        "menu.file.show_in_file_manager"
    };
    let mut file = SubmenuBuilder::new(app, title("menu.file.title", 'F'))
        .item(&item("addFiles", "menu.file.add_photos")?)
        .item(&item("addFolder", "menu.file.add_folder")?)
        .separator()
        .item(&item("editPhoto", "menu.file.edit_photo")?)
        .separator()
        .item(&item("exportSelected", "menu.file.export")?)
        .item(&item("exportPrevious", "batch.convert_previous")?)
        .item(&export_as)
        .item(&item("convertAll", "context.convert_all")?)
        .item(&item("stop", "menu.file.stop_export")?)
        .separator()
        .item(&item("showInFinder", reveal)?)
        .separator()
        .item(&item("removeSelected", "menu.file.remove_from_queue")?)
        .item(&item("clearQueue", "menu.file.clear_queue")?);
    if !cfg!(target_os = "macos") {
        file = file.separator().item(&settings).separator().item(&quit);
    }

    // The renderer undoes an adjustment, or the typing in a focused text field. So a click
    // on Undo also undoes adjustments. Linux has no native Undo and Redo, and the native
    // Redo of Windows sends Ctrl+Y, which the renderer does not use.
    let edit = SubmenuBuilder::new(app, title("menu.edit.title", 'E'))
        .item(&item("undoEdit", "menu.edit.undo")?)
        .item(&item("redoEdit", "menu.edit.redo")?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&item("copyEdits", "menu.edit.copy_adjustments")?)
        .item(&item("pasteEdits", "menu.edit.paste_adjustments")?)
        .item(&item("resetEdits", "menu.edit.reset_adjustments")?)
        .separator()
        .item(&item("selectAll", "menu.edit.select_all")?)
        .item(&item("deselectAll", "context.deselect_all")?)
        .item(&item("invertSelection", "menu.edit.invert_selection")?)
        .build()?;

    let sort = SubmenuBuilder::new(app, translate("menu.view.sort_by"))
        .item(&item("sortByName", "queue.column.name")?)
        .item(&item("sortByDate", "queue.column.date")?)
        .item(&item("sortBySize", "queue.column.size")?)
        .separator()
        .item(&item("sortAscending", "menu.view.ascending")?)
        .item(&item("sortDescending", "menu.view.descending")?)
        .build()?;
    let mut view = SubmenuBuilder::new(app, title("menu.view.title", 'V'))
        .item(&item("viewList", "menu.view.list")?)
        .item(&item("viewGrid", "menu.view.grid")?)
        .item(&item("viewFilmstrip", "menu.view.filmstrip")?)
        .item(&item("viewSurvey", "menu.view.survey")?)
        .separator()
        .item(&sort)
        .separator()
        .item(&item("toggleFilterBar", "menu.view.filter_bar")?)
        .item(&item("togglePanel", "menu.view.info_panel")?)
        .item(&item("toggleStrip", "menu.view.thumbnail_strip")?)
        .separator()
        .item(&item("zoomIn", "menu.view.zoom_in")?)
        .item(&item("zoomOut", "menu.view.zoom_out")?)
        .item(&item("zoomFit", "menu.view.zoom_fit")?)
        .item(&item("zoomActual", "menu.view.actual_size")?)
        .item(&item("compare", "editor.compare")?)
        .item(&item("negativePreview", "menu.view.negative_preview")?);
    if cfg!(target_os = "macos") {
        view = view.separator().item(&PredefinedMenuItem::fullscreen(
            app,
            Some(&translate("menu.view.full_screen")),
        )?);
    }

    let flag = SubmenuBuilder::new(app, translate("menu.photo.set_flag"))
        .item(&item("pick", "cull.pick")?)
        .item(&item("reject", "cull.reject")?)
        .item(&item("unflag", "cull.unflagged")?)
        .build()?;
    let mut rating = SubmenuBuilder::new(app, translate("menu.photo.set_rating"))
        .item(&item("rate0", "menu.photo.no_rating")?);
    for stars in 1..=5 {
        rating = rating.item(&labeled(&format!("rate{stars}"), "★".repeat(stars))?);
    }
    let rating = rating
        .separator()
        .item(&item("ratingUp", "menu.photo.increase_rating")?)
        .item(&item("ratingDown", "menu.photo.decrease_rating")?)
        .build()?;
    let photo = SubmenuBuilder::new(app, title("menu.photo.title", 'P'))
        .item(&item("previousPhoto", "menu.photo.previous")?)
        .item(&item("nextPhoto", "menu.photo.next")?)
        .separator()
        .item(&flag)
        .item(&rating)
        .separator()
        .item(&item("rotateLeft", "menu.photo.rotate_left")?)
        .item(&item("rotateRight", "menu.photo.rotate_right")?)
        .item(&item("crop", "editor.crop")?)
        .item(&item(
            "whiteBalancePicker",
            "menu.photo.white_balance_picker",
        )?)
        .build()?;

    // With these ids, Tauri makes the menus the macOS Window and Help menus, so that
    // macOS adds the window list, the tiling items, and the Help search field.
    let mut window =
        SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, title("menu.window.title", 'W'))
            .item(&PredefinedMenuItem::minimize(app, None)?)
            .item(&PredefinedMenuItem::maximize(app, None)?)
            .item(&PredefinedMenuItem::close_window(app, None)?);
    if cfg!(target_os = "macos") {
        window = window
            .separator()
            .item(&PredefinedMenuItem::bring_all_to_front(
                app,
                Some(&translate("menu.window.bring_all_to_front")),
            )?);
    }
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, title("menu.help.title", 'H'))
        .item(&item("help", "menu.help.X3Fuse_help")?)
        .item(&item("shortcuts", "menu.help.keyboard_shortcuts")?)
        .separator()
        .item(&item("showLogs", "menu.help.show_debug_logs")?)
        .item(&item("clearLogs", "menu.help.clear_debug_logs")?)
        .build()?;
    menu.item(&file.build()?)
        .item(&edit)
        .item(&view.build()?)
        .item(&photo)
        .item(&window.build()?)
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
            name => {
                let text = match name {
                    "selectAll" => Some("selectAll"),
                    "undoEdit" => Some("undo"),
                    "redoEdit" => Some("redo"),
                    _ => None,
                };
                let other = text.and_then(|text| {
                    app.webview_windows()
                        .into_values()
                        .find(|window| {
                            window.label() != "main" && window.is_focused().unwrap_or(false)
                        })
                        .map(|window| (window, text))
                });
                match other {
                    // In another window, such as Settings, these items act on its text.
                    Some((window, text)) => window.eval(format!("document.execCommand('{text}')")),
                    None => app.emit_to("main", "menu:command", json!({"name":name})),
                }
                .map_err(|e| e.to_string())
            }
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
        assert_eq!(translate("menu.window.title"), "ウインドウ");
        // A key without a translation uses English, then the key itself.
        assert_eq!(translate("missing.key"), "missing.key");
        assert!(set_language("en"));
        assert_eq!(translate("menu.file.settings"), "Settings");
        assert!(set_language("auto"));
    }

    #[test]
    fn shortcut_table_parses_as_menu_keys() {
        let table: serde_json::Map<String, Value> = serde_json::from_str(SHORTCUTS).unwrap();
        for (command, keys) in table {
            let keys = keys.as_array().cloned().unwrap_or_else(|| vec![keys]);
            assert!(!keys.is_empty(), "{command}");
            for key in keys {
                let key = key.as_str().unwrap();
                assert!(
                    key.parse::<muda::accelerator::Accelerator>().is_ok(),
                    "{command}: {key}"
                );
            }
        }
    }
}
