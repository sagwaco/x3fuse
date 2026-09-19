use crate::{
    model::{source_path, ExifPair, FileDto},
    storage::Logs,
};
use base64::Engine;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

pub struct ExifTool {
    root: PathBuf,
    pub logs: Arc<Logs>,
}

impl ExifTool {
    pub fn new(root: PathBuf, logs: Arc<Logs>) -> Self {
        Self { root, logs }
    }

    pub async fn run(
        &self,
        args: Vec<OsString>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<u8>, String> {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err("Export cancelled".into());
        }
        #[cfg(windows)]
        let mut command = Command::new(self.root.join("exiftool.exe"));
        #[cfg(not(windows))]
        let mut command = {
            let mut c = Command::new("perl");
            c.arg(self.root.join("exiftool"));
            c
        };
        self.logs.write("debug", format!("ExifTool {args:?}"));
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start ExifTool (check resources and Perl): {e}"))?;
        let stdout = child.stdout.take().ok_or("Missing ExifTool stdout")?;
        let stderr = child.stderr.take().ok_or("Missing ExifTool stderr")?;
        let out = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(128 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let err = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(1024 * 1024)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let mut cancelled = false;
        let status = loop {
            tokio::select! {
                result = child.wait() => break result,
                _ = tokio::time::sleep(Duration::from_millis(25)) => {
                    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                        cancelled = true;
                        let result = child.kill().await;
                        break match result { Ok(()) => child.wait().await, Err(e) => Err(e) };
                    }
                }
            }
        };
        let (stdout, stderr) = tokio::join!(out, err);
        let stdout = stdout
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let stderr = stderr
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if cancelled {
            return Err("Export cancelled".into());
        }
        let status = status.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "ExifTool {status}: {}",
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        if stdout.len() == 128 * 1024 * 1024 {
            return Err("ExifTool response exceeds size limit".into());
        }
        if !stderr.is_empty() {
            self.logs.write("debug", String::from_utf8_lossy(&stderr));
        }
        Ok(stdout)
    }

    pub async fn check(&self) -> Result<(), String> {
        let version = self.run(vec!["-ver".into()], None).await?;
        if String::from_utf8_lossy(&version).trim() != "13.59" {
            return Err("Expected bundled ExifTool 13.59; run npm run sync:resources".into());
        }
        Ok(())
    }

    pub async fn copy_tags(
        &self,
        input: &Path,
        output: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        self.run(
            vec![
                "-charset".into(),
                "filename=UTF8".into(),
                "-overwrite_original".into(),
                "-tagsFromFile".into(),
                input.into(),
                "-all:all".into(),
                output.into(),
            ],
            Some(cancel),
        )
        .await
        .map(|_| ())
    }

    pub async fn preview(&self, path: &Path, full: bool) -> Result<Option<Vec<u8>>, String> {
        let tags: &[&str] = if full {
            &["JpgFromRaw"]
        } else {
            &["PreviewImage", "ThumbnailImage", "JpgFromRaw"]
        };
        for tag in tags {
            let bytes = self
                .run(
                    vec![
                        "-charset".into(),
                        "filename=UTF8".into(),
                        "-b".into(),
                        format!("-{tag}").into(),
                        path.into(),
                    ],
                    None,
                )
                .await?;
            if is_jpeg(&bytes) {
                return Ok(Some(bytes));
            }
        }
        Ok(None)
    }

    pub async fn display(&self, paths: &[PathBuf]) -> HashMap<PathBuf, DisplayMeta> {
        let mut args: Vec<OsString> = [
            "-charset",
            "filename=UTF8",
            "-Orientation",
            "-ImageWidth",
            "-ImageHeight",
            "-PreviewImage",
            "-ThumbnailImage",
            "-b",
            "-n",
            "-json",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        args.extend(paths.iter().map(|p| p.as_os_str().to_owned()));
        let result = async {
            let bytes = self.run(args, None).await?;
            let objects: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let mut result = HashMap::new();
            for object in objects {
                let Some(path) = object["SourceFile"].as_str() else {
                    continue;
                };
                let orientation = object["Orientation"]
                    .as_u64()
                    .filter(|v| (1..=8).contains(v))
                    .map(|v| v as u8);
                let aspect_ratio = object["ImageWidth"]
                    .as_f64()
                    .zip(object["ImageHeight"].as_f64())
                    .and_then(|(w, h)| (w > 0.0 && h > 0.0).then_some(w / h));
                let preview = ["PreviewImage", "ThumbnailImage"].iter().find_map(|key| {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(object[key].as_str()?.strip_prefix("base64:")?)
                        .ok()?;
                    is_jpeg(&bytes).then_some(bytes)
                });
                result.insert(
                    PathBuf::from(path),
                    DisplayMeta {
                        orientation,
                        aspect_ratio,
                        preview,
                    },
                );
            }
            Ok::<_, String>(result)
        }
        .await;
        match result {
            Ok(map) => map,
            Err(e) => {
                self.logs
                    .write("error", format!("Import metadata unavailable: {e}"));
                HashMap::new()
            }
        }
    }

    pub async fn full(&self, path: &Path) -> Result<Vec<ExifPair>, String> {
        source_path(path)?;
        let mut args: Vec<OsString> = INSPECTOR
            .iter()
            .map(|(tag, _)| format!("-{tag}").into())
            .collect();
        args.extend([
            "-charset".into(),
            "filename=UTF8".into(),
            "-d".into(),
            "%Y-%m-%d %H:%M:%S".into(),
            "-json".into(),
            path.into(),
        ]);
        let bytes = self.run(args, None).await?;
        let objects: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let Some(meta) = objects.first() else {
            return Ok(vec![]);
        };
        Ok(INSPECTOR
            .iter()
            .filter_map(|(tag, label)| {
                let v = &meta[tag];
                if v.is_null() || v.as_str() == Some("") {
                    return None;
                }
                let value = v
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string());
                let value = match *tag {
                    "FNumber" => format!("f/{value}"),
                    "ImageSize" => value.replace('x', " × "),
                    _ => value,
                };
                Some(ExifPair {
                    label: (*label).into(),
                    value,
                })
            })
            .collect())
    }
}

const INSPECTOR: &[(&str, &str)] = &[
    ("Model", "Camera"),
    ("LensID", "Lens"),
    ("FocalLength", "Focal length"),
    ("FNumber", "Aperture"),
    ("ExposureTime", "Shutter"),
    ("ISO", "ISO"),
    ("ExposureCompensation", "Exposure comp."),
    ("ExposureProgram", "Program"),
    ("MeteringMode", "Metering"),
    ("WhiteBalance", "White balance"),
    ("ImageSize", "Dimensions"),
    ("DateTimeOriginal", "Captured"),
    ("Software", "Software"),
    ("SerialNumber", "Serial"),
];

pub struct DisplayMeta {
    pub orientation: Option<u8>,
    pub aspect_ratio: Option<f64>,
    pub preview: Option<Vec<u8>>,
}
pub fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 2 && bytes.starts_with(&[0xff, 0xd8])
}

pub fn basic_metadata(path: PathBuf) -> Result<FileDto, String> {
    source_path(&path)?;
    let info = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let captured_date = capture_date(&path).or_else(|| {
        info.created()
            .or_else(|_| info.modified())
            .ok()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
    });
    Ok(FileDto {
        id: uuid::Uuid::new_v4().to_string(),
        file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        path,
        file_size: info.len(),
        captured_date,
        orientation: None,
        aspect_ratio: None,
    })
}

fn capture_date(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(65536)
        .read_to_end(&mut bytes)
        .ok()?;
    // Match the existing 64 KiB header scan, without adding a regex dependency.
    for window in bytes.windows(19) {
        if window[4] != b':' || window[7] != b':' || window[10] != b' ' {
            continue;
        }
        let Ok(text) = std::str::from_utf8(window) else {
            continue;
        };
        let Ok(date) = NaiveDateTime::parse_from_str(text, "%Y:%m:%d %H:%M:%S") else {
            continue;
        };
        if let Some(date) = Local.from_local_datetime(&date).earliest() {
            return Some(date.with_timezone(&Utc).to_rfc3339());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_preserves_header_dates_and_rejects_non_x3f_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("写真.X3F");
        std::fs::write(&path, b"header 2024:02:29 12:34:56 trailing").unwrap();
        let dto = basic_metadata(path).unwrap();
        assert_eq!(dto.file_name, "写真.X3F");
        assert!(dto.captured_date.unwrap().contains("2024-02-29"));
        assert!(basic_metadata(dir.path().join("photo.jpg")).is_err());
    }
}
