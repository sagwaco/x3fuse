//! Versioned, nondestructive editing recipe. Numbers are validated before GPU submission.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EditRecipe {
    pub version: u32,
    pub exposure: f32,
    pub temperature: Option<f32>,
    pub tint: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub saturation: f32,
    pub vibrance: f32,
    pub curves: Curves,
    pub hsl: [HslBand; 8],
    /// Strength passed to the RAW preparation stage (0..10), not applied twice.
    pub denoise: u8,
    pub sharpen: f32,
    /// Rectangle in the EXIF-oriented full image, before user rotation/straighten.
    pub crop: Option<Crop>,
    pub rotation: u32,
    pub straighten: f32,
    pub monochrome: Option<MonochromeSettings>,
    pub film: Option<FilmSettings>,
    pub seed: u32,
}
impl Default for EditRecipe {
    fn default() -> Self {
        Self {
            version: 1,
            exposure: 0.,
            temperature: None,
            tint: 0.,
            contrast: 0.,
            highlights: 0.,
            shadows: 0.,
            whites: 0.,
            blacks: 0.,
            saturation: 0.,
            vibrance: 0.,
            curves: Curves::default(),
            hsl: [HslBand::default(); 8],
            denoise: 10,
            sharpen: 0.,
            crop: None,
            rotation: 0,
            straighten: 0.,
            monochrome: None,
            film: Some(FilmSettings::default()),
            seed: 0,
        }
    }
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
    pub grain_size: f32,
    pub grain_amount: f32,
    pub grain_saturation: f32,
    pub halation: bool,
    pub halation_strength: f32,
    pub halation_radius: f32,
    pub halation_midtones: f32,
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
            grain_size: 1.,
            grain_amount: 1.,
            grain_saturation: 1.,
            halation: false,
            halation_strength: 0.35,
            halation_radius: 0.0015,
            halation_midtones: 0.,
            gamma_film: 1.,
            gamma_paper: 1.,
            tune_m: 0.,
            tune_y: 0.,
        }
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
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!("Unsupported edit recipe version {}", self.version));
        }
        range("exposure", self.exposure, -5., 5.)?;
        if let Some(t) = self.temperature {
            range("temperature", t, 2000., 12000.)?;
        }
        for (n, v) in [
            ("tint", self.tint),
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("saturation", self.saturation),
            ("vibrance", self.vibrance),
        ] {
            range(n, v, -100., 100.)?;
        }
        range("sharpen", self.sharpen, 0., 100.)?;
        range("straighten", self.straighten, -45., 45.)?;
        if self.rotation > 3 || self.denoise > 10 {
            return Err("Rotation must be 0..3 and denoise 0..10".into());
        }
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
        if let Some(f) = &self.film {
            f.validate()?;
        }
        Ok(())
    }
}
impl FilmSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.film >= 20 || self.paper >= 8 {
            return Err("Unknown film or paper stock".into());
        }
        for (n, v, lo, hi) in [
            ("film exposure", self.ev_film, -3., 3.),
            ("couplers", self.couplers, 0., 1.),
            ("coupler radius", self.couplers_radius, 0., 0.05),
            ("grain size", self.grain_size, 0.25, 4.),
            ("grain amount", self.grain_amount, 0., 2.),
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
        Ok(())
    }
}
