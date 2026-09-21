use crate::{commands, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

pub fn translate(key: &str) -> String {
    static STRINGS: OnceLock<(Value, Value)> = OnceLock::new();
    let (local, en) = STRINGS.get_or_init(|| {
        let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
        let en = include_str!("../../src/shared/i18n/locales/en.json");
        let text = if locale.starts_with("ja") {
            include_str!("../../src/shared/i18n/locales/ja.json")
        } else if locale.starts_with("ko") {
            include_str!("../../src/shared/i18n/locales/ko.json")
        } else if locale.starts_with("zh") {
            if ["hant", "tw", "hk", "mo"]
                .iter()
                .any(|v| locale.contains(v))
            {
                include_str!("../../src/shared/i18n/locales/zh-Hant.json")
            } else {
                include_str!("../../src/shared/i18n/locales/zh-Hans.json")
            }
        } else {
            en
        };
        (
            serde_json::from_str(text).unwrap(),
            serde_json::from_str(en).unwrap(),
        )
    });
    local[key]
        .as_str()
        .or_else(|| en[key].as_str())
        .unwrap_or(key)
        .to_string()
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
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
        false,
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
    app.set_menu(
        menu.item(&file.build()?)
            .item(&edit)
            .item(&conversion)
            .item(&window)
            .item(&help)
            .build()?,
    )?;
    app.on_menu_event(|app, event| {
        let state = app.state::<Arc<AppState>>();
        let result = match event.id().as_ref() {
            "quit" => {
                app.exit(0);
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
            | "pasteEdits") => app
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
