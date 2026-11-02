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
        if crate::source::Kind::of(path) == crate::source::Kind::Dng {
            let previews = self.dng_previews(std::slice::from_ref(path), full).await?;
            return Ok(previews.into_values().next());
        }
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

    /// The embedded JPEG previews of `Kind::Dng` files, by ExifTool's `SourceFile`
    /// path, from one ExifTool call. `full` selects the fit view, else the
    /// thumbnail and small preview. See `choose`. A file without an accepted
    /// JPEG has no entry; it uses the rendered RAW preview.
    async fn dng_previews(
        &self,
        paths: &[PathBuf],
        full: bool,
    ) -> Result<HashMap<PathBuf, Vec<u8>>, String> {
        let mut args: Vec<OsString> = [
            "-charset",
            "filename=UTF8",
            "-a",
            "-G1",
            "-b",
            "-json",
            "-Orientation#",
            "-PreviewImage",
            "-JpgFromRaw",
            "-ThumbnailImage",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        args.extend(paths.iter().map(Into::into));
        let bytes = self.run(args, None).await?;
        let objects: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        // Header reads, letterbox decodes and RAW metadata are blocking work.
        tauri::async_runtime::spawn_blocking(move || {
            objects
                .into_iter()
                .filter_map(|object| {
                    let path = PathBuf::from(object["SourceFile"].as_str()?);
                    // An unsupported RAW keeps today's rules: no aspect test, no 1:1 view.
                    let info = crate::source::Info::read(&path, &AtomicBool::new(false)).ok();
                    let orientation = info
                        .and_then(|info| info.orientation)
                        .or_else(|| {
                            object["IFD0:Orientation"]
                                .as_u64()
                                .filter(|v| (1..=8).contains(v))
                                .map(|v| v as u8)
                        })
                        .unwrap_or(1);
                    let jpegs = object
                        .as_object()?
                        .iter()
                        .filter(|(key, _)| {
                            key.ends_with(":PreviewImage")
                                || key.ends_with(":JpgFromRaw")
                                || (key.ends_with(":ThumbnailImage") && (!full || info.is_none()))
                        })
                        .filter_map(|(_, value)| {
                            base64::engine::general_purpose::STANDARD
                                .decode(value.as_str()?.strip_prefix("base64:")?)
                                .ok()
                                .filter(|bytes| is_jpeg(bytes))
                        })
                        .collect();
                    Some((path, choose(jpegs, orientation, info.as_ref(), full)?))
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())
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
        // ExifTool reports an X3I by its frame copy. Map it back.
        let mut sources = HashMap::new();
        for path in paths {
            match self.source(path).await {
                Ok(source) => {
                    sources.insert(source, path.clone());
                }
                Err(e) => self
                    .logs
                    .write("error", format!("Metadata of {}: {e}", path.display())),
            }
        }
        let (dngs, others): (Vec<PathBuf>, Vec<PathBuf>) = sources
            .keys()
            .cloned()
            .partition(|path| crate::source::Kind::of(path) == crate::source::Kind::Dng);
        // One metadata call for each group. Only X3F and X3I get their binary
        // previews here; the DNG previews come from the chunked calls below.
        let metadata = |paths: Vec<PathBuf>, previews: bool| async move {
            if paths.is_empty() {
                return Ok(vec![]);
            }
            let bytes = self.run(display_args(&paths, previews), None).await?;
            serde_json::from_slice::<Vec<Value>>(&bytes).map_err(|e| e.to_string())
        };
        // `-a` returns every embedded JPEG, full-size ones too (3.4 MB for a Leica
        // M10-R). Chunks keep each call far below the 128 MiB output limit.
        // ponytail: fixed paths per chunk; use a byte budget if one RAW holds
        // more than about 30 MB of JPEGs.
        let chunks: Vec<&[PathBuf]> = dngs.chunks(4).collect();
        let next = std::sync::atomic::AtomicUsize::new(0);
        // Each worker runs one call at a time, so at most four run together.
        let worker = || async {
            let mut previews = HashMap::new();
            while let Some(chunk) = chunks.get(next.fetch_add(1, Ordering::Relaxed)) {
                match self.dng_previews(chunk, false).await {
                    Ok(found) => previews.extend(found),
                    // `Previews::get` extracts these one at a time.
                    Err(e) => self
                        .logs
                        .write("error", format!("Import DNG previews unavailable: {e}")),
                }
            }
            previews
        };
        let (other_objects, dng_objects, mut dng_previews, b, c, d) = tokio::join!(
            metadata(others, true),
            metadata(dngs.clone(), false),
            worker(),
            worker(),
            worker(),
            worker()
        );
        dng_previews.extend(b.into_iter().chain(c).chain(d));
        let mut objects = Vec::new();
        for found in [other_objects, dng_objects] {
            match found {
                Ok(found) => objects.extend(found),
                Err(e) => self
                    .logs
                    .write("error", format!("Import metadata unavailable: {e}")),
            }
        }
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
                // `choose` already gave the preview its orientation.
                preview = dng_previews.remove(&path);
                orientation = preview
                    .as_deref()
                    .and_then(jpeg_orientation)
                    .or(orientation);
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
        // Keep the previews of DNGs whose metadata call failed.
        for (path, preview) in dng_previews {
            result.insert(
                path,
                DisplayMeta {
                    orientation: jpeg_orientation(&preview),
                    aspect_ratio: None,
                    preview: Some(preview),
                    exif: vec![],
                },
            );
        }
        result
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

/// The import metadata call for `paths`. `previews` adds the binary
/// PreviewImage and ThumbnailImage tags.
fn display_args(paths: &[PathBuf], previews: bool) -> Vec<OsString> {
    let tags: &[&str] = if previews {
        &["-PreviewImage", "-ThumbnailImage"]
    } else {
        &[]
    };
    [
        "-charset",
        "filename=UTF8",
        "-Orientation#",
        "-ImageWidth#",
        "-ImageHeight#",
    ]
    .iter()
    .chain(tags)
    .chain(&["-b", "-d", "%Y-%m-%d %H:%M:%S", "-json"])
    .map(Into::into)
    .chain(INSPECTOR.iter().map(|(tag, _)| format!("-{tag}").into()))
    .chain(paths.iter().map(Into::into))
    .collect()
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

/// The smallest long edge of an embedded JPEG for the fit view.
pub const MIN_FIT_PREVIEW_EDGE: u32 = 1024;
/// The smallest long edge that the thumbnail and small preview prefer.
const MIN_THUMBNAIL_EDGE: u32 = 320;

/// Selects one embedded JPEG of a `Kind::Dng` source and gives it an orientation.
/// `orientation` applies when a JPEG has none. `info` is None for an unsupported
/// RAW: then no aspect rule applies, and the fit view takes the largest JPEG.
/// Else a JPEG must match the shown aspect (`fits_aspect`), or lose black
/// letterbox bands to match it. The fit view takes the largest accepted JPEG with
/// a long edge of `MIN_FIT_PREVIEW_EDGE` or more. The thumbnail takes the smallest
/// with `MIN_THUMBNAIL_EDGE` or more, else the largest.
pub(crate) fn choose(
    jpegs: Vec<Vec<u8>>,
    orientation: u8,
    info: Option<&crate::source::Info>,
    full: bool,
) -> Option<Vec<u8>> {
    let mut accepted: Vec<(u32, Vec<u8>)> = jpegs
        .into_iter()
        .filter_map(|bytes| {
            let orientation = jpeg_orientation(&bytes).unwrap_or(orientation);
            let bytes = match info {
                Some(info) if !fits_aspect(&bytes, orientation, info) => {
                    letterbox(&bytes, orientation, info)?
                }
                _ => bytes,
            };
            let bytes = preview_orientation(bytes, orientation).ok()?;
            let (width, height) = jpeg_size(&bytes)?;
            Some((width.max(height), bytes))
        })
        .collect();
    accepted.sort_by_key(|(edge, _)| *edge);
    let index = if full {
        accepted
            .iter()
            .rposition(|(edge, _)| *edge >= MIN_FIT_PREVIEW_EDGE)
            .or_else(|| accepted.len().checked_sub(1).filter(|_| info.is_none()))
    } else {
        accepted
            .iter()
            .position(|(edge, _)| *edge >= MIN_THUMBNAIL_EDGE)
            .or_else(|| accepted.len().checked_sub(1))
    }?;
    Some(accepted.swap_remove(index).1)
}

/// Crops black letterbox bands so that the JPEG matches the shown aspect.
/// None rejects the JPEG.
fn letterbox(bytes: &[u8], orientation: u8, info: &crate::source::Info) -> Option<Vec<u8>> {
    let aspect = shown_aspect(info)?;
    // The JPEG keeps its stored pixels; compare in that frame.
    let stored = if (5..=8).contains(&orientation) {
        1. / aspect
    } else {
        aspect
    };
    let cropped = x3f_render::jpeg_letterbox(bytes, stored).ok()??;
    fits_aspect(&cropped, orientation, info).then_some(cropped)
}

/// The upright aspect (width / height) that a preview of `info` shows: the
/// as-shot crop when there is one, else the native dimensions.
fn shown_aspect(info: &crate::source::Info) -> Option<f64> {
    let [width, height] = info.native_dimensions?;
    let [_, _, crop_width, crop_height] = info.crop.unwrap_or([0., 0., 1., 1.]);
    let aspect =
        f64::from(width) * f64::from(crop_width) / (f64::from(height) * f64::from(crop_height));
    (aspect.is_finite() && aspect > 0.).then_some(aspect)
}

/// True when a JPEG is large enough for the fit view of `info`: a long edge of
/// `MIN_FIT_PREVIEW_EDGE` or more, or of the shown image when that is smaller
/// (the rendered preview of a small RAW).
pub(crate) fn fit_size(bytes: &[u8], info: &crate::source::Info) -> bool {
    let Some((width, height)) = jpeg_size(bytes) else {
        return false;
    };
    let Some([native_width, native_height]) = info.native_dimensions else {
        return false;
    };
    let [_, _, crop_width, crop_height] = info.crop.unwrap_or([0., 0., 1., 1.]);
    let shown = (f64::from(native_width) * f64::from(crop_width))
        .max(f64::from(native_height) * f64::from(crop_height));
    let edge = width.max(height);
    edge >= MIN_FIT_PREVIEW_EDGE || f64::from(edge) >= 0.99 * shown
}

/// True when the upright JPEG is within 2% of the shown aspect of `info`.
/// `orientation` applies when the JPEG has none.
pub(crate) fn fits_aspect(bytes: &[u8], orientation: u8, info: &crate::source::Info) -> bool {
    let (Some((width, height)), Some(aspect)) =
        (upright_size(bytes, orientation), shown_aspect(info))
    else {
        return false;
    };
    (width / height / aspect - 1.).abs() <= 0.02
}

/// The upright width and height of a JPEG. `orientation` applies when the JPEG has none.
pub fn upright_size(bytes: &[u8], orientation: u8) -> Option<(f64, f64)> {
    let (width, height) = jpeg_size(bytes)?;
    let (width, height) = (f64::from(width), f64::from(height));
    Some(
        if (5..=8).contains(&jpeg_orientation(bytes).unwrap_or(orientation)) {
            (height, width)
        } else {
            (width, height)
        },
    )
}

/// The stored width and height of a JPEG, from its frame header. No decode.
pub fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if !is_jpeg(bytes) {
        return None;
    }
    let mut at = 2;
    loop {
        if *bytes.get(at)? != 0xff {
            return None;
        }
        let marker = *bytes.get(at + 1)?;
        match marker {
            0xff => at += 1,
            0x01 | 0xd0..=0xd7 => at += 2,
            0xd9 | 0xda => return None,
            _ => {
                let word =
                    |at: usize| Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]));
                // SOF0 to SOF15, without DHT (c4), JPG (c8) and DAC (cc).
                if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                    let (height, width) = (word(at + 5)?, word(at + 7)?);
                    return (width > 0 && height > 0).then_some((width.into(), height.into()));
                }
                let length = usize::from(word(at + 2)?);
                if length < 2 {
                    return None;
                }
                at += 2 + length;
            }
        }
    }
}

pub(crate) fn jpeg_orientation(bytes: &[u8]) -> Option<u8> {
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
    let native_dimensions = source.as_ref().ok().and_then(|info| info.native_dimensions);
    let as_shot_crop = source.as_ref().ok().and_then(|info| info.crop);
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
    let preview_revision = crate::cache::source_key(&path);
    Ok(FileDto {
        source_kind,
        capabilities,
        id: uuid::Uuid::new_v4().to_string(),
        file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        path,
        file_size: info.len(),
        preview_revision,
        captured_date,
        orientation,
        aspect_ratio: None,
        native_dimensions,
        as_shot_crop,
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
pub(crate) mod tests {
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

    /// A gray JPEG without EXIF.
    pub(crate) fn jpeg(width: u32, height: u32, value: u16) -> Vec<u8> {
        x3f_render::RenderedImage {
            width,
            height,
            full_width: width,
            full_height: height,
            data: x3f_render::Pixels::Rgb16(vec![value; (width * height * 3) as usize]),
            color_profile: x3f_render::ColorProfile::Srgb,
            region: None,
        }
        .jpeg(90)
        .unwrap()
    }

    pub(crate) fn info(
        native: [u32; 2],
        orientation: u8,
        crop: Option<[f32; 4]>,
    ) -> crate::source::Info {
        crate::source::Info {
            kind: crate::source::Kind::Dng,
            capabilities: crate::source::Capabilities::for_kind(crate::source::Kind::Dng, false),
            crop,
            native_dimensions: Some(native),
            orientation: Some(orientation),
            iso: None,
        }
    }

    #[test]
    fn embedded_jpeg_choice_follows_size_aspect_and_orientation() {
        let size = |bytes: &Option<Vec<u8>>| bytes.as_deref().and_then(jpeg_size);
        let candidates = || {
            vec![
                jpeg(160, 120, GRAY),
                jpeg(1500, 1000, GRAY),
                jpeg(480, 320, GRAY),
            ]
        };
        let landscape = info([3000, 2000], 1, None);
        let fit = choose(candidates(), 1, Some(&landscape), true);
        assert_eq!(size(&fit), Some((1500, 1000)));
        assert_eq!(jpeg_orientation(fit.as_deref().unwrap()), Some(1));
        // The 4:3 JPEG does not match 3:2 and has no letterbox bands to crop.
        let small = choose(candidates(), 1, Some(&landscape), false);
        assert_eq!(size(&small), Some((480, 320)));
        // Without a JPEG of 320 or more, the thumbnail takes the largest.
        let tiny = vec![jpeg(240, 160, GRAY), jpeg(120, 80, GRAY)];
        assert_eq!(
            size(&choose(tiny.clone(), 1, Some(&landscape), false)),
            Some((240, 160))
        );
        // The fit view of a supported RAW never takes a small JPEG; it renders the RAW.
        assert!(choose(tiny.clone(), 1, Some(&landscape), true).is_none());
        // An unsupported RAW keeps any JPEG, of any aspect, for every view.
        assert_eq!(size(&choose(tiny, 6, None, true)), Some((240, 160)));
        assert_eq!(
            size(&choose(vec![jpeg(160, 120, GRAY)], 6, None, false)),
            Some((160, 120))
        );
        // Orientation 8: the stored 3:2 JPEG is upright 2:3, as the RAW.
        let portrait = info([2000, 3000], 8, None);
        let fit = choose(candidates(), 8, Some(&portrait), true).unwrap();
        assert_eq!(jpeg_orientation(&fit), Some(8));
        assert_eq!(upright_size(&fit, 1), Some((1000., 1500.)));
        assert!(choose(candidates(), 1, Some(&portrait), true).is_none());
        // A 4:3 as-shot crop of a 3:2 sensor accepts the 4:3 JPEG only.
        let cropped = info([5496, 3672], 1, Some([0.0575, 0.0033, 0.885, 0.9935]));
        let fit = choose(
            vec![jpeg(1440, 1080, GRAY), jpeg(1500, 1000, GRAY)],
            1,
            Some(&cropped),
            true,
        );
        assert_eq!(size(&fit), Some((1440, 1080)));
        assert!(choose(vec![], 1, Some(&cropped), false).is_none());
    }

    #[test]
    fn fit_view_of_a_supported_raw_needs_1024_pixels() {
        let landscape = info([3000, 2000], 1, None);
        // Only small accepted JPEGs: the fit view renders the RAW.
        let small = || vec![jpeg(960, 640, GRAY), jpeg(480, 320, GRAY)];
        assert!(choose(small(), 1, Some(&landscape), true).is_none());
        assert_eq!(
            choose(small(), 1, Some(&landscape), false)
                .as_deref()
                .and_then(jpeg_size),
            Some((480, 320))
        );
        assert!(fit_size(&jpeg(1024, 683, GRAY), &landscape));
        assert!(!fit_size(&jpeg(960, 640, GRAY), &landscape));
        // The rendered preview of a RAW smaller than 1024 pixels is its full size.
        let tiny = info([800, 600], 1, Some([0., 0., 0.75, 1.]));
        assert!(fit_size(&jpeg(600, 600, GRAY), &tiny));
        assert!(!fit_size(&jpeg(400, 400, GRAY), &tiny));
    }

    /// The import asks ExifTool for DNG previews in chunks of four paths.
    #[cfg(unix)]
    #[tokio::test]
    async fn import_reads_dng_previews_in_chunks() {
        let dir = tempfile::tempdir().unwrap();
        // Chunk calls (`-a`) log their path count and give each path a JPEG.
        // Metadata calls log their DNG and X3F counts and preview tags; the
        // DNG metadata call fails.
        let preview = base64::engine::general_purpose::STANDARD.encode(jpeg(400, 300, GRAY));
        std::fs::write(
            dir.path().join("exiftool"),
            r#"
            use strict;
            my @dngs = grep { /\.dng$/ } @ARGV;
            my @x3fs = grep { /\.X3F$/ } @ARGV;
            (my $dir = (@dngs, @x3fs)[0]) =~ s{/[^/]*$}{};
            my $log = sub { open(my $f, ">>", "$dir/$_[0]") or die $!; print $f "$_[1]\n"; close($f); };
            if (grep { $_ eq "-a" } @ARGV) {
                $log->("chunks", scalar(@dngs));
                print "[", join(",", map { qq({"SourceFile":"$_","IFD0:PreviewImage":"base64:PREVIEW"}) } @dngs), "]";
                exit 0;
            }
            my $previews = (grep { $_ eq "-PreviewImage" || $_ eq "-ThumbnailImage" } @ARGV) ? 1 : 0;
            $log->("metadata", scalar(@dngs) . " " . scalar(@x3fs) . " $previews");
            exit 1 if @dngs;
            print "[]";
        "#
            .replace("PREVIEW", &preview),
        )
        .unwrap();
        let mut paths: Vec<_> = (0..9)
            .map(|index| {
                let path = dir.path().join(format!("{index}.dng"));
                std::fs::write(&path, b"raw").unwrap();
                path
            })
            .collect();
        let x3f = dir.path().join("photo.X3F");
        std::fs::write(&x3f, b"raw").unwrap();
        paths.push(x3f.clone());
        let exif = ExifTool::new(
            dir.path().into(),
            dir.path().join("x3i"),
            Arc::new(crate::storage::Logs::new(dir.path().join("logs"))),
        );
        let found = exif.display(&paths).await;
        // The failed DNG metadata call keeps the chunk previews.
        assert_eq!(found.len(), 9);
        assert!(!found.contains_key(&x3f));
        for path in &paths[..9] {
            let meta = &found[path];
            assert_eq!(
                meta.preview.as_deref().and_then(jpeg_size),
                Some((400, 300))
            );
            assert!(meta.exif.is_empty());
        }
        let lines = |name: &str| {
            let mut lines: Vec<String> = std::fs::read_to_string(dir.path().join(name))
                .unwrap()
                .lines()
                .map(Into::into)
                .collect();
            lines.sort();
            lines
        };
        assert_eq!(lines("chunks"), ["1", "4", "4"]);
        // Only the X3F metadata call asks for binary previews.
        assert_eq!(lines("metadata"), ["0 1 1", "9 0 0"]);
        let args = display_args(&paths[..1], false);
        assert!(!args
            .iter()
            .any(|a| a == "-PreviewImage" || a == "-ThumbnailImage"));
        assert_eq!(args.last().unwrap(), paths[0].as_os_str());
    }

    const GRAY: u16 = 32768;

    /// A 1440x1080 JPEG: gray rows 60..1020, `band` rows elsewhere.
    fn banded(band: u16) -> Vec<u8> {
        let data = (0..1080)
            .flat_map(|row| {
                let value = if (60..1020).contains(&row) {
                    GRAY
                } else {
                    band
                };
                std::iter::repeat_n(value, 1440 * 3)
            })
            .collect();
        x3f_render::RenderedImage {
            width: 1440,
            height: 1080,
            full_width: 1440,
            full_height: 1080,
            data: x3f_render::Pixels::Rgb16(data),
            color_profile: x3f_render::ColorProfile::Srgb,
            region: None,
        }
        .jpeg(95)
        .unwrap()
    }

    #[test]
    fn letterbox_bands_are_cropped_only_when_black() {
        let landscape = info([5472, 3648], 1, None);
        for full in [false, true] {
            let cropped = choose(vec![banded(0)], 1, Some(&landscape), full).unwrap();
            assert_eq!(jpeg_size(&cropped), Some((1440, 960)));
            assert_eq!(jpeg_orientation(&cropped), Some(1));
            assert!(fits_aspect(&cropped, 1, &landscape));
            // 8/255 bands are content: the JPEG is rejected, and the RAW renders.
            assert!(choose(vec![banded(2048)], 1, Some(&landscape), full).is_none());
        }
        // Orientation 6: the bands are in the stored frame; the crop is upright 2:3.
        let portrait = info([3648, 5472], 6, None);
        let cropped = choose(vec![banded(0)], 6, Some(&portrait), true).unwrap();
        assert_eq!(jpeg_orientation(&cropped), Some(6));
        assert_eq!(upright_size(&cropped, 1), Some((960., 1440.)));
        // An unsupported RAW has no aspect rule: the bands stay.
        let kept = choose(vec![banded(2048)], 1, None, true).unwrap();
        assert_eq!(jpeg_size(&kept), Some((1440, 1080)));
    }

    #[test]
    fn jpeg_size_reads_the_frame_header_only() {
        let bytes = jpeg(37, 21, 0);
        assert_eq!(jpeg_size(&bytes), Some((37, 21)));
        let tagged = preview_orientation(bytes.clone(), 6).unwrap();
        assert_eq!(jpeg_size(&tagged), Some((37, 21)));
        assert_eq!(upright_size(&tagged, 1), Some((21., 37.)));
        // A header without its scan is enough; a truncated one is not.
        let sof = (2..bytes.len())
            .find(|&at| bytes[at] == 0xff && bytes[at + 1] == 0xc0)
            .unwrap();
        assert_eq!(jpeg_size(&bytes[..sof + 9]), Some((37, 21)));
        assert_eq!(jpeg_size(&bytes[..sof + 6]), None);
        assert_eq!(jpeg_size(b"\xff\xd8\xff\xda"), None);
        assert_eq!(jpeg_size(b"not a jpeg"), None);
    }

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
