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
    /// Frame copies of X3I files, which ExifTool cannot read.
    x3i: PathBuf,
    pub logs: Arc<Logs>,
}

impl ExifTool {
    pub fn new(root: PathBuf, x3i: PathBuf, logs: Arc<Logs>) -> Self {
        Self { root, x3i, logs }
    }

    /// The file that ExifTool reads for `path`. See `x3i::exif_source`.
    async fn source(&self, path: &Path) -> Result<PathBuf, String> {
        self.frame_source(path, Default::default()).await
    }

    /// The file with the metadata of the X3I frames that `x3i_source` uses.
    async fn frame_source(
        &self,
        path: &Path,
        x3i_source: x3f_core::X3iSource,
    ) -> Result<PathBuf, String> {
        if !crate::x3i::is_x3i(path) {
            return Ok(path.to_owned());
        }
        let (cache, path) = (self.x3i.clone(), path.to_owned());
        tauri::async_runtime::spawn_blocking(move || {
            crate::x3i::exif_source(&cache, &path, x3i_source)
        })
        .await
        .map_err(|e| e.to_string())?
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
        x3i_source: x3f_core::X3iSource,
        output: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        self.run(
            vec![
                "-charset".into(),
                "filename=UTF8".into(),
                "-overwrite_original".into(),
                "-tagsFromFile".into(),
                self.frame_source(input, x3i_source).await?.into(),
                "-all:all".into(),
                output.into(),
            ],
            Some(cancel),
        )
        .await
        .map(|_| ())
    }

    pub async fn preview(&self, path: &Path, full: bool) -> Result<Option<Vec<u8>>, String> {
        let path = &self.source(path).await?;
        let dng = crate::source::Kind::of(path) == crate::source::Kind::Dng;
        let tags: &[&str] = if full && dng {
            &["PreviewImage", "JpgFromRaw", "ThumbnailImage"]
        } else if full {
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
                if dng {
                    let orientation = match jpeg_orientation(&bytes).or_else(|| {
                        crate::source::Info::read(path, &AtomicBool::new(false))
                            .ok()
                            .and_then(|info| info.orientation)
                    }) {
                        Some(orientation) => orientation,
                        None => {
                            // An unsupported RAW can still have a usable embedded preview.
                            let value = self
                                .run(
                                    vec!["-Orientation#".into(), "-s3".into(), path.into()],
                                    None,
                                )
                                .await?;
                            String::from_utf8_lossy(&value)
                                .trim()
                                .parse::<u8>()
                                .ok()
                                .filter(|v| (1..=8).contains(v))
                                .unwrap_or(1)
                        }
                    };
                    if let Ok(bytes) = preview_orientation(bytes, orientation) {
                        return Ok(Some(bytes));
                    }
                } else {
                    return Ok(Some(bytes));
                }
            }
        }
        Ok(None)
    }

    pub async fn copy_rendered_tags(
        &self,
        input: &Path,
        x3i_source: x3f_core::X3iSource,
        output: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let mut args: Vec<OsString> = vec![
            "-charset".into(),
            "filename=UTF8".into(),
            "-overwrite_original".into(),
            "-tagsFromFile".into(),
            self.frame_source(input, x3i_source).await?.into(),
        ];
        // Copy capture/author metadata only. The encoder owns geometry, ICC and previews.
        args.extend(
            [
                "-EXIF:Make",
                "-EXIF:Model",
                "-EXIF:DateTimeOriginal",
                "-EXIF:CreateDate",
                "-EXIF:ExposureTime",
                "-EXIF:FNumber",
                "-EXIF:ISO",
                "-EXIF:FocalLength",
                "-EXIF:LensModel",
                "-EXIF:LensInfo",
                "-EXIF:Artist",
                "-EXIF:Copyright",
                "-GPS:all",
                "-XMP-dc:Creator",
                "-XMP-dc:Rights",
                "-Orientation#=1",
            ]
            .into_iter()
            .map(Into::into),
        );
        args.push(output.into());
        self.run(args, Some(cancel)).await.map(|_| ())
    }

    pub async fn display(&self, paths: &[PathBuf]) -> HashMap<PathBuf, DisplayMeta> {
        let mut args: Vec<OsString> = [
            "-charset",
            "filename=UTF8",
            "-Orientation#",
            "-ImageWidth#",
            "-ImageHeight#",
            "-PreviewImage",
            "-ThumbnailImage",
            "-b",
            "-d",
            "%Y-%m-%d %H:%M:%S",
            "-json",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        args.extend(INSPECTOR.iter().map(|(tag, _)| format!("-{tag}").into()));
        // ExifTool reports an X3I by its frame copy. Map it back.
        let mut sources = HashMap::new();
        for path in paths {
            match self.source(path).await {
                Ok(source) => {
                    args.push(source.clone().into());
                    sources.insert(source, path.clone());
                }
                Err(e) => self
                    .logs
                    .write("error", format!("Metadata of {}: {e}", path.display())),
            }
        }
        let result = async {
            let bytes = self.run(args, None).await?;
            let objects: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let mut result = HashMap::new();
            for object in objects {
                if object.get("Error").is_some() {
                    continue;
                }
                let Some(path) = object["SourceFile"].as_str() else {
                    continue;
                };
                let mut orientation = object["Orientation"]
                    .as_u64()
                    .filter(|v| (1..=8).contains(v))
                    .map(|v| v as u8);
                let aspect_ratio = object["ImageWidth"]
                    .as_f64()
                    .zip(object["ImageHeight"].as_f64())
                    .and_then(|(w, h)| (w > 0.0 && h > 0.0).then_some(w / h));
                let mut preview = ["PreviewImage", "ThumbnailImage"].iter().find_map(|key| {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(object[key].as_str()?.strip_prefix("base64:")?)
                        .ok()?;
                    is_jpeg(&bytes).then_some(bytes)
                });
                let path = PathBuf::from(path);
                if crate::source::Kind::of(&path) == crate::source::Kind::Dng {
                    orientation = preview
                        .as_deref()
                        .and_then(jpeg_orientation)
                        .or(orientation);
                    preview = preview.and_then(|bytes| {
                        preview_orientation(bytes, orientation.unwrap_or(1)).ok()
                    });
                }
                result.insert(
                    sources.get(&path).cloned().unwrap_or(path),
                    DisplayMeta {
                        orientation,
                        aspect_ratio,
                        preview,
                        exif: inspector_pairs(&object),
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
            self.source(path).await?.into(),
        ]);
        let bytes = self.run(args, None).await?;
        let objects: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let Some(meta) = objects.first() else {
            return Ok(vec![]);
        };
        Ok(inspector_pairs(meta))
    }
}

fn inspector_pairs(meta: &Value) -> Vec<ExifPair> {
    INSPECTOR
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
        .collect()
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
    ("Flash", "Flash"),
    ("WhiteBalance", "White balance"),
    ("ImageSize", "Dimensions"),
    ("DateTimeOriginal", "Captured"),
    ("Software", "Software"),
    ("SerialNumber", "Serial"),
];

/// The preview cache keeps the preview in a separate file.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMeta {
    pub orientation: Option<u8>,
    pub aspect_ratio: Option<f64>,
    #[serde(skip)]
    pub preview: Option<Vec<u8>>,
    pub exif: Vec<ExifPair>,
}
pub fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 2 && bytes.starts_with(&[0xff, 0xd8])
}

fn jpeg_orientation(bytes: &[u8]) -> Option<u8> {
    x3f_sys::jpeg_exif::parse_jpeg_exif(bytes)?
        .orientation
        .filter(|orientation| (1..=8).contains(orientation))
        .map(|v| v as u8)
}

/// An embedded preview can already be upright. Keep its own orientation when present.
pub(crate) fn preview_orientation(bytes: Vec<u8>, orientation: u8) -> Result<Vec<u8>, String> {
    if !is_jpeg(&bytes) || !(1..=8).contains(&orientation) {
        return Err("Invalid DNG preview".into());
    }
    if jpeg_orientation(&bytes).is_some() {
        return Ok(bytes);
    }
    let mut result = Vec::with_capacity(bytes.len() + 36);
    result.extend_from_slice(&[0xff, 0xd8, 0xff, 0xe1, 0, 34]);
    result.extend_from_slice(b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0");
    result.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0, 0]);
    let mut at = 2;
    while at < bytes.len() {
        let start = at;
        if bytes[at] != 0xff {
            return Err("Invalid DNG preview JPEG marker".into());
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at).ok_or("Truncated DNG preview JPEG marker")?;
        at += 1;
        if marker == 0xda || marker == 0xd9 {
            result.extend_from_slice(&bytes[start..]);
            return Ok(result);
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            result.extend_from_slice(&bytes[start..at]);
            continue;
        }
        let length = bytes
            .get(at..at + 2)
            .ok_or("Truncated DNG preview JPEG segment")?;
        let length = u16::from_be_bytes([length[0], length[1]]) as usize;
        let end = at + length;
        if length < 2 || end > bytes.len() {
            return Err("Invalid DNG preview JPEG segment length".into());
        }
        // Remove EXIF without an orientation so that decoders see one EXIF block.
        if marker != 0xe1 || !bytes[at + 2..end].starts_with(b"Exif\0\0") {
            result.extend_from_slice(&bytes[start..end]);
        }
        at = end;
    }
    Err("Truncated DNG preview JPEG".into())
}

pub fn basic_metadata(path: PathBuf) -> Result<FileDto, String> {
    source_path(&path)?;
    let source_kind = crate::source::Kind::of(&path);
    let source = crate::source::Info::read(&path, &AtomicBool::new(false));
    let capabilities = source.as_ref().map_or_else(
        |_| {
            crate::source::Capabilities::for_kind(
                source_kind,
                source_kind == crate::source::Kind::Dng,
            )
        },
        |info| info.capabilities,
    );
    let orientation = source.as_ref().ok().and_then(|info| info.orientation);
    let edit_error = source.err();
    crate::source::remember(&path)?;
    let frames = crate::x3i::frames(&path);
    let info = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let captured_date = capture_date(&path).or_else(|| {
        info.created()
            .or_else(|_| info.modified())
            .ok()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
    });
    Ok(FileDto {
        source_kind,
        capabilities,
        id: uuid::Uuid::new_v4().to_string(),
        file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        path,
        file_size: info.len(),
        captured_date,
        orientation,
        aspect_ratio: None,
        exif: None,
        edit: None,
        edit_error,
        frames,
        cull: Default::default(),
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
    #[test]
    fn dng_preview_orientation_preserves_pixels_and_existing_orientation() {
        let jpeg = vec![
            0xff, 0xd8, 0xff, 0xe2, 0, 5, 1, 2, 3, 0xff, 0xda, 0, 2, 4, 5, 0xff, 0xd9,
        ];
        for orientation in 1..=8 {
            let tagged = super::preview_orientation(jpeg.clone(), orientation).unwrap();
            assert_eq!(super::jpeg_orientation(&tagged), Some(orientation));
            assert!(tagged.ends_with(&jpeg[2..]));
            assert_eq!(
                super::preview_orientation(tagged.clone(), 1).unwrap(),
                tagged
            );
        }
        for broken in [
            vec![],
            vec![0xff, 0xd8, 0xff],
            vec![0xff, 0xd8, 0xff, 0xe1, 0, 1],
            vec![0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff],
        ] {
            assert!(super::preview_orientation(broken, 6).is_err());
        }
    }

    use super::*;
    #[test]
    fn invalid_dng_remains_visible_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let dng = dir.path().join("invalid.DNG");
        let x3f = dir.path().join("photo.X3F");
        std::fs::write(&dng, b"invalid DNG").unwrap();
        std::fs::write(&x3f, b"X3F header").unwrap();
        let dtos = [dng, x3f]
            .into_iter()
            .map(basic_metadata)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(dtos[0].edit_error.is_some());
        assert!(!dtos[0].capabilities.foveon);
        assert!(dtos[0].capabilities.rendered_only);
        assert!(dtos[1].edit_error.is_none());
    }

    #[test]
    fn import_and_inspector_share_display_formatting() {
        let pairs = inspector_pairs(&serde_json::json!({
            "Model": "SIGMA dp2 Quattro",
            "LensID": "",
            "FNumber": 2.8,
            "ExposureTime": "1/125",
            "ISO": 100,
            "ExposureProgram": "Aperture-priority AE",
            "ImageSize": "5424x3616",
            "SerialNumber": null
        }));
        let rows: Vec<_> = pairs
            .iter()
            .map(|pair| (pair.label.as_str(), pair.value.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("Camera", "SIGMA dp2 Quattro"),
                ("Aperture", "f/2.8"),
                ("Shutter", "1/125"),
                ("ISO", "100"),
                ("Program", "Aperture-priority AE"),
                ("Dimensions", "5424 × 3616")
            ]
        );
    }

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
