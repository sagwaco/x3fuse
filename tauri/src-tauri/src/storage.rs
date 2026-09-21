use crate::model::Settings;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

/// Publish a complete JSON document on the destination filesystem.
pub fn write_json_atomic(
    path: &std::path::Path,
    value: &impl serde::Serialize,
) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing storage directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temp, value).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub struct Preferences {
    path: PathBuf,
    value: Mutex<Settings>,
}

impl Preferences {
    pub fn load(path: PathBuf) -> Self {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(Value::Object(saved)) = serde_json::from_slice::<Value>(&bytes) {
                // Recover valid fields individually; one bad preference must not erase the rest.
                for (key, field) in saved {
                    let mut candidate = value.clone();
                    if candidate.get(&key).is_none() {
                        continue;
                    }
                    candidate[&key] = field;
                    if serde_json::from_value::<Settings>(candidate.clone())
                        .is_ok_and(|s| s.validate().is_ok())
                    {
                        value = candidate;
                    }
                }
            }
        }
        Self {
            path,
            value: Mutex::new(serde_json::from_value(value).unwrap()),
        }
    }

    pub fn get(&self) -> Settings {
        self.value.lock().unwrap().clone()
    }

    pub fn set(&self, patch: Value) -> Result<Settings, String> {
        let patch = patch.as_object().ok_or("Expected a settings object")?;
        let mut current = self.value.lock().map_err(|_| "Settings unavailable")?;
        let mut value = serde_json::to_value(&*current).map_err(|e| e.to_string())?;
        for (key, field) in patch {
            if value.get(key).is_none() {
                return Err(format!("Unknown setting: {key}"));
            }
            value[key] = field.clone();
        }
        let next: Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
        next.validate()?;
        write_json_atomic(&self.path, &next)?;
        *current = next.clone();
        Ok(next)
    }
}

pub struct Logs {
    pub dir: PathBuf,
    pub debug: AtomicBool,
    writer: Mutex<()>,
}

impl Logs {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            debug: AtomicBool::new(false),
            writer: Mutex::new(()),
        }
    }
    pub fn write(&self, kind: &str, message: impl AsRef<str>) {
        if kind == "debug" && !self.debug.load(Ordering::Relaxed) {
            return;
        }
        let Ok(_guard) = self.writer.lock() else {
            return;
        };
        let result = (|| -> std::io::Result<()> {
            fs::create_dir_all(&self.dir)?;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(format!("{kind}.log")))?;
            writeln!(
                file,
                "[{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                message.as_ref()
            )
        })();
        if let Err(e) = result {
            eprintln!("Log write failed: {e}");
        }
    }
    pub fn clear(&self) -> Result<(), String> {
        let _guard = self.writer.lock().map_err(|_| "Logs unavailable")?;
        for kind in ["conversion", "error", "debug"] {
            match fs::remove_file(self.dir.join(format!("{kind}.log"))) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
    pub fn sizes(&self) -> Value {
        let mut sizes = serde_json::Map::new();
        for kind in ["conversion", "error", "debug"] {
            sizes.insert(
                kind.into(),
                fs::metadata(self.dir.join(format!("{kind}.log")))
                    .map(|m| m.len())
                    .unwrap_or(0)
                    .into(),
            );
        }
        Value::Object(sizes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_atomic_and_invalid_patches_do_not_change_saved_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = Preferences::load(path.clone());
        store
            .set(serde_json::json!({"concurrency": 3, "queueViewMode": "grid"}))
            .unwrap();
        assert!(store.set(serde_json::json!({"concurrency": 99})).is_err());
        assert_eq!(Preferences::load(path).get().batch.concurrency, 3);
        assert_eq!(store.get().queue_view_mode, "grid");
        assert!(!store.get().has_previous_conversion);
    }

    #[test]
    fn layout_widths_round_trip_and_old_preferences_keep_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"sortAscending":false}"#).unwrap();
        let store = Preferences::load(path.clone());
        assert_eq!(store.get().inspector_width, 300);
        assert_eq!(store.get().export_panel_width, 380);
        assert_eq!(store.get().list_column_widths.name, 0);
        store
            .set(serde_json::json!({
                "inspectorWidth":420, "exportPanelWidth":460,
                "listColumnWidths":{"name":500,"date":250,"size":90}
            }))
            .unwrap();
        let loaded = Preferences::load(path.clone()).get();
        assert_eq!(loaded.inspector_width, 420);
        assert_eq!(loaded.export_panel_width, 460);
        assert_eq!(loaded.list_column_widths.name, 500);
        assert!(!loaded.sort_ascending);
        for patch in [
            serde_json::json!({"inspectorWidth":1}),
            serde_json::json!({"exportPanelWidth":9999}),
            serde_json::json!({"listColumnWidths":{"name":-1,"date":220,"size":110}}),
        ] {
            assert!(store.set(patch).is_err());
        }
        assert_eq!(Preferences::load(path).get().inspector_width, 420);
    }
}
