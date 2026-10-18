//! Quattro SFD X3I support. An X3I holds complete X3F frames, and the
//! "FOVi" magic identifies it, not the file name. ExifTool reads only X3F
//! files, so metadata comes from a cached copy of frame 0. A merge takes
//! about 30 s and 3 GB, so the editor caches merged scenes on disk.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Mutex},
    time::{Duration, SystemTime},
};
use x3f_core::{
    prepare_scene_linear, SceneLinearImage, SceneLinearOptions, WhiteBalanceCalibration,
};

use crate::edits::SourceStamp;

/// The cache directory inside the app-data `edits` directory.
pub const DIRECTORY: &str = "x3i-v1";
/// Bump when x3f-core changes merged pixels or their calibration. The app
/// version is also part of each key, so a release starts a new cache.
const CACHE_VERSION: u32 = 2;
/// ponytail: one budget for frame copies and scenes, least recently used out first.
/// A dp0 Quattro scene is about 240 MB, an sd Quattro H scene about 310 MB.
const BUDGET: u64 = 3 << 30;
/// Pruning keeps files used this recently: ExifTool or a reader can have them open.
const IN_USE: Duration = Duration::from_secs(120);
/// The scene header is small JSON. A longer length means damage.
const HEADER_LIMIT: u32 = 64 * 1024;

/// One X3I merge at a time, in conversion and in the editor.
pub static MERGE: Mutex<()> = Mutex::new(());
/// One frame extraction at a time, so a second request uses the first copy.
static EXTRACT: Mutex<()> = Mutex::new(());

pub fn is_x3i(path: &Path) -> bool {
    x3f_core::is_x3i(path).unwrap_or(false)
}

/// Reads ExifTool metadata from `path`: for an X3I, a cached copy of the frame
/// that `source` uses, else the file itself. A merge uses the metadata of
/// frame 0, its reference exposure.
pub fn exif_source(
    cache: &Path,
    path: &Path,
    source: x3f_core::X3iSource,
) -> Result<PathBuf, String> {
    if !is_x3i(path) {
        return Ok(path.to_owned());
    }
    // The stamp detects replaced files and writes that restore the old mtime.
    let stamp = || -> Result<String, String> {
        let info = fs::metadata(path).map_err(|e| e.to_string())?;
        serde_json::to_string(&SourceStamp::new(&info)?).map_err(|e| e.to_string())
    };
    let _flight = EXTRACT.lock().map_err(|_| "X3I cache unavailable")?;
    let before = stamp()?;
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let container = x3f_core::X3iContainer::open(path).map_err(|e| e.to_string())?;
    let frame = if source == x3f_core::X3iSource::MiddleExposure {
        container
            .middle_exposure_frame()
            .map_err(|e| e.to_string())?
    } else {
        0
    };
    let key = format!("{CACHE_VERSION}:{}:{before}:{frame}", canonical.display());
    // Windows stamps have no file identity, so there a copy lasts one session,
    // as the fingerprints in `Edits` do.
    #[cfg(not(unix))]
    let key = {
        static SESSION: std::sync::OnceLock<uuid::Uuid> = std::sync::OnceLock::new();
        format!("{key}:{}", SESSION.get_or_init(uuid::Uuid::new_v4))
    };
    let target = cache.join(format!("{:x}.X3F", Sha256::digest(key)));
    if !hit(&target) {
        fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        let temporary = cache.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = container
            .extract_frame(frame, &temporary)
            .map_err(|e| e.to_string())
            .and_then(|()| {
                if stamp()? != before {
                    return Err("The source changed while being read; reopen the photo".into());
                }
                fs::rename(&temporary, &target).map_err(|e| e.to_string())
            });
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
    }
    prune(cache);
    Ok(target)
}

/// What changes an X3I's merged pixels apart from its contents and settings:
/// the cache and app versions, and every X3F_ variable. None for other files.
pub fn identity(path: &Path) -> Option<String> {
    if !is_x3i(path) {
        return None;
    }
    let environment: BTreeMap<_, _> = std::env::vars_os()
        .filter(|(name, _)| name.to_string_lossy().starts_with("X3F_"))
        .collect();
    Some(format!(
        "{CACHE_VERSION}:{}:{environment:?}",
        env!("CARGO_PKG_VERSION")
    ))
}

/// The error for an X3I scene that only an explicit merge may create.
pub const UNPROCESSED: &str = "Process this X3I before you edit it";

/// The number of frames in an X3I, else None.
pub fn frames(path: &Path) -> Option<u32> {
    if !is_x3i(path) {
        return None;
    }
    let container = x3f_core::X3iContainer::open(path).ok()?;
    u32::try_from(container.frames().len()).ok()
}

/// The scene cache file of a merged X3I, and whether no denoise setting
/// changes it. None for other files and for one frame, which prepares quickly.
fn scene_file(
    cache: &Path,
    path: &Path,
    source_revision: &str,
    options: &SceneLinearOptions,
) -> Option<(PathBuf, bool)> {
    if options.x3i_source != x3f_core::X3iSource::Merge {
        return None;
    }
    let identity = identity(path)?;
    let (settings, denoise_free) = scene_settings(
        options,
        std::env::var("X3F_X3I_DENOISE_SCALE").ok().as_deref(),
    );
    let key = format!("{identity}:{source_revision}:{settings:?}");
    // The photo name tells the user which photo a merged image belongs to. At
    // most 64 bytes of it keep the file name inside the 255-byte limit.
    let mut stem = String::new();
    for c in path.file_stem()?.to_string_lossy().chars() {
        if stem.len() + c.len_utf8() > 64 {
            break;
        }
        stem.push(c);
    }
    let hash = format!("{:x}", Sha256::digest(key));
    Some((
        cache.join(format!("{stem}-{}.sfd", &hash[..16])),
        denoise_free,
    ))
}

/// True when the merged scene of an X3I is in the cache.
pub fn processed(
    cache: &Path,
    path: &Path,
    source_revision: &str,
    options: &SceneLinearOptions,
) -> bool {
    scene_info(cache, path, source_revision, options).is_some()
}

/// The file name and size of the cached merged scene of an X3I, else None.
pub fn scene_info(
    cache: &Path,
    path: &Path,
    source_revision: &str,
    options: &SceneLinearOptions,
) -> Option<(String, u64)> {
    let (file, _) = scene_file(cache, path, source_revision, options)?;
    let info = fs::metadata(&file).ok().filter(|info| info.is_file())?;
    Some((file.file_name()?.to_string_lossy().into_owned(), info.len()))
}

/// Removes the cached merged scene of an X3I. A missing scene is not an error.
pub fn remove_scene(
    cache: &Path,
    path: &Path,
    source_revision: &str,
    options: &SceneLinearOptions,
) -> Result<(), String> {
    let Some((file, _)) = scene_file(cache, path, source_revision, options) else {
        return Ok(());
    };
    match fs::remove_file(file) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Prepares the editor scene. A merged X3I comes from the scene cache. Without
/// the cached scene, it merges only when `merge` is set, else it fails with
/// UNPROCESSED. A merge is cached when `merge` still confirms that the source
/// is unchanged. Other files, and the middle exposure of an X3I, prepare as an
/// X3F. Also returns true when no denoise setting can change the scene, which
/// is true for a merged X3I without core's experimental denoise.
pub fn prepare_scene(
    cache: &Path,
    path: &Path,
    source_revision: &str,
    options: &SceneLinearOptions,
    cancel: &AtomicBool,
    merge: Option<impl Fn() -> bool>,
    on_stage: impl FnMut(x3f_core::ConversionStage),
) -> Result<(SceneLinearImage, bool), String> {
    let Some((file, denoise_free)) = scene_file(cache, path, source_revision, options) else {
        return prepare_scene_linear(path, options, cancel, on_stage)
            .map(|scene| (scene, false))
            .map_err(|e| e.to_string());
    };
    if let Some(scene) = read_scene(&file) {
        prune(cache);
        return Ok((scene, denoise_free));
    }
    let Some(unchanged) = merge else {
        return Err(UNPROCESSED.into());
    };
    // Wait for another merge, but stop at cancellation.
    let _merge = loop {
        match MERGE.try_lock() {
            Ok(merge) => break merge,
            Err(std::sync::TryLockError::WouldBlock) => {
                if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Cancelled".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("X3I merge unavailable".into()),
        }
    };
    // Another preparation can have merged this scene during the wait.
    if let Some(scene) = read_scene(&file) {
        return Ok((scene, denoise_free));
    }
    let scene = prepare_scene_linear(path, options, cancel, on_stage).map_err(|e| e.to_string())?;
    if unchanged() {
        // A cache failure only makes the next open slow.
        if let Err(error) = write_scene(cache, &file, &scene) {
            eprintln!("Cannot cache the X3I scene: {error}");
        }
    }
    Ok((scene, denoise_free))
}

/// The settings that change merged pixels, for the cache key, and whether no
/// denoise setting changes them. X3I ignores highlight recovery. Core's
/// experimental denoise needs a positive X3F_X3I_DENOISE_SCALE, as in
/// x3f-core's `read_denoise_scale`; without it, denoise settings do nothing.
fn scene_settings(options: &SceneLinearOptions, scale: Option<&str>) -> (SceneLinearOptions, bool) {
    let filter = scale
        .and_then(|value| value.parse::<f32>().ok())
        .is_some_and(|scale| scale > 0.);
    let denoise = filter
        && options.denoise_intensity > 0
        && (options.denoise_options.luminance || options.denoise_options.chroma);
    let settings = SceneLinearOptions {
        highlight_recovery: false,
        ..*options
    };
    if denoise {
        return (settings, false);
    }
    let settings = SceneLinearOptions {
        denoise_intensity: 0,
        denoise_backend: Default::default(),
        denoise_options: Default::default(),
        ..settings
    };
    (settings, !filter)
}

#[derive(Serialize, Deserialize)]
struct Header {
    width: u32,
    height: u32,
    orientation: u16,
    camera_to_rgb: [f64; 9],
    xyz_to_camera: [f64; 9],
    as_shot_neutral: [f64; 3],
    color_mode: Option<ColorMode>,
}
/// `x3f_sys::ColorModeCalibration` without ColorDQ, which only Merrill has.
#[derive(Serialize, Deserialize)]
struct ColorMode {
    sensor_to_srgb: [f64; 9],
    wb_gain: [f64; 3],
    normalized_to_counts: [f64; 3],
    count_offset: [f64; 3],
    iso_gain: f64,
    output_to_srgb: [f64; 9],
}

/// File layout: header length (u32 LE), JSON header, then RGB f32 samples in
/// native byte order. Damage, or a file of the wrong size, is a cache miss,
/// and the file is removed, so the photo shows as unprocessed again.
fn read_scene(file: &Path) -> Option<SceneLinearImage> {
    let scene = read_scene_file(file);
    if scene.is_none() && file.is_file() {
        let _ = fs::remove_file(file);
    }
    scene
}

fn read_scene_file(file: &Path) -> Option<SceneLinearImage> {
    let mut input = fs::File::open(file).ok()?;
    let size = input.metadata().ok()?.len();
    let mut length = [0; 4];
    input.read_exact(&mut length).ok()?;
    let length = u32::from_le_bytes(length);
    if length > HEADER_LIMIT {
        return None;
    }
    let mut header = vec![0; length as usize];
    input.read_exact(&mut header).ok()?;
    let header: Header = serde_json::from_slice(&header).ok()?;
    let samples = u64::from(header.width)
        .checked_mul(u64::from(header.height))?
        .checked_mul(3)?;
    if samples == 0 || Some(size) != samples.checked_mul(4)?.checked_add(4 + u64::from(length)) {
        return None;
    }
    let mut data = vec![0f32; usize::try_from(samples).ok()?];
    input.read_exact(bytemuck::cast_slice_mut(&mut data)).ok()?;
    if !data
        .iter()
        .fold(true, |finite, value| finite & value.is_finite())
    {
        return None;
    }
    hit(file);
    Some(SceneLinearImage {
        data,
        width: header.width,
        height: header.height,
        orientation: header.orientation,
        white_balance: WhiteBalanceCalibration {
            camera_to_rgb: header.camera_to_rgb,
            xyz_to_camera: header.xyz_to_camera,
            as_shot_neutral: header.as_shot_neutral,
        },
        color_mode_calibration: header.color_mode.map(|c| x3f_sys::ColorModeCalibration {
            sensor_to_srgb: c.sensor_to_srgb,
            wb_gain: c.wb_gain,
            normalized_to_counts: c.normalized_to_counts,
            count_offset: c.count_offset,
            iso_gain: c.iso_gain,
            output_to_srgb: c.output_to_srgb,
            color_dq: None,
        }),
    })
}

fn write_scene(cache: &Path, file: &Path, scene: &SceneLinearImage) -> std::io::Result<()> {
    let color_mode = match &scene.color_mode_calibration {
        Some(c) if c.color_dq.is_some() => return Ok(()),
        c => c.as_ref().map(|c| ColorMode {
            sensor_to_srgb: c.sensor_to_srgb,
            wb_gain: c.wb_gain,
            normalized_to_counts: c.normalized_to_counts,
            count_offset: c.count_offset,
            iso_gain: c.iso_gain,
            output_to_srgb: c.output_to_srgb,
        }),
    };
    let header = serde_json::to_vec(&Header {
        width: scene.width,
        height: scene.height,
        orientation: scene.orientation,
        camera_to_rgb: scene.white_balance.camera_to_rgb,
        xyz_to_camera: scene.white_balance.xyz_to_camera,
        as_shot_neutral: scene.white_balance.as_shot_neutral,
        color_mode,
    })?;
    fs::create_dir_all(cache)?;
    let temporary = cache.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = BufWriter::new(fs::File::create_new(&temporary)?);
        output.write_all(&(header.len() as u32).to_le_bytes())?;
        output.write_all(&header)?;
        output.write_all(bytemuck::cast_slice(&scene.data))?;
        // Synchronize before publication: after a crash, a published file
        // must not contain zeros, which are valid samples.
        output.into_inner()?.sync_all()?;
        fs::rename(&temporary, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    prune(cache);
    Ok(())
}

/// True for an existing cache file, which is then the most recently used.
fn hit(file: &Path) -> bool {
    if !file.is_file() {
        return false;
    }
    let _ = fs::File::options()
        .append(true)
        .open(file)
        .and_then(|file| file.set_modified(SystemTime::now()));
    true
}

/// Removes the least recently used files, including abandoned temporary
/// files, until the cache fits its budget. ponytail: files used in the last
/// `IN_USE` stay, so a burst of imports can exceed the budget until a later
/// access or start prunes again.
pub fn prune(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let now = SystemTime::now();
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let info = entry.metadata().ok()?;
            info.is_file()
                .then(|| Some((info.modified().ok()?, info.len(), entry.path())))?
        })
        .collect();
    files.sort();
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    for (modified, size, file) in files {
        if total <= BUDGET {
            break;
        }
        if now.duration_since(modified).unwrap_or_default() >= IN_USE
            && fs::remove_file(&file).is_ok()
        {
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denoise_settings_change_x3i_scenes_only_with_the_experimental_filter() {
        let off = SceneLinearOptions {
            denoise_intensity: 0,
            ..Default::default()
        };
        let on = SceneLinearOptions::default();
        // Without the filter, every denoise setting gives one scene.
        assert_eq!(scene_settings(&on, None), scene_settings(&off, Some("0")));
        assert!(scene_settings(&on, None).1);
        // With it, a scene prepared at 0 must not serve a recipe at 10.
        let (zero, free) = scene_settings(&off, Some("0.3"));
        assert!(!free);
        assert_ne!(zero, scene_settings(&on, Some("0.3")).0);
    }

    #[test]
    fn deleted_scenes_are_no_longer_processed() {
        let cache = tempfile::tempdir().unwrap();
        let photo = cache.path().join("photo.X3I");
        fs::write(&photo, b"FOVi").unwrap();
        let options = SceneLinearOptions::default();
        assert_eq!(scene_info(cache.path(), &photo, "1", &options), None);
        let (file, _) = scene_file(cache.path(), &photo, "1", &options).unwrap();
        fs::write(&file, [0; 5]).unwrap();
        let (name, bytes) = scene_info(cache.path(), &photo, "1", &options).unwrap();
        assert!(name.starts_with("photo-") && name.ends_with(".sfd"));
        assert_eq!(bytes, 5);
        remove_scene(cache.path(), &photo, "1", &options).unwrap();
        assert!(!processed(cache.path(), &photo, "1", &options));
        // A long name keeps the cache file name short.
        let long = cache.path().join(format!("{}.X3I", "😀".repeat(59)));
        fs::write(&long, b"FOVi").unwrap();
        let (file, _) = scene_file(cache.path(), &long, "1", &options).unwrap();
        assert!(file.file_name().unwrap().len() <= 64 + 1 + 16 + 4);
        // A second removal, or the middle exposure, has nothing to remove.
        remove_scene(cache.path(), &photo, "1", &options).unwrap();
        let middle = SceneLinearOptions {
            x3i_source: x3f_core::X3iSource::MiddleExposure,
            ..Default::default()
        };
        remove_scene(cache.path(), &photo, "1", &middle).unwrap();
    }

    #[test]
    fn scenes_round_trip_and_damaged_files_are_misses() {
        let cache = tempfile::tempdir().unwrap();
        let file = cache.path().join("scene.scene");
        let scene = SceneLinearImage {
            data: vec![0.25, -0.5, 8., 1., 2., 3.],
            width: 2,
            height: 1,
            orientation: 6,
            white_balance: WhiteBalanceCalibration {
                camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                xyz_to_camera: [2.; 9],
                as_shot_neutral: [0.5, 1., 0.75],
            },
            color_mode_calibration: None,
        };
        write_scene(cache.path(), &file, &scene).unwrap();
        let read = read_scene(&file).unwrap();
        assert_eq!(read.data, scene.data);
        assert_eq!((read.width, read.height, read.orientation), (2, 1, 6));
        assert_eq!(read.white_balance.xyz_to_camera, [2.; 9]);
        let bytes = fs::read(&file).unwrap();
        fs::write(&file, &bytes[..bytes.len() - 1]).unwrap();
        assert!(read_scene(&file).is_none());
        // A damaged scene is removed, so the photo can merge again.
        assert!(!file.exists());
        let mut nan = bytes.clone();
        let end = nan.len();
        nan[end - 4..].copy_from_slice(&f32::NAN.to_ne_bytes());
        fs::write(&file, nan).unwrap();
        assert!(read_scene(&file).is_none());
    }
}
