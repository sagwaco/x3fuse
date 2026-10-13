//! Picture modes from the file's CAMF calibration. No invented color presets.
use crate::{color, EditRecipe, MonochromeSettings, RenderError};
use serde::Serialize;
use std::{ffi::CString, path::Path, ptr::NonNull, sync::atomic::AtomicBool};
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
pub(crate) const LOOK_ROWS: usize = 256 + 21;

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
}
impl Default for Calibration {
    fn default() -> Self {
        Self {
            matrix: IDENTITY,
            tone: std::array::from_fn(|i| i as f32 / 255.),
            hue_sat: [[0., 1., 0., 0.]; 21],
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct CameraProfiles {
    pub available: Vec<CameraProfile>,
    pub as_shot: String,
    calibrations: Vec<(String, Calibration)>,
}
impl CameraProfiles {
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
    let metadata = Metadata::open(path, cancel)?;
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

pub(crate) fn look_table(calibration: Option<&Calibration>) -> Vec<[f32; 4]> {
    let identity = Calibration::default();
    let calibration = calibration.unwrap_or(&identity);
    calibration
        .tone
        .iter()
        .map(|&value| [value, 0., 0., 0.])
        .chain(calibration.hue_sat)
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
        assert_eq!(look_table(None).len(), LOOK_ROWS);
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
    fn profile_reader_cancels_before_opening_a_file() {
        assert!(matches!(
            read_camera_profiles(Path::new("missing.X3F"), &AtomicBool::new(true)),
            Err(RenderError::Cancelled)
        ));
        assert!(matches!(
            read_camera_profiles(
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
                &AtomicBool::new(false),
            ),
            Err(RenderError::Invalid(_))
        ));
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
    #[ignore = "requires a hardware GPU; run with --ignored"]
    fn calibrated_profiles_change_pixels_and_preview_matches_export() {
        let renderer = crate::Renderer::new().unwrap();
        let cancel = AtomicBool::new(false);
        let profiles = profiles_from_calibration("FCBlue", |id| {
            let calibration = Calibration {
                matrix: [0.9, 0.1, 0., 0., 0.95, 0.05, 0.1, 0., 0.9],
                tone: tone_curve(0.15),
                hue_sat: [[8., 0.8, 0., 0.]; 21],
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
