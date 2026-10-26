//! Versioned, nondestructive editing recipe. Numbers are validated before GPU submission.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EditRecipe {
    pub version: u32,
    /// CAMF picture mode. None keeps the legacy color transform.
    pub camera_profile: Option<String>,
    pub exposure: f32,
    pub temperature: Option<f32>,
    pub tint: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub white_balance_gains: Option<[f32; 3]>,
    /// Full spectrum raw color. It replaces white balance and the camera color
    /// matrix. None keeps the calibrated visible path and is not written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_color: Option<RawColor>,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    /// SIGMA Photo Pro's X3 Fill Light (-2..2). Positive values add light to
    /// dark areas from their surroundings; highlights keep their exposure.
    pub fill_light: f32,
    pub saturation: f32,
    pub vibrance: f32,
    pub curves: Curves,
    pub hsl: [HslBand; 8],
    /// Three-way color grading. The default is identity and is not written.
    #[serde(skip_serializing_if = "is_default")]
    pub wheels: ColorWheels,
    /// Strength passed to the RAW preparation stage (0..10), not applied twice.
    pub denoise: u8,
    pub denoise_options: x3f_core::DenoiseOptions,
    /// Bayer DNG preparation. None keeps the saved LibRaw rendering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dng_demosaic: Option<DngDemosaic>,
    pub sharpen: f32,
    /// Rectangle in the EXIF-oriented full image, before user rotation/straighten.
    pub crop: Option<Crop>,
    pub rotation: u32,
    pub straighten: f32,
    /// Perspective correction as a virtual camera turn, in degrees (-40..40).
    /// Applied to the oriented image before crop, rotation and straighten.
    pub pitch: f32,
    pub yaw: f32,
    pub monochrome: Option<MonochromeSettings>,
    /// Blue-to-orange toning for monochrome output (-100..100).
    #[serde(skip_serializing_if = "is_default")]
    pub warmth: f32,
    /// Source-color brightness in the eight HSL band positions (-100..100).
    #[serde(skip_serializing_if = "is_default")]
    pub tone_mixer: [f32; 8],
    pub film: Option<FilmSettings>,
    /// Grain and halation for a look without a film stock. Ignored while `film` is Some.
    pub effects: Option<EffectsSettings>,
    pub seed: u32,
    /// The frames of an X3I that the editor uses: by default the middle
    /// exposure, which needs no merge. X3F files ignore it. The default is not
    /// written, so other recipes stay as they were.
    #[serde(skip_serializing_if = "is_middle_exposure")]
    pub x3i_source: x3f_core::X3iSource,
}
fn is_middle_exposure(source: &x3f_core::X3iSource) -> bool {
    *source == x3f_core::X3iSource::MiddleExposure
}
fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}
impl Default for EditRecipe {
    fn default() -> Self {
        Self {
            version: 1,
            camera_profile: None,
            exposure: 0.,
            white_balance_gains: None,
            temperature: None,
            tint: 0.,
            raw_color: None,
            contrast: 0.,
            highlights: 0.,
            shadows: 0.,
            whites: 0.,
            blacks: 0.,
            fill_light: 0.,
            saturation: 0.,
            vibrance: 0.,
            curves: Curves::default(),
            hsl: [HslBand::default(); 8],
            wheels: ColorWheels::default(),
            denoise: 10,
            denoise_options: x3f_core::DenoiseOptions::default(),
            dng_demosaic: None,
            sharpen: 0.,
            crop: None,
            rotation: 0,
            straighten: 0.,
            pitch: 0.,
            yaw: 0.,
            monochrome: None,
            warmth: 0.,
            tone_mixer: [0.; 8],
            film: Some(FilmSettings::default()),
            effects: None,
            seed: 0,
            x3i_source: x3f_core::X3iSource::MiddleExposure,
        }
    }
}

impl EditRecipe {
    /// Reject sensor settings that cannot operate on a LibRaw DNG source.
    pub fn validate_dng(&self, monochrome_sensor: bool) -> Result<(), String> {
        self.validate()?;
        if self.camera_profile.is_some()
            || self.raw_color.is_some()
            || self.denoise != 0
            || self.denoise_options != Default::default()
            || self.fill_light != 0.
            || self.x3i_source != x3f_core::X3iSource::MiddleExposure
        {
            return Err("DNG inputs cannot use Foveon profiles or sensor controls".into());
        }
        if self.monochrome.is_some()
            && !self
                .film
                .as_ref()
                .is_some_and(|film| crate::stocks::monochrome_film(film.film))
        {
            return Err("DNG inputs cannot use Foveon sensor-layer filters".into());
        }
        if (monochrome_sensor || self.dng_demosaic == Some(DngDemosaic::Mono))
            && (self.temperature.is_some() || self.tint != 0. || self.white_balance_gains.is_some())
        {
            return Err("White balance is unavailable for monochrome DNG inputs".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DngDemosaic {
    Amaze,
    Dcb,
    Ahd,
    Eahd,
    Hphd,
    Igv,
    Lmmse,
    Vng4,
    Mono,
    Fast,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MonochromeSettings {
    pub filter: MonochromeFilter,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MonochromeFilter {
    #[default]
    Neutral,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
}

/// Full spectrum raw color: gains on the camera layers, then a 3x3 mix to RGB.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawColor {
    /// Gains on the bottom, middle, and top sensor layers. The renderer divides
    /// them by the middle gain, so they do not change exposure.
    pub gains: [f32; 3],
    /// Row-major mix. Rows are output red, green, and blue. Columns are the
    /// bottom, middle, and top layers.
    pub matrix: [f32; 9],
}
impl RawColor {
    /// Gives the shared row when all output rows are equal, so the mix is monochrome.
    pub fn monochrome_row(&self) -> Option<[f32; 3]> {
        let row = [self.matrix[0], self.matrix[1], self.matrix[2]];
        self.matrix
            .iter()
            .enumerate()
            .all(|(i, value)| (value - row[i % 3]).abs() < 1e-6)
            .then_some(row)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}
fn identity() -> Vec<Point> {
    vec![Point { x: 0., y: 0. }, Point { x: 1., y: 1. }]
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Curves {
    pub master: Vec<Point>,
    pub red: Vec<Point>,
    pub green: Vec<Point>,
    pub blue: Vec<Point>,
}
impl Default for Curves {
    fn default() -> Self {
        Self {
            master: identity(),
            red: identity(),
            green: identity(),
            blue: identity(),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HslBand {
    pub hue: f32,
    pub saturation: f32,
    pub luminance: f32,
}
/// Three-way color grading of the display-encoded image, after the HSL bands.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ColorWheels {
    pub shadows: Wheel,
    pub midtones: Wheel,
    pub highlights: Wheel,
    /// Overlap of the tonal zones (0..100). Zero is a hard split.
    pub blending: f32,
    /// Moves the zone borders (-100..100). Negative values widen the shadows.
    pub balance: f32,
}
impl Default for ColorWheels {
    fn default() -> Self {
        Self {
            shadows: Wheel::default(),
            midtones: Wheel::default(),
            highlights: Wheel::default(),
            blending: 50.,
            balance: 0.,
        }
    }
}
/// One color wheel. `x`, `y` is the dot in the unit disc, with `y` up. Its
/// angle is the hue (red at 0°, green at 120°, blue at 240°) and its length the
/// strength. `luminance` (-100..100) is the zone's brightness. `hue` (radians)
/// is the hue that the editor keeps at zero strength, where `x`, `y` hold none.
/// The renderer does not read it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Wheel {
    pub x: f32,
    pub y: f32,
    pub luminance: f32,
    #[serde(skip_serializing_if = "is_default")]
    pub hue: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
impl Default for Crop {
    fn default() -> Self {
        Self {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
        }
    }
}

/// Grain and halation for a look without a film stock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EffectsSettings {
    pub grain: bool,
    pub grain_params: GrainParams,
    pub halation: bool,
    pub halation_params: HalationParams,
}
impl Default for EffectsSettings {
    fn default() -> Self {
        Self {
            grain: false,
            grain_params: GrainParams {
                rms_granularity: [6., 8., 10.],
                ..GrainParams::default()
            },
            halation: false,
            halation_params: HalationParams::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct FilmSettings {
    pub film: u32,
    pub paper: u32,
    pub negative: bool,
    pub ev_film: f32,
    pub ev_paper: Option<f32>,
    pub couplers: f32,
    pub couplers_radius: f32,
    pub grain: bool,
    /// Missing native parameters keep saved recipes on the legacy path.
    #[serde(default)]
    pub grain_params: Option<GrainParams>,
    pub grain_size: f32,
    pub grain_amount: f32,
    /// Clumps the grain unevenly (0..1). Zero is spektrafilm's even grain.
    pub grain_roughness: f32,
    pub grain_saturation: f32,
    pub halation: bool,
    #[serde(default)]
    pub halation_params: Option<HalationParams>,
    pub halation_strength: f32,
    pub halation_radius: f32,
    pub halation_midtones: f32,
    /// Per-channel (RGB) scatter decay length in um: `scatter_tail_um`.
    /// The scatter core keeps its ratio to it.
    pub scatter_size_rgb: [f32; 3],
    /// Per-channel fraction of the scattered light in the wide tail; the rest
    /// stays in the narrow core. spektrafilm's `scatter_tail_weight`.
    pub scatter_strength_rgb: [f32; 3],
    /// Per-channel first-bounce halation sigma in um: spektrafilm's
    /// `halation_first_sigma_um`. `halation_radius` scales it.
    pub halation_size_rgb: [f32; 3],
    /// Per-channel fraction of light that halates: spektrafilm's
    /// `halation_strength`. `halation_strength` scales it.
    pub halation_strength_rgb: [f32; 3],
    pub gamma_film: f32,
    pub gamma_paper: f32,
    pub tune_m: f32,
    pub tune_y: f32,
}
impl Default for FilmSettings {
    fn default() -> Self {
        Self {
            film: 2,
            paper: 3,
            negative: false,
            ev_film: 0.,
            ev_paper: None,
            couplers: 0.25,
            couplers_radius: 0.0015,
            grain: true,
            grain_params: Some(GrainParams::default()),
            grain_size: 1.,
            grain_amount: 1.,
            grain_roughness: 0.,
            grain_saturation: 1.,
            halation: false,
            halation_params: Some(HalationParams::default()),
            halation_strength: 0.35,
            halation_radius: 0.0015,
            halation_midtones: 0.,
            scatter_size_rgb: crate::film::SCATTER_TAIL_UM.map(|v| v as f32),
            scatter_strength_rgb: crate::film::SCATTER_TAIL_WEIGHT.map(|v| v as f32),
            halation_size_rgb: crate::film::HALATION_FIRST_SIGMA_UM.map(|v| v as f32),
            halation_strength_rgb: crate::film::HALATION_STRENGTH.map(|v| v as f32),
            gamma_film: 1.,
            gamma_paper: 1.,
            tune_m: 0.,
            tune_y: 0.,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct GrainParams {
    pub rms_granularity: [f32; 3],
    /// Main slider value. Rendering uses the absolute channel values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rms_base: Option<f32>,
    pub blur: f32,
    pub mult_usm_amount: f32,
}
impl Default for GrainParams {
    fn default() -> Self {
        Self {
            rms_granularity: [4.5; 3],
            rms_base: None,
            blur: 0.7,
            mult_usm_amount: 1.5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct HalationParams {
    pub scatter_amount: f32,
    pub scatter_spatial_scale: f32,
    pub halation_amount: f32,
    pub halation_spatial_scale: f32,
}
impl Default for HalationParams {
    fn default() -> Self {
        Self {
            scatter_amount: 1.,
            scatter_spatial_scale: 1.,
            halation_amount: 1.,
            halation_spatial_scale: 1.,
        }
    }
}

impl GrainParams {
    pub fn validate(&self) -> Result<(), String> {
        for value in self.rms_granularity {
            range("RMS granularity", value, 0., 100.)?;
        }
        if let Some(value) = self.rms_base {
            range("RMS base", value, 0., 100.)?;
        }
        for (name, value, hi) in [
            ("grain blur", self.blur, 4.),
            ("grain USM amount", self.mult_usm_amount, 4.),
        ] {
            range(name, value, 0., hi)?;
        }
        Ok(())
    }
}
impl HalationParams {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, hi) in [
            ("scatter amount", self.scatter_amount, 1.),
            ("scatter spatial scale", self.scatter_spatial_scale, 4.),
            ("halation amount", self.halation_amount, 4.),
            ("halation spatial scale", self.halation_spatial_scale, 4.),
        ] {
            range(name, value, 0., hi)?;
        }
        Ok(())
    }
}
fn range(name: &str, value: f32, lo: f32, hi: f32) -> Result<(), String> {
    if !value.is_finite() || value < lo || value > hi {
        Err(format!("{name} must be between {lo} and {hi}"))
    } else {
        Ok(())
    }
}
impl Crop {
    pub fn validate(&self) -> Result<(), String> {
        for (n, v) in [
            ("crop.x", self.x),
            ("crop.y", self.y),
            ("crop.width", self.width),
            ("crop.height", self.height),
        ] {
            range(n, v, 0., 1.)?;
        }
        if self.width <= 0.
            || self.height <= 0.
            || self.x + self.width > 1.000001
            || self.y + self.height > 1.000001
        {
            return Err("Crop must have positive dimensions within the image".into());
        }
        Ok(())
    }
}
impl EditRecipe {
    /// The recipe without what does not change pixels: the hue that a wheel keeps at
    /// zero strength. Compare and key renders with it.
    pub fn pixels(&self) -> EditRecipe {
        let mut recipe = self.clone();
        let wheels = &mut recipe.wheels;
        for wheel in [
            &mut wheels.shadows,
            &mut wheels.midtones,
            &mut wheels.highlights,
        ] {
            wheel.hue = 0.;
        }
        recipe
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!("Unsupported edit recipe version {}", self.version));
        }
        if let Some(id) = &self.camera_profile {
            if !crate::camera::MODES.iter().any(|(mode, _)| mode == id) {
                return Err(format!("Unknown camera profile {id}"));
            }
        }
        range("exposure", self.exposure, -5., 5.)?;
        range("fill light", self.fill_light, -2., 2.)?;
        if let Some(t) = self.temperature {
            let [lo, hi] = crate::color::EXTENDED_TEMPERATURE;
            range("temperature", t, lo, hi)?;
        }
        let tint = crate::color::EXTENDED_TINT;
        range("tint", self.tint, -tint, tint)?;
        if let Some(gains) = self.white_balance_gains {
            let [lo, hi] = crate::color::RAW_GAIN;
            for gain in gains {
                range("white balance gain", gain, lo, hi)?;
            }
        }
        if let Some(raw) = &self.raw_color {
            let [lo, hi] = crate::color::RAW_GAIN;
            for gain in raw.gains {
                range("raw gain", gain, lo, hi)?;
            }
            let mix = crate::color::RAW_MIX;
            for value in raw.matrix {
                range("raw mix", value, -mix, mix)?;
            }
            if self.camera_profile.is_some() || self.monochrome.is_some() {
                return Err("Raw color cannot use a camera profile or monochrome".into());
            }
        }
        for (n, v) in [
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("saturation", self.saturation),
            ("vibrance", self.vibrance),
            ("warmth", self.warmth),
        ] {
            range(n, v, -100., 100.)?;
        }
        for value in self.tone_mixer {
            range("tone mixer", value, -100., 100.)?;
        }
        range("sharpen", self.sharpen, 0., 100.)?;
        range("straighten", self.straighten, -45., 45.)?;
        range("pitch", self.pitch, -40., 40.)?;
        range("yaw", self.yaw, -40., 40.)?;
        if self.rotation > 3 || self.denoise > 10 {
            return Err("Rotation must be 0..3 and denoise 0..10".into());
        }
        self.denoise_options.validate()?;
        if let Some(c) = self.crop {
            c.validate()?;
        }
        for curve in [
            &self.curves.master,
            &self.curves.red,
            &self.curves.green,
            &self.curves.blue,
        ] {
            if !(2..=32).contains(&curve.len())
                || curve.first().map(|p| p.x) != Some(0.)
                || curve.last().map(|p| p.x) != Some(1.)
            {
                return Err("Curves require 2..32 points with x endpoints 0 and 1".into());
            }
            for p in curve {
                range("curve.x", p.x, 0., 1.)?;
                range("curve.y", p.y, 0., 1.)?;
            }
            if curve.windows(2).any(|p| p[0].x >= p[1].x) {
                return Err("Curve points must have increasing x coordinates".into());
            }
        }
        for band in self.hsl {
            for value in [band.hue, band.saturation, band.luminance] {
                range("HSL adjustment", value, -100., 100.)?;
            }
        }
        let wheels = &self.wheels;
        for wheel in [wheels.shadows, wheels.midtones, wheels.highlights] {
            range("wheel x", wheel.x, -1., 1.)?;
            range("wheel y", wheel.y, -1., 1.)?;
            // The editor clamps the length to 1; allow for float rounding.
            if wheel.x.hypot(wheel.y) > 1.0001 {
                return Err("Wheel offsets must lie in the unit disc".into());
            }
            range("wheel luminance", wheel.luminance, -100., 100.)?;
            // atan2 gives -PI..PI; allow for float rounding.
            let half = std::f32::consts::PI + 1e-3;
            range("wheel hue", wheel.hue, -half, half)?;
        }
        range("wheel blending", wheels.blending, 0., 100.)?;
        range("wheel balance", wheels.balance, -100., 100.)?;
        if let Some(f) = &self.film {
            f.validate()?;
        }
        if let Some(e) = &self.effects {
            e.grain_params.validate()?;
            e.halation_params.validate()?;
        }
        Ok(())
    }
}
impl EffectsSettings {
    pub(crate) fn active(&self) -> bool {
        self.grain || self.halation
    }
    /// The reference stock settings that carry these effects. Its grain tables
    /// and halation baselines serve a look without a film stock.
    pub(crate) fn reference(&self) -> FilmSettings {
        FilmSettings {
            grain: self.grain,
            grain_params: Some(self.grain_params.clone()),
            halation: self.halation,
            halation_params: Some(self.halation_params.clone()),
            // No DIR couplers run here, so no tile margin is reserved for them.
            couplers: 0.,
            ..FilmSettings::default()
        }
    }
}
impl FilmSettings {
    pub(crate) fn grain_active(&self) -> bool {
        self.grain && (self.grain_params.is_some() || self.grain_amount > 0.)
    }
    pub fn validate(&self) -> Result<(), String> {
        if let Some(params) = &self.grain_params {
            params.validate()?;
        }
        if let Some(params) = &self.halation_params {
            params.validate()?;
        }
        let (films, profiles) = (
            crate::film::profile::FILM_COUNT,
            crate::film::profile::PROFILE_JSON.len(),
        );
        if self.film as usize >= films || self.paper as usize >= profiles - films {
            return Err("Unknown film or paper stock".into());
        }
        for (n, v, lo, hi) in [
            ("film exposure", self.ev_film, -3., 3.),
            ("couplers", self.couplers, 0., 1.),
            ("coupler radius", self.couplers_radius, 0., 0.05),
            ("grain size", self.grain_size, 0.25, 4.),
            ("grain amount", self.grain_amount, 0., 8.),
            ("grain roughness", self.grain_roughness, 0., 1.),
            ("grain saturation", self.grain_saturation, 0., 1.),
            ("halation strength", self.halation_strength, 0., 2.),
            ("halation radius", self.halation_radius, 0.0005, 0.006),
            ("halation midtones", self.halation_midtones, 0., 1.),
            ("film gamma", self.gamma_film, 0.5, 2.),
            ("paper gamma", self.gamma_paper, 0.5, 2.),
            ("print tint", self.tune_m, -1., 1.),
            ("print warmth", self.tune_y, -1., 1.),
        ] {
            range(n, v, lo, hi)?;
        }
        if let Some(e) = self.ev_paper {
            range("paper exposure", e, -6., 6.)?;
        }
        for (n, values, hi) in [
            // The editor's 50 um red keeps green, at its default ratio, below.
            ("scatter size", self.scatter_size_rgb, 60.),
            ("scatter strength", self.scatter_strength_rgb, 1.),
            // Wider halation pushes the tile margin past the GPU buffer limit
            // at the largest Halation amount on a 3:2 crop straightened 45°.
            ("halation size", self.halation_size_rgb, 150.),
            ("halation channel strength", self.halation_strength_rgb, 0.3),
        ] {
            for v in values {
                range(n, v, 0., hi)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ColorWheels, EditRecipe, EffectsSettings, GrainParams, Wheel};

    #[test]
    fn default_wheels_are_not_written_and_others_round_trip() {
        let saved = serde_json::to_value(EditRecipe::default()).unwrap();
        assert!(saved.get("wheels").is_none());
        let recipe: EditRecipe = serde_json::from_str(r#"{"wheels":{}}"#).unwrap();
        assert_eq!(recipe.wheels, ColorWheels::default());
        let recipe = EditRecipe {
            wheels: ColorWheels {
                midtones: Wheel {
                    x: 0.3,
                    y: -0.4,
                    luminance: 20.,
                    ..Default::default()
                },
                highlights: Wheel {
                    hue: 1.5,
                    ..Default::default()
                },
                balance: -30.,
                ..Default::default()
            },
            ..Default::default()
        };
        recipe.validate().unwrap();
        let saved = serde_json::to_value(&recipe).unwrap();
        assert_eq!(saved["wheels"]["blending"], 50.);
        // Only a kept hue is written.
        assert!(saved["wheels"]["midtones"].get("hue").is_none());
        assert_eq!(saved["wheels"]["highlights"]["hue"], 1.5);
        assert_eq!(serde_json::from_value::<EditRecipe>(saved).unwrap(), recipe);
        for wheel in [
            Wheel {
                x: 0.8,
                y: 0.8,
                ..Default::default()
            },
            Wheel {
                hue: 4.,
                ..Default::default()
            },
            Wheel {
                luminance: 101.,
                ..Default::default()
            },
            Wheel {
                x: f32::NAN,
                ..Default::default()
            },
        ] {
            let mut bad = recipe.clone();
            bad.wheels.shadows = wheel;
            assert!(bad.validate().is_err());
        }
        let mut bad = recipe;
        bad.wheels.blending = 101.;
        assert!(bad.validate().is_err());
    }

    #[test]
    fn effects_missing_and_null_are_none_and_an_object_round_trips() {
        for json in [r#"{}"#, r#"{"effects":null}"#] {
            let recipe: EditRecipe = serde_json::from_str(json).unwrap();
            assert_eq!(recipe.effects, None);
            // The key must be present: the editor's defaults write it as null.
            assert_eq!(
                serde_json::to_value(&recipe).unwrap().get("effects"),
                Some(&serde_json::Value::Null)
            );
        }
        let effects = EffectsSettings {
            grain: true,
            halation: true,
            ..Default::default()
        };
        assert_eq!(effects.grain_params.rms_granularity, [6., 8., 10.]);
        let recipe = EditRecipe {
            effects: Some(effects),
            ..Default::default()
        };
        let saved = serde_json::to_value(&recipe).unwrap();
        assert_eq!(saved["effects"]["grainParams"]["rmsGranularity"][1], 8.);
        let restored: EditRecipe = serde_json::from_value(saved).unwrap();
        assert_eq!(restored, recipe);
    }

    #[test]
    fn effects_with_invalid_ranges_fail_validation() {
        let mut recipe = EditRecipe {
            effects: Some(EffectsSettings::default()),
            ..Default::default()
        };
        assert!(recipe.validate().is_ok());
        recipe.effects.as_mut().unwrap().grain_params.blur = -1.;
        assert!(recipe.validate().is_err());
        recipe.effects = Some(EffectsSettings::default());
        recipe
            .effects
            .as_mut()
            .unwrap()
            .halation_params
            .halation_amount = 1e6;
        assert!(recipe.validate().is_err());
    }

    #[test]
    fn grain_rms_base_round_trips_without_changing_channels() {
        let legacy = r#"{"rmsGranularity":[3,6,9],"blur":0.89,"multUsmAmount":1.5}"#;
        let mut grain: GrainParams = serde_json::from_str(legacy).unwrap();
        assert_eq!(grain.rms_base, None);
        assert!(serde_json::to_value(&grain)
            .unwrap()
            .get("rmsBase")
            .is_none());
        grain.rms_base = Some(5.);
        let saved = serde_json::to_value(&grain).unwrap();
        assert_eq!(saved["rmsBase"], 5.);
        let restored: GrainParams = serde_json::from_value(saved).unwrap();
        assert_eq!(restored, grain);
        assert_eq!(restored.rms_granularity, [3., 6., 9.]);
    }

    #[test]
    fn grain_rms_base_requires_a_finite_value_in_range() {
        for value in [0., 4.5, 100.] {
            assert!(GrainParams {
                rms_base: Some(value),
                ..Default::default()
            }
            .validate()
            .is_ok());
        }
        for value in [-0.1, 100.1, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(GrainParams {
                rms_base: Some(value),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
    }
}
