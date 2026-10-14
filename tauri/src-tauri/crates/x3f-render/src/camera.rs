//! Picture modes from the file's CAMF calibration. No invented color presets.
use crate::{color, EditRecipe, MonochromeSettings, RenderError};
use serde::Serialize;
use std::{
    ffi::CString,
    path::Path,
    ptr::NonNull,
    sync::{atomic::AtomicBool, OnceLock},
};
use x3f_sys::{self as sys, sysabi as libc};

pub(crate) const MODES: &[(&str, &str)] = &[
    ("Standard", "Standard"),
    ("Vivid", "Vivid"),
    ("Neutral", "Neutral"),
    ("Portrait", "Portrait"),
    ("Landscape", "Landscape"),
    ("FCBlue", "FOV Classic Blue"),
    ("FCYellow", "FOV Classic Yellow"),
    ("Cinema", "Cinema"),
    ("ForestGreen", "Forest Green"),
    ("SunsetRed", "Sunset Red"),
    ("Monochrome", "Monochrome"),
];
const IDENTITY: [f64; 9] = [1., 0., 0., 0., 1., 0., 0., 0., 1.];
/// Rows of Sigma's native tone curve, one per count at a 12-bit saturation.
pub(crate) const NATIVE_TONE_ROWS: usize = 4096;
/// Rows of Merrill ColorDQ tables, the largest size Sigma builds.
pub(crate) const COLOR_DQ_ROWS: usize = 8192;
pub(crate) const LOOK_ROWS: usize = 256 + 21 + NATIVE_TONE_ROWS + COLOR_DQ_ROWS;

#[derive(Clone, Debug, Serialize)]
pub struct CameraProfile {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug)]
pub(crate) struct Calibration {
    pub matrix: [f64; 9],
    pub tone: [f32; 256],
    pub hue_sat: [[f32; 4]; 21],
    /// Sigma's native Color Mode (Merrill and dp Quattro). With the scene's
    /// `color_mode_calibration`, its matrices and tone curve replace the three
    /// fields above.
    pub native: Option<Native>,
}
impl Default for Calibration {
    fn default() -> Self {
        Self {
            matrix: IDENTITY,
            tone: std::array::from_fn(|i| i as f32 / 255.),
            hue_sat: [[0., 1., 0., 0.]; 21],
            native: None,
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Native {
    pub params: sys::ColorModeParameters,
    tone: OnceLock<Vec<f32>>,
}
impl Native {
    pub(crate) fn new(params: sys::ColorModeParameters) -> Self {
        Self {
            params,
            tone: OnceLock::new(),
        }
    }
    /// The linear tone curve over counts 0 to saturation, in
    /// `NATIVE_TONE_ROWS` steps. It is built on first use: building every
    /// mode when a photo opens would take a noticeable fraction of a second.
    pub(crate) fn tone(&self) -> Result<&[f32], RenderError> {
        if let Some(tone) = self.tone.get() {
            return Ok(tone);
        }
        let lut = sys::color_mode_linear_tone_lut(&self.params, 0., sys::Control::none())
            .map_err(raw_error)?;
        let last = lut.len() - 1;
        let step = self.params.pixel_saturation / (NATIVE_TONE_ROWS - 1) as f64;
        let tone = (0..NATIVE_TONE_ROWS)
            .map(|row| {
                let count = row as f64 * step;
                let (index, fraction) = (count as usize, count.fract());
                let at = |i: usize| lut[i.min(last)];
                (at(index) * (1. - fraction) + at(index + 1) * fraction) as f32
            })
            .collect();
        Ok(self.tone.get_or_init(|| tone))
    }
    /// Linear luminance this mode renders for a neutral scene value.
    fn neutral_luminance(
        &self,
        sensor: &sys::ColorModeCalibration,
        to_counts: &[f64; 9],
        offset: [f64; 3],
        value: f64,
    ) -> Result<f64, RenderError> {
        let tone = self.tone()?;
        let rows = self.rows_per_count() as f64;
        let last = (NATIVE_TONE_ROWS - 1) as f64;
        let toned: [f64; 3] = std::array::from_fn(|c| {
            let count = (0..3).map(|j| to_counts[c * 3 + j] * value).sum::<f64>() + offset[c];
            let at = (count.max(0.) * rows).min(last);
            let (row, fraction) = (at as usize, at.fract());
            let next = (row + 1).min(NATIVE_TONE_ROWS - 1);
            f64::from(tone[row]) * (1. - fraction) + f64::from(tone[next]) * fraction
        });
        let output = q12(sensor.output_to_srgb);
        Ok((0..3)
            .map(|r| {
                [0.2126, 0.7152, 0.0722][r]
                    * (0..3).map(|c| output[r * 3 + c] * toned[c]).sum::<f64>()
            })
            .sum())
    }
    /// Shader scale from native counts to tone rows.
    pub(crate) fn rows_per_count(&self) -> f32 {
        ((NATIVE_TONE_ROWS - 1) as f64 / self.params.pixel_saturation) as f32
    }
}
#[derive(Clone, Debug, Default)]
pub struct CameraProfiles {
    pub available: Vec<CameraProfile>,
    pub as_shot: String,
    calibrations: Vec<(String, Calibration)>,
}
/// Sigma's 12-bit fixed-point output matrix, rounded as x3f-core
/// `quantized_output` does.
pub(crate) fn q12(matrix: [f64; 9]) -> [f64; 9] {
    matrix.map(|v| f64::from(v.mul_add(4096., 0.5) as i32) / 4096.)
}
/// The scene value the fitted digital curve renders as 18% gray.
pub(crate) fn fallback_metered_gray() -> f64 {
    (0.093 * 0.184 / (1. - 0.184f64)).powf(1. / 1.63)
}
impl CameraProfiles {
    /// The scene value this camera renders as 18% gray: Sigma's Standard
    /// Color Mode with the scene's sensor calibration, else the fitted curve.
    /// It places the camera's metering in the scene, which film needs to
    /// expose a metered mid-gray as its own.
    /// A calibration that cannot meter falls back to the fitted curve.
    pub(crate) fn metered_gray(
        &self,
        sensor: Option<&sys::ColorModeCalibration>,
        camera_to_rgb: [f64; 9],
    ) -> f64 {
        let standard = self
            .calibrations
            .iter()
            .find(|(mode, _)| mode == "Standard")
            .and_then(|(_, calibration)| calibration.native.as_ref());
        let metered = || -> Result<f64, RenderError> {
            let (Some(native), Some(sensor)) = (standard, sensor) else {
                return Err(RenderError::Invalid("No native Color Mode".into()));
            };
            let (counts, offset) = sensor.render_matrix(&native.params);
            let to_counts = color::multiply(counts, color::inverse(camera_to_rgb)?);
            // Bisect in log space; the curve rises monotonically.
            let (mut lo, mut hi) = (1e-4f64.ln(), 4f64.ln());
            for _ in 0..48 {
                let mid = 0.5 * (lo + hi);
                if native.neutral_luminance(sensor, &to_counts, offset, mid.exp())? < 0.184 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            Ok((0.5 * (lo + hi)).exp())
        };
        // Reject a gray pinned to the search bounds (or NaN): film exposure
        // would jump by orders of magnitude.
        metered()
            .ok()
            .filter(|gray| (1e-3..=2.).contains(gray))
            .unwrap_or_else(fallback_metered_gray)
    }
    /// The selected profile's native Color Mode. Film stocks have their own
    /// colour response.
    pub(crate) fn native(&self, recipe: &EditRecipe) -> Result<Option<&Native>, RenderError> {
        if recipe.film.is_some() {
            return Ok(None);
        }
        Ok(self
            .selected(recipe)?
            .and_then(|calibration| calibration.native.as_ref()))
    }
    pub(crate) fn selected(
        &self,
        recipe: &EditRecipe,
    ) -> Result<Option<&Calibration>, RenderError> {
        let Some(id) = recipe.camera_profile.as_deref() else {
            return Ok(None);
        };
        if id == "Monochrome" {
            return Ok(None);
        }
        if !MODES.iter().any(|(mode, _)| *mode == id) {
            return Err(RenderError::Invalid(format!("Unknown camera profile {id}")));
        }
        Ok(self
            .calibrations
            .iter()
            .find(|(mode, _)| mode == id)
            .or_else(|| {
                self.calibrations
                    .iter()
                    .find(|(mode, _)| mode == "Standard")
            })
            .map(|(_, calibration)| calibration))
    }
}

pub(crate) fn effective_recipe(recipe: &EditRecipe) -> EditRecipe {
    let mut recipe = recipe.clone();
    if recipe.camera_profile.as_deref() == Some("Monochrome") {
        recipe
            .monochrome
            .get_or_insert(MonochromeSettings::default());
    }
    recipe
}

struct Metadata {
    file: NonNull<libc::FILE>,
    raw: NonNull<sys::x3f_t>,
}
impl Drop for Metadata {
    fn drop(&mut self) {
        // SAFETY: this handle owns the parsed metadata and its open stream.
        unsafe {
            sys::x3f_delete(self.raw.as_ptr());
            libc::fclose(self.file.as_ptr());
        }
    }
}
impl Metadata {
    fn open(path: &Path, cancel: &AtomicBool) -> Result<Self, RenderError> {
        let control = sys::Control::new(cancel);
        control.check().map_err(raw_error)?;
        #[cfg(not(windows))]
        let stream = {
            use std::os::unix::ffi::OsStrExt;
            let path = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| RenderError::Invalid("Source path contains NUL".into()))?;
            // SAFETY: both strings are terminated and remain alive during fopen.
            unsafe { libc::fopen(path.as_ptr(), c"rb".as_ptr()) }
        };
        #[cfg(windows)]
        let stream = {
            use std::os::windows::ffi::OsStrExt;
            let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
            if path.contains(&0) {
                return Err(RenderError::Invalid("Source path contains NUL".into()));
            }
            path.push(0);
            unsafe extern "C" {
                fn _wfopen(path: *const u16, mode: *const u16) -> *mut libc::FILE;
            }
            // SAFETY: the path and mode are terminated UTF-16 strings.
            unsafe { _wfopen(path.as_ptr(), [b'r' as u16, b'b' as u16, 0].as_ptr()) }
        };
        let file = NonNull::new(stream)
            .ok_or_else(|| RenderError::Invalid(std::io::Error::last_os_error().to_string()))?;
        // SAFETY: the stream remains open until this handle is dropped.
        let parsed = unsafe { sys::new_from_file(file.as_ptr().cast(), control) };
        let raw = match parsed {
            Ok(pointer) => NonNull::new(pointer),
            Err(error) => {
                unsafe { libc::fclose(file.as_ptr()) };
                return Err(raw_error(error));
            }
        };
        let Some(raw) = raw else {
            unsafe { libc::fclose(file.as_ptr()) };
            return Err(RenderError::Invalid("Invalid X3F metadata".into()));
        };
        let metadata = Self { file, raw };
        // SAFETY: all sections belong to this unique parsed file.
        unsafe {
            for section in [
                sys::x3f_get_camf(raw.as_ptr()),
                sys::x3f_get_prop(raw.as_ptr()),
            ] {
                if !section.is_null() {
                    sys::load_data(raw.as_ptr(), section, control).map_err(raw_error)?;
                }
            }
        }
        Ok(metadata)
    }
    fn matrix(&self, name: &str) -> Option<[f64; 9]> {
        let name = CString::new(name).ok()?;
        let mut values = [0.; 9];
        // SAFETY: the metadata is alive and the output has nine matrix slots.
        let found = unsafe {
            sys::x3f_get_camf_matrix(
                self.raw.as_ptr(),
                name.as_ptr().cast_mut(),
                3,
                3,
                0,
                sys::matrix_type_t_M_FLOAT,
                values.as_mut_ptr().cast(),
            )
        };
        (found != 0).then_some(values)
    }
    fn contrast(&self, mode: &str) -> Option<f64> {
        let name = CString::new(format!("CMCC_{mode}")).ok()?;
        let mut value = 0.;
        // SAFETY: the accessor writes one float to this output slot.
        let found = unsafe {
            sys::x3f_get_camf_float(self.raw.as_ptr(), name.as_ptr().cast_mut(), &mut value)
        };
        (found != 0).then_some(value)
    }
    fn hue_sat(&self, mode: &str) -> Option<[f64; 210]> {
        let name = CString::new(format!("MultiAxisTable_{mode}")).ok()?;
        let mut values = [0.; 210];
        // SAFETY: the output matches Sigma's 2 by 5 by 21 table dimensions.
        let found = unsafe {
            sys::x3f_get_camf_matrix(
                self.raw.as_ptr(),
                name.as_ptr().cast_mut(),
                2,
                5,
                21,
                sys::matrix_type_t_M_FLOAT,
                values.as_mut_ptr().cast(),
            )
        };
        (found != 0).then_some(values)
    }
}
fn raw_error(error: sys::Error) -> RenderError {
    match error {
        sys::Error::Cancelled => RenderError::Cancelled,
        error => RenderError::Invalid(error.to_string()),
    }
}

/// Reads available picture modes without decoding the sensor image.
pub fn read_camera_profiles(
    path: &Path,
    cancel: &AtomicBool,
) -> Result<CameraProfiles, RenderError> {
    // A photo with unreadable camera metadata still opens. It offers Standard,
    // which then renders with the legacy color transform.
    let metadata = match Metadata::open(path, cancel) {
        Ok(metadata) => metadata,
        Err(error @ RenderError::Invalid(_)) => {
            eprintln!("Using Standard for {}: {error}", path.display());
            return profiles_from_calibration("", |_| Ok(None));
        }
        Err(error) => return Err(error),
    };
    let mut base = [0.; 9];
    let mut xyz_to_rgb = [0.; 9];
    // SAFETY: this reader owns the header, white balance and output matrices.
    let logged = unsafe {
        let header = &(*metadata.raw.as_ptr()).header;
        let bytes: Vec<u8> = header
            .color_mode
            .iter()
            .map(|v| *v as u8)
            .take_while(|v| *v != 0)
            .collect();
        let wb = sys::x3f_get_wb(metadata.raw.as_ptr());
        sys::x3f_get_bmt_to_xyz(metadata.raw.as_ptr(), wb, base.as_mut_ptr());
        sys::x3f_XYZ_to_sRGB(xyz_to_rgb.as_mut_ptr());
        String::from_utf8_lossy(&bytes).trim().to_owned()
    };
    let camera_to_rgb = color::multiply(xyz_to_rgb, base);
    let inverse = color::inverse(camera_to_rgb).ok();
    let profiles = profiles_from_calibration(&logged, |id| {
        sys::Control::new(cancel).check().map_err(raw_error)?;
        let ccm = metadata.matrix(&format!("CMCM_{id}"));
        if id != "Standard" && ccm.is_none() {
            return Ok(None);
        }
        let mut calibration = Calibration::default();
        if let Some(ccm) = ccm {
            color::inverse(ccm)?;
            let inverse = inverse
                .ok_or_else(|| RenderError::Invalid("Missing camera color calibration".into()))?;
            calibration.matrix = color::multiply(color::multiply(camera_to_rgb, ccm), inverse);
        }
        if let Some(contrast) = metadata.contrast(id) {
            if !contrast.is_finite() {
                return Err(RenderError::Invalid(
                    "Invalid camera contrast calibration".into(),
                ));
            }
            calibration.tone = tone_curve(contrast);
        }
        if let Some(table) = metadata.hue_sat(id) {
            if table.iter().any(|v| !v.is_finite()) || table[105..].iter().any(|v| *v < 0.) {
                return Err(RenderError::Invalid(
                    "Invalid camera hue calibration".into(),
                ));
            }
            // Sigma's five rows match. The core DNG writer uses the first row.
            calibration.hue_sat =
                std::array::from_fn(|i| [table[i] as f32, table[105 + i] as f32, 0., 0.]);
        }
        // Sigma's own rendering of this mode. Other sensors have none.
        if let Ok(mode) = id.parse::<sys::ColorMode>() {
            // SAFETY: the metadata owns its loaded CAMF and PROP sections.
            match unsafe { sys::resolve_color_mode(metadata.raw.as_ptr(), mode) } {
                Ok(params) => calibration.native = Some(Native::new(params)),
                Err(sys::Error::Cancelled) => return Err(RenderError::Cancelled),
                Err(_) => {}
            }
        }
        if calibration
            .matrix
            .iter()
            .any(|v| !v.is_finite() || !(*v as f32).is_finite())
            || calibration.hue_sat.iter().flatten().any(|v| !v.is_finite())
        {
            return Err(RenderError::Invalid(
                "Invalid camera profile calibration".into(),
            ));
        }
        Ok(Some(calibration))
    })?;
    sys::Control::new(cancel).check().map_err(raw_error)?;
    Ok(profiles)
}

fn profiles_from_calibration(
    logged: &str,
    mut read: impl FnMut(&str) -> Result<Option<Calibration>, RenderError>,
) -> Result<CameraProfiles, RenderError> {
    let mut profiles = CameraProfiles::default();
    for &(id, name) in MODES {
        let calibration = if id == "Monochrome" {
            None
        } else {
            match read(id) {
                Ok(calibration) => calibration,
                Err(error @ RenderError::Invalid(_)) => {
                    eprintln!("Skipping invalid camera profile calibration {id}: {error}");
                    None
                }
                Err(error) => return Err(error),
            }
        };
        if calibration.is_some() || id == "Standard" || id == "Monochrome" {
            profiles.available.push(CameraProfile {
                id: id.into(),
                name: name.into(),
            });
            if let Some(calibration) = calibration {
                profiles.calibrations.push((id.into(), calibration));
            }
        }
    }
    profiles.as_shot = if profiles.available.iter().any(|p| p.id == logged) {
        logged
    } else {
        "Standard"
    }
    .into();
    Ok(profiles)
}

fn tone_curve(contrast: f64) -> [f32; 256] {
    // These reference deltas are copied from x3f-core's DNG tone curve synthesis.
    static DELTAS: std::sync::OnceLock<[[f32; 256]; 2]> = std::sync::OnceLock::new();
    let deltas = DELTAS.get_or_init(|| {
        let values: [Vec<f32>; 2] =
            serde_json::from_str(include_str!("../assets/camera-tone-deltas.json"))
                .expect("valid bundled camera curves");
        values.map(|curve| curve.try_into().expect("256 camera curve samples"))
    });
    let reference = &deltas[usize::from(contrast < 0.)];
    let scale = if contrast.abs() < 1e-3 {
        0.
    } else {
        (contrast.abs() / 0.3).min(1.) as f32
    };
    std::array::from_fn(|i| (i as f32 / 255. + scale * reference[i]).clamp(0., 1.))
}

pub(crate) fn look_table(
    calibration: Option<&Calibration>,
    native_tone: Option<&[f32]>,
    color_dq: Option<&sys::ColorModeColorDq>,
) -> Vec<[f32; 4]> {
    let identity = Calibration::default();
    let calibration = calibration.unwrap_or(&identity);
    let native = native_tone.map_or(vec![0.; NATIVE_TONE_ROWS], <[f32]>::to_vec);
    let tables = color_dq.map(|dq| dq.tables());
    let dq = (0..COLOR_DQ_ROWS).map(|row| {
        let at = |c: usize| {
            tables.map_or(0., |t: [&[i16]; 3]| {
                t[c].get(row).map_or(0., |&v| f32::from(v))
            })
        };
        [at(0), at(1), at(2), 0.]
    });
    calibration
        .tone
        .iter()
        .map(|&value| [value, 0., 0., 0.])
        .chain(calibration.hue_sat)
        .chain(native.into_iter().map(|value| [value, 0., 0., 0.]))
        .chain(dq)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn available_modes_and_logged_defaults_follow_file_calibration() {
        let profiles = profiles_from_calibration("FCBlue", |id| {
            Ok(matches!(id, "Standard" | "FCBlue" | "ForestGreen").then(Calibration::default))
        })
        .unwrap();
        assert_eq!(
            profiles
                .available
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["Standard", "FCBlue", "ForestGreen", "Monochrome"]
        );
        assert_eq!(profiles.as_shot, "FCBlue");
        let absent = profiles_from_calibration("Vivid", |_| Ok(None)).unwrap();
        assert_eq!(absent.as_shot, "Standard");
        assert_eq!(absent.available.len(), 2);
        assert_eq!(
            profiles_from_calibration("Monochrome", |_| Ok(None))
                .unwrap()
                .as_shot,
            "Monochrome"
        );
    }
    #[test]
    fn calibration_tone_uses_core_reference_and_extended_endpoints() {
        let identity = tone_curve(0.);
        let vivid = tone_curve(0.3);
        let neutral = tone_curve(-0.3);
        assert_eq!((vivid[0], vivid[255]), (0., 1.));
        assert!(vivid[128] > identity[128] && neutral[128] < identity[128]);
        assert!((vivid[128] - identity[128] - 0.05846643).abs() < 1e-7);
        assert!((neutral[128] - identity[128] + 0.0414407).abs() < 1e-7);
        assert!((tone_curve(0.15)[128] - (vivid[128] + identity[128]) * 0.5).abs() < 1e-6);
        assert_eq!(tone_curve(1.), vivid);
        assert_eq!(look_table(None, None, None).len(), LOOK_ROWS);
    }
    #[test]
    fn legacy_recipes_remain_color_and_known_unavailable_modes_use_standard() {
        let recipe: EditRecipe = serde_json::from_str(r#"{"exposure":1}"#).unwrap();
        assert_eq!(recipe.camera_profile, None);
        assert_eq!(effective_recipe(&recipe), recipe);
        let mono = EditRecipe {
            camera_profile: Some("Monochrome".into()),
            film: None,
            ..recipe.clone()
        };
        assert_eq!(
            effective_recipe(&mono).monochrome,
            Some(MonochromeSettings::default())
        );
        let unavailable = EditRecipe {
            camera_profile: Some("FCBlue".into()),
            ..recipe
        };
        assert!(CameraProfiles::default()
            .selected(&unavailable)
            .unwrap()
            .is_none());
        let profiles = profiles_from_calibration("Standard", |id| {
            Ok((id == "Standard").then(|| Calibration {
                tone: tone_curve(0.15),
                ..Default::default()
            }))
        })
        .unwrap();
        assert_eq!(
            profiles.selected(&unavailable).unwrap().unwrap().tone,
            tone_curve(0.15)
        );
        let recipe = EditRecipe {
            camera_profile: Some("ForestGreen".into()),
            film: None,
            ..Default::default()
        };
        let json = serde_json::to_string(&recipe).unwrap();
        assert_eq!(serde_json::from_str::<EditRecipe>(&json).unwrap(), recipe);
        assert!(EditRecipe {
            camera_profile: Some("Unknown".into()),
            ..recipe
        }
        .validate()
        .is_err());
    }
    #[test]
    fn damaged_picture_modes_are_omitted_without_losing_healthy_modes() {
        let profiles = profiles_from_calibration("FCBlue", |id| match id {
            "FCBlue" => Err(RenderError::Invalid("Non-finite camera matrix".into())),
            "Standard" | "ForestGreen" => Ok(Some(Calibration::default())),
            _ => Ok(None),
        })
        .unwrap();
        assert_eq!(
            profiles
                .available
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["Standard", "ForestGreen", "Monochrome"]
        );
        assert_eq!(profiles.as_shot, "Standard");
        let profiles = profiles_from_calibration("Standard", |id| match id {
            "Standard" => Err(RenderError::Invalid("Invalid contrast".into())),
            "FCBlue" => Ok(Some(Calibration::default())),
            _ => Ok(None),
        })
        .unwrap();
        assert_eq!(
            profiles
                .available
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["Standard", "FCBlue", "Monochrome"]
        );
        let standard = EditRecipe {
            camera_profile: Some("Standard".into()),
            ..Default::default()
        };
        assert!(profiles.selected(&standard).unwrap().is_none());
        assert!(matches!(
            profiles_from_calibration("FCBlue", |id| {
                if id == "FCBlue" {
                    Err(RenderError::Cancelled)
                } else {
                    Ok(None)
                }
            }),
            Err(RenderError::Cancelled)
        ));
    }
    #[test]
    fn profile_reader_cancels_and_falls_back_to_standard_for_unreadable_metadata() {
        assert!(matches!(
            read_camera_profiles(Path::new("missing.X3F"), &AtomicBool::new(true)),
            Err(RenderError::Cancelled)
        ));
        let profiles = read_camera_profiles(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(profiles.as_shot, "Standard");
        assert_eq!(
            profiles
                .available
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["Standard", "Monochrome"]
        );
        let standard = EditRecipe {
            camera_profile: Some("Standard".into()),
            ..Default::default()
        };
        assert!(profiles.selected(&standard).unwrap().is_none());
    }
    #[test]
    #[ignore = "set X3F_CAMERA_PROFILE_INPUT to a real camera file"]
    fn camera_metadata_from_real_x3f() {
        let input = std::env::var_os("X3F_CAMERA_PROFILE_INPUT").expect("X3F_CAMERA_PROFILE_INPUT");
        let profiles = read_camera_profiles(Path::new(&input), &AtomicBool::new(false)).unwrap();
        assert!(profiles.available.iter().any(|p| p.id == "Standard"));
        assert!(profiles.available.iter().any(|p| p.id == "Monochrome"));
        assert!(profiles.available.iter().any(|p| p.id == profiles.as_shot));
        assert!(
            profiles.available.len() > 2,
            "Camera modes must come from real file calibration"
        );
        for p in &profiles.available {
            let recipe = EditRecipe {
                camera_profile: Some(p.id.clone()),
                film: None,
                ..Default::default()
            };
            assert!(profiles.selected(&recipe).is_ok());
        }
        eprintln!(
            "as-shot: {}; available: {:?}",
            profiles.as_shot, profiles.available
        );
    }
    #[test]
    #[ignore = "requires a GPU and X3F_CAMERA_PROFILE_INPUT with FCBlue calibration"]
    fn real_camera_profiles_render_from_core_sensor_calibration() {
        let input = std::env::var_os("X3F_CAMERA_PROFILE_INPUT").expect("X3F_CAMERA_PROFILE_INPUT");
        let path = Path::new(&input);
        let cancel = AtomicBool::new(false);
        let profiles = read_camera_profiles(path, &cancel).unwrap();
        let image = x3f_core::prepare_scene_linear(
            path,
            &x3f_core::SceneLinearOptions {
                denoise_intensity: 0,
                highlight_recovery: true,
                ..Default::default()
            },
            &cancel,
            |_| (),
        )
        .unwrap();
        let prepared = crate::PreparedImage::new(image, &cancel)
            .unwrap()
            .with_camera_profiles(profiles.clone());
        let renderer = crate::Renderer::new().unwrap();
        let options = crate::RenderOptions {
            max_dimension: Some(128),
            ..Default::default()
        };
        let recipe = EditRecipe {
            camera_profile: Some("Standard".into()),
            film: None,
            ..Default::default()
        };
        let standard = renderer
            .render_prepared(&prepared, &recipe, options, &cancel)
            .unwrap();
        for profile in &profiles.available {
            let recipe = EditRecipe {
                camera_profile: Some(profile.id.clone()),
                ..recipe.clone()
            };
            let result = renderer
                .render_prepared(&prepared, &recipe, options, &cancel)
                .unwrap();
            assert!(result.rgb16().is_some());
            if profile.id == "FCBlue" {
                assert_ne!(standard.rgb16(), result.rgb16());
            }
        }
    }
    #[test]
    #[ignore = "requires a GPU and X3F_CAMERA_PROFILE_INPUT with a Merrill or Quattro file"]
    fn real_native_color_mode_matches_core_reference() {
        let path = std::path::PathBuf::from(
            std::env::var_os("X3F_CAMERA_PROFILE_INPUT").expect("Set X3F_CAMERA_PROFILE_INPUT"),
        );
        let cancel = AtomicBool::new(false);
        let options = x3f_core::SceneLinearOptions {
            denoise_intensity: 0,
            ..Default::default()
        };
        let scene = x3f_core::prepare_scene_linear(&path, &options, &cancel, |_| {}).unwrap();
        let sensor = scene
            .color_mode_calibration
            .clone()
            .expect("a sensor with native Color Modes");
        let profiles = read_camera_profiles(&path, &cancel).unwrap();
        let recipe = EditRecipe {
            film: None,
            camera_profile: Some("Standard".into()),
            ..Default::default()
        };
        let params = profiles
            .native(&recipe)
            .unwrap()
            .expect("native Standard")
            .params;
        // Black to past saturation, with small chroma steps that ColorDQ cores.
        let patches: Vec<[f32; 3]> = (0..64)
            .map(|i| {
                let v = 0.002 * 1.12f32.powi(i);
                [
                    v,
                    v * (1. + 0.01 * (i % 5) as f32),
                    v * (1. - 0.008 * (i % 3) as f32),
                ]
            })
            .collect();
        let image = x3f_core::SceneLinearImage {
            data: patches.iter().flatten().copied().collect(),
            width: 64,
            height: 1,
            orientation: 1,
            white_balance: scene.white_balance,
            color_mode_calibration: Some(sensor.clone()),
        };
        let prepared = crate::PreparedImage::new(image, &cancel)
            .unwrap()
            .with_camera_profiles(profiles);
        let rendered = crate::Renderer::new()
            .unwrap()
            .render_prepared(&prepared, &recipe, crate::RenderOptions::default(), &cancel)
            .unwrap();
        // The same native path from x3f-sys pieces, in f64.
        let (matrix, offset) = sensor.render_matrix(&params);
        let to_counts = color::multiply(
            matrix,
            color::inverse(scene.white_balance.camera_to_rgb).unwrap(),
        );
        let lut = sys::color_mode_linear_tone_lut(&params, 0., sys::Control::none()).unwrap();
        let tone = |count: f64| {
            let at = count.abs().min(65534.);
            let (index, fraction) = (at as usize, at.fract());
            count.signum() * (lut[index] * (1. - fraction) + lut[index + 1] * fraction)
        };
        let output = q12(sensor.output_to_srgb);
        let mul = |m: &[f64; 9], v: [f64; 3]| -> [f64; 3] {
            std::array::from_fn(|r| (0..3).map(|c| m[r * 3 + c] * v[c]).sum())
        };
        for (i, patch) in patches.iter().enumerate() {
            let mut counts = mul(&to_counts, patch.map(f64::from));
            for c in 0..3 {
                counts[c] += offset[c];
            }
            if let Some(dq) = &sensor.color_dq {
                counts = dq.apply(counts).map(f64::from);
            }
            let linear = mul(&output, counts.map(tone));
            for (c, linear) in linear.into_iter().enumerate() {
                let x = linear.clamp(0., 1.);
                let encoded = if x <= 0.0031308 {
                    12.92 * x
                } else {
                    1.055 * x.powf(1. / 2.4) - 0.055
                };
                let value = rendered.data[i * 3 + c] as f64 / 65535.;
                assert!(
                    (value - encoded).abs() < 0.004,
                    "patch {i} channel {c}: {value} instead of {encoded} (counts {counts:?})"
                );
            }
        }
    }
    #[test]
    #[ignore = "requires a hardware GPU; run with --ignored"]
    fn native_color_modes_render_sigma_tone() {
        let renderer = crate::Renderer::new().unwrap();
        let cancel = AtomicBool::new(false);
        // Sigma's default Merrill tone and a sensor where one scene unit is
        // the 12-bit saturation count.
        let params = sys::ColorModeParameters {
            mode: sys::ColorMode::Standard,
            sensor: sys::ColorModeSensor::Merrill,
            as_shot_fallback: false,
            creative_matrix: None,
            contrast: 0.,
            tone: sys::ColorModeToneParameters {
                start: -1.17,
                end: 1.55,
                steepness: 3.,
                steepness2: 1.85,
                breakpoint: 0.1,
                scale: 1.,
            },
            inverse_gamma: 1. / 2.2,
            pixel_saturation: 4095.,
        };
        let sensor = sys::ColorModeCalibration {
            sensor_to_srgb: IDENTITY,
            wb_gain: [1.; 3],
            normalized_to_counts: [4095.; 3],
            count_offset: [0.; 3],
            iso_gain: 1.,
            output_to_srgb: IDENTITY,
            color_dq: None,
        };
        let profiles = || {
            profiles_from_calibration("Standard", |id| {
                Ok((id == "Standard").then(|| Calibration {
                    native: Some(Native::new(params)),
                    ..Default::default()
                }))
            })
            .unwrap()
        };
        let levels = [0.02f32, 0.1, 0.25, 0.6, 1., 2.];
        let image = |color_mode_calibration| x3f_core::SceneLinearImage {
            data: levels.iter().flat_map(|&v| [v; 3]).collect(),
            width: 6,
            height: 1,
            orientation: 1,
            white_balance: x3f_core::WhiteBalanceCalibration {
                camera_to_rgb: IDENTITY,
                xyz_to_camera: IDENTITY,
                as_shot_neutral: [1.; 3],
            },
            color_mode_calibration,
        };
        let render = |sensor, film| {
            let prepared = crate::PreparedImage::new(image(sensor), &cancel)
                .unwrap()
                .with_camera_profiles(profiles());
            let recipe = EditRecipe {
                film,
                camera_profile: Some("Standard".into()),
                ..Default::default()
            };
            renderer
                .render_prepared(&prepared, &recipe, crate::RenderOptions::default(), &cancel)
                .unwrap()
        };
        let native = render(Some(sensor.clone()), None);
        let lut = sys::color_mode_linear_tone_lut(&params, 0., sys::Control::none()).unwrap();
        for (i, &level) in levels.iter().enumerate() {
            let count = (level as f64 * 4095.).min(65534.);
            let (index, fraction) = (count as usize, count.fract());
            let linear = lut[index] * (1. - fraction) + lut[index + 1] * fraction;
            let encoded = if linear <= 0.0031308 {
                12.92 * linear
            } else {
                1.055 * linear.powf(1. / 2.4) - 0.055
            };
            let pixel = &native.data[i * 3..][..3];
            let value = pixel[0] as f64 / 65535.;
            assert!(
                (value - encoded).abs() < 0.003,
                "scene {level}: {value} instead of Sigma's {encoded}"
            );
            assert!(pixel[1].abs_diff(pixel[0]) <= 1 && pixel[2].abs_diff(pixel[0]) <= 1);
        }
        // Without the sensor calibration, and under film, the native mode is
        // off. (The calibration still meters film exposure.)
        assert_ne!(render(None, None).data, native.data);
        let film = EditRecipe {
            film: Some(crate::FilmSettings::default()),
            camera_profile: Some("Standard".into()),
            ..Default::default()
        };
        assert!(profiles().native(&film).unwrap().is_none());
        let gray = profiles().metered_gray(Some(&sensor), IDENTITY);
        let lut_at = |count: f64| {
            let (index, fraction) = (count as usize, count.fract());
            lut[index] * (1. - fraction) + lut[index + 1] * fraction
        };
        assert!(
            (lut_at(gray * 4095.) - 0.184).abs() < 1e-3,
            "metered gray {gray} renders {}",
            lut_at(gray * 4095.)
        );
    }
    #[test]
    #[ignore = "requires a hardware GPU; run with --ignored"]
    fn calibrated_profiles_change_pixels_and_preview_matches_export() {
        let renderer = crate::Renderer::new().unwrap();
        let cancel = AtomicBool::new(false);
        let profiles = profiles_from_calibration("FCBlue", |id| {
            let calibration = Calibration {
                matrix: [0.9, 0.1, 0., 0., 0.95, 0.05, 0.1, 0., 0.9],
                tone: tone_curve(0.15),
                hue_sat: [[8., 0.8, 0., 0.]; 21],
                native: None,
            };
            Ok(match id {
                "Standard" => Some(Calibration {
                    tone: tone_curve(0.05),
                    ..Default::default()
                }),
                "FCBlue" => Some(calibration),
                _ => None,
            })
        })
        .unwrap();
        let image = x3f_core::SceneLinearImage {
            data: [0.35, 0.12, 0.07, 0.08, 0.23, 0.32].repeat(4),
            width: 4,
            height: 2,
            orientation: 1,
            white_balance: x3f_core::WhiteBalanceCalibration {
                camera_to_rgb: IDENTITY,
                xyz_to_camera: IDENTITY,
                as_shot_neutral: [1.; 3],
            },
            color_mode_calibration: None,
        };
        let prepared = crate::PreparedImage::new(image, &cancel)
            .unwrap()
            .with_camera_profiles(profiles);
        let recipe = EditRecipe {
            film: None,
            camera_profile: Some("FCBlue".into()),
            ..Default::default()
        };
        let export = renderer
            .render_prepared(&prepared, &recipe, crate::RenderOptions::default(), &cancel)
            .unwrap();
        let preview = renderer
            .render_prepared(
                &prepared,
                &recipe,
                crate::RenderOptions {
                    rgba8: true,
                    ..Default::default()
                },
                &cancel,
            )
            .unwrap();
        let preview_rgb: Vec<u8> = preview
            .rgba8()
            .unwrap()
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| p[..3].iter().copied())
            .collect();
        assert_eq!(export.rgb8(), preview_rgb);
        let legacy = renderer
            .render_prepared(
                &prepared,
                &EditRecipe {
                    camera_profile: None,
                    ..recipe.clone()
                },
                crate::RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        assert_ne!(export.rgb16(), legacy.rgb16());
        let standard = renderer
            .render_prepared(
                &prepared,
                &EditRecipe {
                    camera_profile: Some("Standard".into()),
                    ..recipe.clone()
                },
                crate::RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        assert_ne!(
            standard.rgb16(),
            legacy.rgb16(),
            "The fallback must use the file's Standard calibration"
        );
        let pasted = EditRecipe {
            camera_profile: Some("ForestGreen".into()),
            ..recipe.clone()
        };
        let pasted: EditRecipe =
            serde_json::from_str(&serde_json::to_string(&pasted).unwrap()).unwrap();
        for rgba8 in [false, true] {
            let fallback = renderer
                .render_prepared(
                    &prepared,
                    &pasted,
                    crate::RenderOptions {
                        rgba8,
                        ..Default::default()
                    },
                    &cancel,
                )
                .unwrap();
            assert_eq!(fallback.rgb8(), standard.rgb8());
            if !rgba8 {
                assert_eq!(fallback.rgb16(), standard.rgb16());
            }
        }
        let mono = renderer
            .render_prepared(
                &prepared,
                &EditRecipe {
                    camera_profile: Some("Monochrome".into()),
                    ..recipe
                },
                crate::RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        assert!(mono
            .rgb16()
            .unwrap()
            .as_chunks::<3>()
            .0
            .iter()
            .all(|p| p[0] == p[1] && p[1] == p[2]));
    }
}
