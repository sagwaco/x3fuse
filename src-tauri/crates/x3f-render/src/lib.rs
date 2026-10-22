//! GPU-only scene-linear RAW editing. The physical film implementation is GPL-3.0-only.
mod camera;
mod color;
mod fill;
mod film;
mod geometry;
mod recipe;
mod stocks;
pub use camera::{read_camera_profiles, CameraProfile, CameraProfiles};
pub use color::{
    as_shot_channel_gains, as_shot_white_balance, pick_channel_gains, pick_white_balance,
    recipe_white_balance, WhiteBalance,
};
pub use recipe::{
    ColorWheels, Crop, Curves, EditRecipe, EffectsSettings, FilmSettings, GrainParams,
    HalationParams, HslBand, MonochromeFilter, MonochromeSettings, Point, RawColor, Wheel,
};
pub use stocks::STOCKS_JSON;

/// Identifies the rendering output, not the crate API. **Bump it whenever a
/// change alters rendered pixels** - a shader edit, a model or asset change, a
/// different default. Callers that persist rendered images must mix it into
/// their cache keys, or previews produced by an older build keep being served
/// next to freshly rendered exports. `2` is the spektrafilm model; `1` was the
/// implementation it replaced.
/// Version 3 adds CAMF camera picture modes. Version 5 blurs scatter and
/// halation with a sigma per channel. Version 6 ports the experimental models.
/// Version 7 applies native camera looks before film exposure.
/// Version 8 adds native grain and halation controls with stock baselines.
/// Version 9 uses smooth tone curves. Version 10 adds color wheels.
/// Version 11 reduces the default grain blur.
/// Version 12 adds monochrome warmth and source-color tone mixing.
pub const RENDER_VERSION: u32 = 12;

use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard, OnceLock,
    },
};
use wgpu::util::DeviceExt;
use x3f_core::SceneLinearImage;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("{0}")]
    Invalid(String),
    #[error("GPU editing is unavailable: {0}")]
    Gpu(String),
    #[error("Rendering cancelled")]
    Cancelled,
    #[error(transparent)]
    Image(#[from] image::ImageError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests;
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorProfile {
    #[default]
    Srgb,
    AdobeRgb,
    ProPhotoRgb,
}
impl ColorProfile {
    fn index(self) -> f32 {
        match self {
            Self::Srgb => 0.,
            Self::AdobeRgb => 1.,
            Self::ProPhotoRgb => 2.,
        }
    }
    fn icc(self) -> Vec<u8> {
        x3f_core::color_icc_profile(match self {
            Self::Srgb => x3f_core::ColorEncoding::Srgb,
            Self::AdobeRgb => x3f_core::ColorEncoding::AdobeRgb,
            Self::ProPhotoRgb => x3f_core::ColorEncoding::ProPhotoRgb,
        })
        .expect("RGB profiles are built into x3f-core")
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderOptions {
    pub max_dimension: Option<u32>,
    pub region: Option<Crop>,
    pub color_profile: ColorProfile,
    /// Read back 8-bit RGBA packed on the GPU (previews) instead of 16-bit RGB (export).
    pub rgba8: bool,
}
/// Rendered pixels, rows top-down without padding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pixels {
    /// 16-bit RGB for export.
    Rgb16(Vec<u16>),
    /// An 8-bit preview frame packed on the GPU: a `FRAME_HEADER`-byte header
    /// (`X3F8`, width, height and 0 as little-endian u32), then RGBA rows with
    /// alpha 255. The header lets a caller send the frame without a copy.
    Rgba8(Vec<u8>),
}
/// Size of the header in front of the pixels of `Pixels::Rgba8`.
pub const FRAME_HEADER: usize = 16;
/// Builds an RGBA8 frame from packed pixels. Rejects a pixel that `pack`
/// flagged as non-finite with alpha 0.
fn checked_frame(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, RenderError> {
    if rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 255) {
        return Err(RenderError::Gpu("GPU produced non-finite pixels".into()));
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER + rgba.len());
    frame.extend_from_slice(b"X3F8");
    for value in [width, height, 0] {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    frame.extend_from_slice(rgba);
    Ok(frame)
}
pub struct RenderedImage {
    pub width: u32,
    pub height: u32,
    pub data: Pixels,
    pub color_profile: ColorProfile,
    /// Native edited output dimensions, independent of proxy/region resolution.
    pub full_width: u32,
    pub full_height: u32,
    /// Actual pixel-aligned normalized region within the edited output.
    pub region: Option<Crop>,
}
impl RenderedImage {
    /// The 16-bit samples, or `None` for an 8-bit preview.
    pub fn rgb16(&self) -> Option<&[u16]> {
        match &self.data {
            Pixels::Rgb16(data) => Some(data),
            Pixels::Rgba8(_) => None,
        }
    }
    /// The RGBA rows of an 8-bit preview, without the frame header.
    pub fn rgba8(&self) -> Option<&[u8]> {
        match &self.data {
            Pixels::Rgb16(_) => None,
            Pixels::Rgba8(frame) => frame.get(FRAME_HEADER..),
        }
    }
    pub fn rgb8(&self) -> Vec<u8> {
        match &self.data {
            Pixels::Rgb16(data) => data.iter().map(|&v| quantize8(v)).collect(),
            Pixels::Rgba8(_) => self
                .rgba8()
                .unwrap_or_default()
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|&[r, g, b, _]| [r, g, b])
                .collect(),
        }
    }
    pub fn png(&self) -> Result<Vec<u8>, RenderError> {
        self.png_preview(self.width.max(self.height))
    }
    /// Reuse a completed editor frame for a small preview without preparing RAW again.
    pub fn png_preview(&self, max_edge: u32) -> Result<Vec<u8>, RenderError> {
        if max_edge == 0 {
            return Err(RenderError::Invalid(
                "Preview dimensions must be positive".into(),
            ));
        }
        let rgb = image::RgbImage::from_raw(self.width, self.height, self.rgb8())
            .ok_or_else(|| RenderError::Invalid("Invalid rendered image".into()))?;
        let rgb = if self.width.max(self.height) > max_edge {
            image::DynamicImage::ImageRgb8(rgb)
                .thumbnail(max_edge, max_edge)
                .into_rgb8()
        } else {
            rgb
        };
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .set_icc_profile(self.color_profile.icc())
            .map_err(image::ImageError::Unsupported)?;
        encoder.write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )?;
        Ok(bytes)
    }
    pub fn jpeg(&self, quality: u8) -> Result<Vec<u8>, RenderError> {
        if !(1..=100).contains(&quality) {
            return Err(RenderError::Invalid("JPEG quality must be 1..100".into()));
        }
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
        encoder
            .set_icc_profile(self.color_profile.icc())
            .map_err(image::ImageError::Unsupported)?;
        encoder.encode(
            &self.rgb8(),
            self.width,
            self.height,
            image::ExtendedColorType::Rgb8,
        )?;
        Ok(bytes)
    }
    pub fn write_tiff(
        &self,
        path: impl AsRef<Path>,
        compress: bool,
        cancel: &AtomicBool,
    ) -> Result<(), RenderError> {
        x3f_core::output::tiff::write_rgb16(
            self.rgb16().ok_or_else(|| {
                RenderError::Invalid("16-bit output needs a 16-bit render".into())
            })?,
            self.width,
            self.height,
            path,
            compress,
            Some(&self.color_profile.icc()),
            cancel,
        )?;
        Ok(())
    }
}
/// 16-bit to 8-bit, rounding to nearest. The `pack` shader entry does the same.
fn quantize8(v: u16) -> u8 {
    ((v as u32 + 128) / 257) as u8
}
fn quantize16(v: f32) -> u16 {
    (v.clamp(0., 1.) * 65535.).round() as u16
}
fn cancelled(cancel: &AtomicBool) -> Result<(), RenderError> {
    if cancel.load(Ordering::Relaxed) {
        Err(RenderError::Cancelled)
    } else {
        Ok(())
    }
}

/// Immutable decoded RAW input validated once for repeated interactive rendering.
/// Rebuild after RAW preparation settings (such as denoise) change.
pub struct PreparedImage {
    image: SceneLinearImage,
    camera_profiles: CameraProfiles,
    gpu: Mutex<Option<GpuSource>>,
    as_shot: OnceLock<(f32, f32)>,
}
impl PreparedImage {
    pub fn new(image: SceneLinearImage, cancel: &AtomicBool) -> Result<Self, RenderError> {
        validate_scene(&image, cancel)?;
        Ok(Self {
            image,
            camera_profiles: CameraProfiles::default(),
            gpu: Mutex::new(None),
            as_shot: OnceLock::new(),
        })
    }
    pub fn image(&self) -> &SceneLinearImage {
        &self.image
    }
    /// The slider values for the camera's own white balance, found once.
    pub fn as_shot_white_balance(&self) -> (f32, f32) {
        *self
            .as_shot
            .get_or_init(|| as_shot_white_balance(&self.image.white_balance))
    }
    /// Attaches the source file's calibration for camera-profile rendering.
    pub fn with_camera_profiles(mut self, camera_profiles: CameraProfiles) -> Self {
        self.camera_profiles = camera_profiles;
        self
    }
}

struct GpuSource {
    device: wgpu::Device,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
    /// The scene on the Fill Light grid, built on first use.
    grid: Option<fill::Grid>,
    /// The luminance weights of the bound Fill Light map.
    fill: Option<[u32; 4]>,
}

const PARAMETER_SLOTS: usize = 63;
type Parameters = [[f32; 4]; PARAMETER_SLOTS];
const PARAMETER_BYTES: u64 = std::mem::size_of::<Parameters>() as u64;
const MAX_DISPATCHES: u64 = 80;
/// Blurs below this radius are indistinguishable from a copy; skipping them
/// keeps sub-pixel spektrafilm stages off the pass list entirely.
const MIN_SIGMA: f32 = 0.3;
/// Working pixel buffers available to the pass list.
const BUFFERS: usize = 6;

/// One reusable working set, bounded by the largest preview/tile rendered.
struct Workspace {
    size: u64,
    buffers: Vec<wgpu::Buffer>,
    /// 16-bit renders read each tile back through this; RGBA8 renders never use it.
    readback: Option<wgpu::Buffer>,
    /// RGBA8 frame written by `pack` and its readback copy, grown on demand.
    frame: Option<(u64, wgpu::Buffer, wgpu::Buffer, wgpu::BindGroup)>,
    uniform: wgpu::Buffer,
    uniform_stride: u32,
    spectral: wgpu::Buffer,
    tc_lut: wgpu::Buffer,
    curves: wgpu::Buffer,
    bindings: HashMap<[usize; 3], wgpu::BindGroup>,
}
fn validate_scene(image: &SceneLinearImage, cancel: &AtomicBool) -> Result<(), RenderError> {
    cancelled(cancel)?;
    if image.width == 0
        || image.height == 0
        || image.data.len() != image.width as usize * image.height as usize * 3
    {
        return Err(RenderError::Invalid(
            "Invalid scene-linear input image".into(),
        ));
    }
    for chunk in image.data.chunks(16_384) {
        cancelled(cancel)?;
        // Bitwise reduction lets LLVM vectorize finite validation without changing
        // its result. Chunking keeps cancellation responsive on large RAW files.
        if !chunk
            .iter()
            .fold(true, |finite, value| finite & value.is_finite())
        {
            return Err(RenderError::Invalid(
                "Invalid scene-linear input image".into(),
            ));
        }
    }
    Ok(())
}

/// Builds the ordered pass list for one tile, handing out working buffers as
/// stages consume them. Every stage reads at most two buffers and writes a
/// third, so a stage can never alias its own destination.
struct Chain {
    passes: Vec<(&'static str, [usize; 3], Parameters)>,
    busy: [bool; BUFFERS],
    base: Parameters,
}
impl Chain {
    fn new(base: Parameters) -> Self {
        Self {
            passes: Vec::new(),
            busy: [false; BUFFERS],
            base,
        }
    }
    fn alloc(&mut self) -> usize {
        let at = self
            .busy
            .iter()
            .position(|busy| !busy)
            .expect("the film chain never holds more than BUFFERS live buffers");
        self.busy[at] = true;
        at
    }
    fn release(&mut self, at: usize) {
        self.busy[at] = false;
    }
    fn emit(&mut self, name: &'static str, src: usize, aux: usize, p: Parameters) -> usize {
        let dst = self.alloc();
        self.passes.push((name, [src, aux, dst], p));
        dst
    }
    /// Sample the RAW and apply the global adjustments; returns the buffer
    /// holding scene-linear RGB.
    fn start(&mut self) -> usize {
        let sampled = self.alloc();
        let scratch = self.alloc();
        self.passes
            .push(("sample", [scratch, scratch, sampled], self.base));
        self.release(scratch);
        let adjusted = self.emit("adjust", sampled, sampled, self.base);
        self.release(sampled);
        adjusted
    }
    fn one(&mut self, name: &'static str, src: usize) -> usize {
        self.emit(name, src, src, self.base)
    }
    fn two(&mut self, name: &'static str, src: usize, aux: usize) -> usize {
        self.emit(name, src, aux, self.base)
    }
    /// Separable Gaussian with a sigma per channel. Returns `src` unchanged
    /// when the widest radius would round away, so sub-pixel spektrafilm
    /// stages cost no dispatches. The blur reads only slots 0, 21 and 22.
    fn blur(&mut self, src: usize, sigma: [f32; 3]) -> usize {
        let widest = film::widest(sigma);
        if widest < MIN_SIGMA || sigma.iter().any(|s| s.is_nan()) {
            return src;
        }
        let mut q = self.base;
        q[21] = [sigma[0], sigma[1], sigma[2], (3. * widest).ceil()];
        q[22] = [0.; 4];
        let mid = self.emit("blur", src, src, q);
        q[22][0] = 1.;
        let dst = self.emit("blur", mid, mid, q);
        self.release(mid);
        dst
    }
    fn scaled(&mut self, src: usize, aux: usize, a: f32, b: f32) -> usize {
        let mut q = self.base;
        q[21] = [a, b, 0., 0.];
        self.emit("combine", src, aux, q)
    }
    fn grain(&mut self, original: usize, spatial: &film::grain::Spatial) -> usize {
        let mut accumulated = None;
        for (layer, &sigma) in spatial.dye_clouds.iter().enumerate() {
            let mut params = self.base;
            params[52][3] = layer as f32;
            let particles = self.emit("grain_layer", original, original, params);
            let clouds = self.blur(particles, sigma);
            if clouds != particles {
                self.release(particles);
            }
            accumulated = Some(match accumulated {
                None => clouds,
                Some(previous) => {
                    let sum = self.scaled(previous, clouds, 1., 1.);
                    self.release(previous);
                    self.release(clouds);
                    sum
                }
            });
        }
        let mut current = accumulated.expect("grain has at least one emulsion sublayer");
        if spatial.micro_sigma > 0.05 {
            let noise = self.one("grain_micro_field", original);
            let clumps = if spatial.micro_blur > 0.4 {
                self.blur(noise, [spatial.micro_blur; 3])
            } else {
                noise
            };
            if clumps != noise {
                self.release(noise);
            }
            let textured = self.two("grain_multiply", current, clumps);
            self.release(current);
            self.release(clumps);
            current = textured;
        }
        let blurred = self.blur(current, [spatial.blur; 3]);
        if blurred != current {
            self.release(current);
        }
        current = blurred;
        let reference = self.blur(
            current,
            [if spatial.usm_amount > 0. {
                spatial.usm_sigma
            } else {
                0.
            }; 3],
        );
        if reference != current {
            let sharp = self.two("grain_usm", current, reference);
            self.release(reference);
            let sharp_blur = self.blur(sharp, [spatial.usm_sigma; 3]);
            let ratio = self.two("grain_ratio", current, sharp_blur);
            self.release(current);
            self.release(sharp_blur);
            let weights = self.blur(ratio, [spatial.usm_sigma; 3]);
            self.release(ratio);
            current = self.two("grain_multiply", sharp, weights);
            self.release(sharp);
            self.release(weights);
        }
        let result = self.two("grain_finish", current, original);
        self.release(current);
        self.release(original);
        result
    }
    /// Grain on a scene-linear image: through the reference stock's density
    /// domain, and back as a gain, so values above one keep their range.
    fn linear_grain(&mut self, linear: usize, spatial: &film::grain::Spatial) -> usize {
        let density = self.one("grain_to_density", linear);
        let grained = self.grain(density, spatial);
        let result = self.two("grain_from_density", grained, linear);
        self.release(grained);
        self.release(linear);
        result
    }
    /// Mix independent Gaussian blurs of the source to form an exponential tail.
    fn exponential(&mut self, src: usize, decay: [f32; 3]) -> usize {
        if film::widest(decay) * film::couplers::EXPONENTIAL_MAX_SIGMA < MIN_SIGMA {
            return src;
        }
        let mut accumulated = None;
        for (weight, ratio) in film::couplers::EXPONENTIAL_GAUSSIANS {
            let component = self.blur(src, decay.map(|value| value * ratio));
            accumulated = Some(match accumulated {
                None => self.scaled(component, component, weight, 0.),
                Some(previous) => {
                    let sum = self.scaled(previous, component, 1., weight);
                    self.release(previous);
                    sum
                }
            });
            if component != src {
                self.release(component);
            }
        }
        accumulated.expect("the exponential fit has three components")
    }
    /// Scatter mix plus the multi-bounce halation add, on linear film raw.
    fn halation(&mut self, raw: usize, spatial: &film::Spatial) -> usize {
        let mut current = raw;
        if film::widest(spatial.scatter_tail) * film::couplers::EXPONENTIAL_MAX_SIGMA >= MIN_SIGMA
            || film::widest(spatial.scatter_core) >= MIN_SIGMA
        {
            let core = self.blur(current, spatial.scatter_core);
            let tail = self.exponential(current, spatial.scatter_tail);
            let mut scattered = self.two("scatter_mix", core, tail);
            if core != current {
                self.release(core);
            }
            if tail != current {
                self.release(tail);
            }
            if spatial.scatter_amount != 1. {
                let mixed = self.scaled(
                    current,
                    scattered,
                    1. - spatial.scatter_amount,
                    spatial.scatter_amount,
                );
                self.release(scattered);
                scattered = mixed;
            }
            self.release(current);
            current = scattered;
        }
        if film::widest(spatial.halation[0]) < MIN_SIGMA {
            return current;
        }
        let mut accumulated: Option<usize> = None;
        for (k, &weight) in film::bounce_weights().iter().enumerate() {
            let bounce = self.blur(current, spatial.halation[k]);
            accumulated = Some(match accumulated {
                None => self.scaled(bounce, bounce, weight, 0.),
                Some(previous) => {
                    let sum = self.scaled(previous, bounce, 1., weight);
                    self.release(previous);
                    sum
                }
            });
            // A bounce whose blur was skipped aliases the source buffer, which
            // the halation add still needs.
            if bounce != current {
                self.release(bounce);
            }
        }
        let accumulated = accumulated.expect("at least one halation bounce");
        let out = self.two("halation_finish", current, accumulated);
        self.release(accumulated);
        self.release(current);
        out
    }
}

/// What the camera contributes to one render.
#[derive(Clone, Copy)]
struct Look<'a> {
    /// The selected camera profile.
    calibration: Option<&'a camera::Calibration>,
    /// Its native Sigma Color Mode, with the scene's sensor calibration.
    native: Option<(&'a camera::Native, &'a x3f_sys::ColorModeCalibration)>,
    /// The scene value the camera renders as 18% gray. Film exposes it as
    /// its mid-gray, in place of spektrafilm's auto exposure.
    metered_gray: f64,
    /// spektrafilm's scanner white and black correction on film looks.
    scanner: bool,
}
impl Look<'_> {
    fn plain() -> Self {
        Self {
            calibration: None,
            native: None,
            metered_gray: camera::fallback_metered_gray(),
            scanner: true,
        }
    }
    /// spektrafilm's own defaults, for parity checks against its reference.
    #[cfg(test)]
    fn spektrafilm() -> Self {
        Self {
            metered_gray: 0.184,
            scanner: false,
            ..Self::plain()
        }
    }
}

/// One tile of a frame. `x`, `y`, `width` and `height` are frame pixels;
/// `origin` is the top left of the padded area in output pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Tile {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    origin: [i32; 2],
}
/// One compute dispatch: a `render.wgsl` entry point, its (source, auxiliary,
/// destination) working buffers and its parameter vectors.
#[derive(Clone, Debug, PartialEq)]
struct Pass {
    entry: &'static str,
    buffers: [usize; 3],
    params: Parameters,
}
/// Film spectral tables (binding 4) and the spectral upsampling LUT (binding 5).
#[derive(Debug, PartialEq)]
struct FilmTables {
    spectral: Vec<f32>,
    tc_lut: Vec<f32>,
}
/// All GPU work of one frame. The native renderer runs it.
#[derive(Debug)]
struct Plan {
    width: u32,
    height: u32,
    full_width: u32,
    full_height: u32,
    region: Option<Crop>,
    /// Halo on each side of every tile.
    margin: u32,
    tiles: Vec<Tile>,
    /// The pass list of every tile. Slot 0 of the parameters is zero; each tile
    /// sets it to its padded `[width, height, origin x, origin y]`.
    passes: Vec<Pass>,
    /// The working buffer that holds the `output` pass result.
    output: usize,
    /// Size of each working buffer, enough for the largest tile.
    buffer_bytes: u64,
    /// `None` without film. The same `Arc` is returned until the film changes.
    tables: Option<Arc<FilmTables>>,
    /// Edit curves followed by the camera tone curve and hue map (binding 6).
    curves: Vec<[f32; 4]>,
    /// Luminance weights of the Fill Light map; `None` without Fill Light.
    fill: Option<[f32; 4]>,
}
impl Plan {
    /// Padded `[width, height, origin x, origin y]` of a tile, as parameter slot 0.
    fn slot0(&self, tile: &Tile) -> [f32; 4] {
        [
            (tile.width + 2 * self.margin) as f32,
            (tile.height + 2 * self.margin) as f32,
            tile.origin[0] as f32,
            tile.origin[1] as f32,
        ]
    }
}

/// Splits `length` pixels into spans of `tile` pixels. The last span also
/// takes a remainder of at most `slack` pixels, so a 1025-pixel frame costs one
/// 1024-pixel tile and not two.
fn spans(length: u32, tile: u32, slack: u32) -> Vec<(u32, u32)> {
    let mut count = length.div_ceil(tile).max(1);
    if count > 1 && length - (count - 1) * tile <= slack {
        count -= 1;
    }
    (0..count)
        .map(|i| {
            let start = i * tile;
            (start, if i + 1 == count { length - start } else { tile })
        })
        .collect()
}

/// The (tile size, slack) layouts to try, best first. A whole preview needs
/// no halo overdraw. Larger tiles amortize the per-tile overhead and the halo
/// overdraw, which the 81-wavelength spectral loops make expensive at native
/// resolution. The slack lets the last tile grow by 1/8 instead of adding a
/// row or column of thin tiles.
fn tiling_candidates(width: u32, height: u32, max_dimension: Option<u32>) -> Vec<(u32, u32)> {
    let mut candidates = vec![(1024, 128), (1024, 0), (512, 0)];
    if max_dimension.is_some_and(|edge| edge <= 2048) {
        candidates.insert(0, (width.max(height), 0));
    }
    candidates
}

/// Takes the first candidate whose largest padded tile fits in `limit` bytes.
/// A large diffusion radius can push large tiles past the limit; smaller
/// tiles then still render. Returns the column spans, the row spans and the
/// working buffer size.
#[allow(clippy::type_complexity)]
fn choose_tiling(
    width: u32,
    height: u32,
    margin: u32,
    limit: u64,
    candidates: &[(u32, u32)],
) -> Option<(Vec<(u32, u32)>, Vec<(u32, u32)>, u64)> {
    candidates.iter().find_map(|&(tile, slack)| {
        let (columns, rows) = (spans(width, tile, slack), spans(height, tile, slack));
        let widest = columns.iter().map(|&(_, w)| w).max().unwrap_or(0) as u64;
        let tallest = rows.iter().map(|&(_, h)| h).max().unwrap_or(0) as u64;
        let bytes = (widest + 2 * margin as u64) * (tallest + 2 * margin as u64) * 16;
        (bytes <= limit).then_some((columns, rows, bytes))
    })
}

/// Builds the pass list of one tile. Slot 0 of `base` must be set per tile.
/// Returns the passes and the buffer that holds the output.
fn build_passes(
    base: Parameters,
    film: Option<(&FilmSettings, &film::Spatial, &film::grain::Spatial)>,
    effects_only: bool,
    sharpen: f32,
) -> (Vec<Pass>, usize) {
    let mut chain = Chain::new(base);
    let mut current = chain.start();
    if let (Some((settings, spatial, grain)), true) = (film, effects_only) {
        // Generic effects run on the scene-linear image, before `finish`. Every
        // pass keeps the source alpha, which carries the Fill Light gain.
        if settings.halation {
            current = chain.halation(current, spatial);
        }
        if settings.grain_active() {
            current = chain.linear_grain(current, grain);
        }
    } else if let Some((settings, spatial, grain)) = film {
        let raw = chain.one("expose", current);
        chain.release(current);
        current = if settings.halation {
            chain.halation(raw, spatial)
        } else {
            raw
        };
        let density = chain.one("develop", current);
        current = if settings.couplers > 0. {
            let inhibitor = chain.one("dir_matmul", density);
            chain.release(density);
            let diffused = if spatial.coupler > 0. {
                let core = chain.blur(inhibitor, [spatial.coupler; 3]);
                let tail = chain.exponential(inhibitor, [spatial.coupler_tail; 3]);
                if core == inhibitor && tail == inhibitor {
                    inhibitor
                } else {
                    let mix = chain.scaled(
                        core,
                        tail,
                        1. - film::couplers::TAIL_WEIGHT,
                        film::couplers::TAIL_WEIGHT,
                    );
                    if core != inhibitor {
                        chain.release(core);
                    }
                    if tail != inhibitor {
                        chain.release(tail);
                    }
                    mix
                }
            } else {
                inhibitor
            };
            if diffused != inhibitor {
                chain.release(inhibitor);
            }
            let corrected = chain.two("dir_develop", current, diffused);
            chain.release(diffused);
            chain.release(current);
            corrected
        } else {
            chain.release(current);
            density
        };
        if settings.grain_active() {
            current = chain.grain(current, grain);
        }
        if !settings.negative {
            let exposed = chain.one("print_spectral", current);
            chain.release(current);
            current = chain.one("print_develop", exposed);
            chain.release(exposed);
        }
        let scanned = chain.one("scan", current);
        chain.release(current);
        current = scanned;
    }
    let finished = chain.one("finish", current);
    chain.release(current);
    let sharp = if sharpen > 0. {
        chain.blur(finished, [sharpen; 3])
    } else {
        finished
    };
    let output = chain.two("output", finished, sharp);
    let passes = chain
        .passes
        .into_iter()
        .map(|(entry, buffers, params)| Pass {
            entry,
            buffers,
            params,
        })
        .collect();
    (passes, output)
}

type FilmCache = (film::FilmLut, film::FilmPair, Arc<FilmTables>);

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    source_layout: wgpu::BindGroupLayout,
    frame_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
    output_gamut: wgpu::Buffer,
    /// ponytail: one-entry film/paper cache; make it a small LRU only if
    /// switching stocks in the UI measurably stalls.
    film: Mutex<Option<FilmCache>>,
    pub adapter_name: String,
    gpu_error: Arc<Mutex<Option<String>>>,
    workspace: Mutex<Option<Workspace>>,
}
impl Renderer {
    pub fn new() -> Result<Self, RenderError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter=pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions{power_preference:wgpu::PowerPreference::HighPerformance,force_fallback_adapter:false,compatible_surface:None}))
            .map_err(|_|RenderError::Gpu("No compatible GPU adapter. Update your graphics driver or use original conversion.".into()))?;
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu {
            return Err(RenderError::Gpu(
                "A hardware GPU is required for editing".into(),
            ));
        }
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("X3Fuse editor"),
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|e| RenderError::Gpu(e.to_string()))?;
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Spectral RAW editor"),
            source: wgpu::ShaderSource::Wgsl(
                concat!(
                    include_str!("render.wgsl"),
                    "\n",
                    include_str!("gamut.wgsl"),
                    "\n",
                    include_str!("grain.wgsl")
                )
                .into(),
            ),
        });
        let entries: Vec<_> = (0..8)
            .map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: if binding == 3 {
                        wgpu::BufferBindingType::Uniform
                    } else {
                        wgpu::BufferBindingType::Storage {
                            read_only: binding != 2,
                        }
                    },
                    has_dynamic_offset: binding == 3,
                    min_binding_size: (binding == 3)
                        .then(|| std::num::NonZeroU64::new(PARAMETER_BYTES).unwrap()),
                },
                count: None,
            })
            .collect();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &entries,
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let source_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Prepared RAW texture and Fill Light map"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let sample_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("RAW geometry"),
            bind_group_layouts: &[&layout, &source_layout],
            push_constant_ranges: &[],
        });
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("RGBA8 frame"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let pack_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("RGBA8 packing"),
            bind_group_layouts: &[&layout, &frame_layout],
            push_constant_ranges: &[],
        });
        let pipelines = [
            "sample",
            "adjust",
            "expose",
            "scatter_mix",
            "combine",
            "halation_finish",
            "develop",
            "dir_matmul",
            "dir_develop",
            "grain_layer",
            "grain_micro_field",
            "grain_multiply",
            "grain_usm",
            "grain_ratio",
            "grain_finish",
            "grain_to_density",
            "grain_from_density",
            "print_spectral",
            "print_develop",
            "scan",
            "blur",
            "finish",
            "output",
            "pack",
        ]
        .into_iter()
        .map(|name| {
            (
                name,
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(match name {
                        "sample" => &sample_layout,
                        "pack" => &pack_layout,
                        _ => &pipeline_layout,
                    }),
                    module: &shader,
                    entry_point: Some(name),
                    compilation_options: Default::default(),
                    cache: None,
                }),
            )
        })
        .collect();
        if let Some(e) = pollster::block_on(device.pop_error_scope()) {
            return Err(RenderError::Gpu(e.to_string()));
        }
        let gpu_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let errors = gpu_error.clone();
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            if let Ok(mut error) = errors.lock() {
                *error = Some(format!("{e}"));
            }
        }));
        let lost = gpu_error.clone();
        device.set_device_lost_callback(move |reason, message| {
            if let Ok(mut error) = lost.lock() {
                *error = Some(format!("GPU device lost ({reason:?}): {message}"));
            }
        });
        let output_gamut = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Output gamut boundaries"),
            contents: bytemuck::cast_slice(&film::gamut::output_gamut_tables()),
            usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self {
            device,
            queue,
            layout,
            source_layout,
            frame_layout,
            pipelines,
            output_gamut,
            film: Mutex::new(None),
            adapter_name: info.name,
            gpu_error,
            workspace: Mutex::new(None),
        })
    }
    pub fn render(
        &self,
        image: &SceneLinearImage,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
    ) -> Result<RenderedImage, RenderError> {
        validate_scene(image, cancel)?;
        recipe.validate().map_err(RenderError::Invalid)?;
        let recipe = camera::effective_recipe(recipe);
        let profiles = CameraProfiles::default();
        let look = Look {
            calibration: profiles.selected(&recipe)?,
            ..Look::plain()
        };
        let mut source = self.upload(image, cancel)?;
        self.render_source(image, &mut source, &recipe, options, cancel, None, look)
    }
    pub fn render_prepared(
        &self,
        image: &PreparedImage,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
    ) -> Result<RenderedImage, RenderError> {
        cancelled(cancel)?;
        recipe.validate().map_err(RenderError::Invalid)?;
        let recipe = camera::effective_recipe(recipe);
        // Sigma's native Color Mode needs the sensor calibration measured
        // while preparing the scene.
        let sensor = image.image.color_mode_calibration.as_ref();
        let look = Look {
            calibration: image.camera_profiles.selected(&recipe)?,
            native: image.camera_profiles.native(&recipe)?.zip(sensor),
            metered_gray: image
                .camera_profiles
                .metered_gray(sensor, image.image.white_balance.camera_to_rgb),
            scanner: true,
        };
        let mut gpu = self.source(image, cancel)?;
        self.render_source(
            image.image(),
            gpu.as_mut().unwrap(),
            &recipe,
            options,
            cancel,
            None,
            look,
        )
    }
    /// Uploads the source to this renderer's GPU before its first render.
    pub fn upload_prepared(
        &self,
        image: &PreparedImage,
        cancel: &AtomicBool,
    ) -> Result<(), RenderError> {
        self.source(image, cancel).map(drop)
    }
    fn source<'a>(
        &self,
        image: &'a PreparedImage,
        cancel: &AtomicBool,
    ) -> Result<MutexGuard<'a, Option<GpuSource>>, RenderError> {
        let mut gpu = image
            .gpu
            .lock()
            .map_err(|_| RenderError::Gpu("Source unavailable".into()))?;
        if gpu
            .as_ref()
            .is_none_or(|source| source.device != self.device)
        {
            *gpu = Some(self.upload(image.image(), cancel)?);
        }
        Ok(gpu)
    }
    /// Renders with spektrafilm's own defaults, for parity checks.
    #[cfg(test)]
    fn render_tiled(
        &self,
        image: &SceneLinearImage,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
        tiling: (u32, u32),
    ) -> Result<RenderedImage, RenderError> {
        let mut source = self.upload(image, cancel)?;
        self.render_source(
            image,
            &mut source,
            recipe,
            options,
            cancel,
            Some(tiling),
            Look::plain(),
        )
    }
    fn upload(
        &self,
        image: &SceneLinearImage,
        cancel: &AtomicBool,
    ) -> Result<GpuSource, RenderError> {
        let limit = self.device.limits().max_texture_dimension_2d;
        if image.width > limit || image.height > limit {
            return Err(RenderError::Gpu(format!(
                "RAW dimensions exceed this GPU's {limit}px texture limit"
            )));
        }
        // Keep signed channels and HDR exactly; filtering is explicit in the shader
        // so this path does not require optional float32 texture filtering.
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Prepared scene-linear RAW"),
            size: wgpu::Extent3d {
                width: image.width,
                height: image.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // Chunk packing avoids another full-frame CPU copy and checks cancellation.
        for (chunk, rows) in image.data.chunks(image.width as usize * 3 * 64).enumerate() {
            if let Err(error) = cancelled(cancel) {
                // Flush queued uploads so cancelled photos cannot accumulate staging memory.
                self.queue.submit([]);
                return Err(error);
            }
            let rgba: Vec<[f32; 4]> = rows.as_chunks::<3>().0.iter().map(texel).collect();
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: chunk as u32 * 64,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                bytemuck::cast_slice(&rgba),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.width * 16),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: image.width,
                    height: rgba.len() as u32 / image.width,
                    depth_or_array_layers: 1,
                },
            );
        }
        self.queue.submit([]);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        // The sample pass reads the map only with Fill Light set.
        let bind = self.source_bind(&view, &[[0.; 2]]);
        Ok(GpuSource {
            device: self.device.clone(),
            view,
            bind,
            grid: None,
            fill: None,
        })
    }
    fn source_bind(&self, view: &wgpu::TextureView, map: &[[f32; 2]]) -> wgpu::BindGroup {
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Fill Light map"),
            size: std::mem::size_of_val(map) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue
            .write_buffer(&buffer, 0, bytemuck::cast_slice(map));
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Prepared RAW source"),
            layout: &self.source_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: buffer.as_entire_binding(),
                },
            ],
        })
    }
    /// Builds and binds the Fill Light map for `weights`, unless it is bound.
    fn bind_fill(&self, source: &mut GpuSource, image: &SceneLinearImage, weights: [f32; 4]) {
        let key = weights.map(f32::to_bits);
        if source.fill == Some(key) {
            return;
        }
        let grid = source.grid.get_or_insert_with(|| fill::Grid::new(image));
        let map = fill::map(grid, image.width, image.height, weights);
        source.bind = self.source_bind(&source.view, &map);
        source.fill = Some(key);
    }
    /// Plans one frame: geometry, film tables, tiles and the shared pass list.
    /// `tiling` forces a (tile size, slack) pair for tests.
    fn plan_source(
        &self,
        image: &SceneLinearImage,
        recipe: &EditRecipe,
        options: RenderOptions,
        tiling: Option<(u32, u32)>,
        look: Look<'_>,
    ) -> Result<Plan, RenderError> {
        let Look {
            calibration,
            native,
            ..
        } = look;
        recipe.validate().map_err(RenderError::Invalid)?;
        let geom = geometry::Geometry::new(image, recipe, options)?;
        let (full_width, full_height) = output_dimensions(image, recipe)?;
        let (width, height) = (geom.width, geom.height);
        // Preparing the pair is the expensive CPU step. The plan keeps its
        // tables through an Arc, so the lock is held only while planning.
        let mut film_cache = self
            .film
            .lock()
            .map_err(|_| RenderError::Gpu("Renderer unavailable".into()))?;
        // Without a film stock, grain and halation borrow the reference stock's tables.
        let reference = recipe
            .effects
            .as_ref()
            .filter(|e| recipe.film.is_none() && e.active())
            .map(EffectsSettings::reference);
        let film_settings = recipe.film.as_ref().or(reference.as_ref());
        if let Some(settings) = film_settings {
            let filter = recipe
                .film
                .is_some()
                .then(|| recipe.monochrome.map(|m| m.filter))
                .flatten();
            let stale = film_cache.as_ref().is_none_or(|(lut, pair, _)| {
                !lut.matches(settings, filter) || !pair.matches(settings, recipe.warmth)
            });
            if stale {
                // Rebuild the LUT only when the film or its taking filter
                // changed; paper, trim and exposure changes reuse it.
                let lut = match film_cache.take() {
                    Some((lut, _, _)) if lut.matches(settings, filter) => lut,
                    _ => film::FilmLut::build(settings.film, filter)?,
                };
                let pair = film::FilmPair::build(settings, &lut, recipe.warmth)?;
                let tables = Arc::new(FilmTables {
                    spectral: pair.spectral.clone(),
                    tc_lut: lut.uploadable.clone(),
                });
                *film_cache = Some((lut, pair, tables));
            }
        }
        let prepared = film_settings.and(film_cache.as_ref());
        // spektrafilm's spatial parameters are physical, so they are derived
        // from the full output frame; a tile or region must never change them.
        let spatial = film_settings
            .zip(prepared)
            .map(|(f, (_, pair, _))| film::Spatial::new(f, geom.long_edge(), pair.monochrome));
        let grain_spatial = film_settings
            .zip(prepared)
            .map(|(f, (_, pair, _))| pair.grain.spatial_for(geom.long_edge(), f));
        let stage_sigma =
            |pick: fn(&film::Spatial, &FilmSettings) -> f32| match (&spatial, film_settings) {
                (Some(s), Some(f)) => pick(s, f),
                _ => 0.,
            };
        let coupler_sigma = stage_sigma(|s, f| {
            if f.couplers > 0. {
                s.coupler
                    .max(s.coupler_tail * film::couplers::EXPONENTIAL_MAX_SIGMA)
            } else {
                0.
            }
        });
        // Scatter and the widest bounce are applied in series, so their halos add.
        let halation_sigma = stage_sigma(|s, f| {
            if f.halation {
                (film::widest(s.scatter_tail) * film::couplers::EXPONENTIAL_MAX_SIGMA)
                    .max(film::widest(s.scatter_core))
                    + film::widest(s.halation[film::HALATION_BOUNCES - 1])
            } else {
                0.
            }
        });
        let grain_margin = film_settings
            .zip(grain_spatial.as_ref())
            .filter(|(f, _)| f.grain_active())
            .map_or(0., |(_, grain)| grain.margin());
        let sharpen_sigma = if recipe.sharpen > 0. {
            1.0 / geom.scale
        } else {
            0.
        };
        let margin = ((3. * coupler_sigma).ceil()
            + (3. * halation_sigma).ceil()
            + grain_margin
            + (3. * sharpen_sigma).ceil()) as u32;
        let mut base = self.parameters(
            image,
            recipe,
            options,
            &geom,
            film_settings,
            prepared.map(|(_, pair, _)| pair),
            spatial.as_ref(),
            look,
        )?;
        let tables = prepared.map(|(_, _, tables)| tables.clone());
        drop(film_cache);
        let native_tone = native.map(|(native, _)| native.tone()).transpose()?;
        if let Some((native, sensor)) = native {
            // Sigma's native Color Mode: scene-linear sRGB back to the camera
            // BMT, then to native counts. The native look runs before film
            // exposure, or in `finish` without film. The legacy look stays off.
            let (counts, offset) = sensor.render_matrix(&native.params);
            let to_counts =
                color::multiply(counts, color::inverse(image.white_balance.camera_to_rgb)?);
            let output = camera::q12(sensor.output_to_srgb);
            for i in 0..9 {
                base[42 + i / 3][i % 3] = to_counts[i] as f32;
                base[45 + i / 3][i % 3] = output[i] as f32;
            }
            for (c, offset) in offset.into_iter().enumerate() {
                base[42 + c][3] = offset as f32;
            }
            base[41][1] = 1.;
            base[41][2] = native.rows_per_count();
            // Merrill ColorDQ cores small chroma differences in native counts.
            if let Some(dq) = &sensor.color_dq {
                base[41][3] = (dq.tables()[0].len() - 1) as f32;
            }
        } else if let Some(calibration) = calibration {
            let wb = std::array::from_fn(|i| base[5 + i / 3][i % 3] as f64);
            let matrix = color::multiply(calibration.matrix, wb);
            for i in 0..9 {
                base[5 + i / 3][i % 3] = matrix[i] as f32;
            }
            base[41][0] = 1.;
            let prophoto = [
                0.529345, 0.330072, 0.140583, 0.098374, 0.873461, 0.028165, 0.016883, 0.117673,
                0.865444,
            ];
            let inverse = color::inverse(prophoto)?;
            for i in 0..9 {
                base[42 + i / 3][i % 3] = prophoto[i] as f32;
                base[45 + i / 3][i % 3] = inverse[i] as f32;
            }
        }
        // Fill Light reads luminance in Sigma's 12-bit counts without
        // exposure, as SIGMA Photo Pro's Retinex map does. Without a native
        // Color Mode, a scene value of 1 is taken as 4096 counts.
        let fill = (recipe.fill_light != 0.).then(|| {
            let (counts, offset): ([[f32; 3]; 3], [f32; 3]) = match native {
                Some((native, _)) => {
                    let scale = (4096. / (native.params.pixel_saturation + 1.)) as f32;
                    (
                        std::array::from_fn(|r| std::array::from_fn(|c| base[42 + r][c] * scale)),
                        std::array::from_fn(|r| base[42 + r][3] * scale),
                    )
                }
                None => (
                    std::array::from_fn(|r| std::array::from_fn(|c| 4096. * f32::from(r == c))),
                    [0.; 3],
                ),
            };
            let mut weights = [0f32; 4];
            for (r, luma) in fill::LUMA.iter().enumerate() {
                for (c, weight) in weights.iter_mut().take(3).enumerate() {
                    *weight += luma * (0..3).map(|j| counts[r][j] * base[5 + j][c]).sum::<f32>();
                }
                weights[3] += luma * offset[r];
            }
            let (k, inverse) = fill::curve(recipe.fill_light);
            let (cell, w, h) = fill::grid_size(image.width, image.height);
            base[48] = weights;
            base[49] = [k, inverse, 0., 0.];
            base[50] = [w as f32, h as f32, cell as f32, (cell as f32 - 1.) / 2.];
            weights
        });
        base[0] = [0.; 4];
        let (passes, output) = build_passes(
            base,
            film_settings
                .zip(spatial.as_ref())
                .zip(grain_spatial.as_ref())
                .map(|((settings, spatial), grain)| (settings, spatial, grain)),
            recipe.film.is_none(),
            sharpen_sigma,
        );
        let candidates = match tiling {
            Some(tiling) => vec![tiling],
            None => tiling_candidates(width, height, options.max_dimension),
        };
        let (columns, rows, buffer_bytes) =
            choose_tiling(width, height, margin, self.buffer_limit(), &candidates).ok_or_else(
                || {
                    RenderError::Gpu(
                    "Effect radius exceeds this GPU's tile memory limit. Reduce the grain blur, scatter size, or halation size."
                        .into(),
                )
                },
            )?;
        let tiles = rows
            .iter()
            .flat_map(|&(y, th)| {
                columns.iter().map(move |&(x, tw)| Tile {
                    x,
                    y,
                    width: tw,
                    height: th,
                    // Expand through crop edges into the original frame; only the
                    // actual sensor boundary clamps. Crop/zoom must not change diffusion.
                    origin: [
                        (geom.region_x + x) as i32 - margin as i32,
                        (geom.region_y + y) as i32 - margin as i32,
                    ],
                })
            })
            .collect();
        Ok(Plan {
            width,
            height,
            full_width,
            full_height,
            region: options.region.map(|_| Crop {
                x: geom.region_x as f32 / geom.full_width as f32,
                y: geom.region_y as f32 / geom.full_height as f32,
                width: width as f32 / geom.full_width as f32,
                height: height as f32 / geom.full_height as f32,
            }),
            margin,
            tiles,
            passes,
            output,
            buffer_bytes,
            tables,
            fill,
            curves: color::curve_table(&recipe.curves)
                .into_iter()
                .chain(camera::look_table(
                    calibration,
                    native_tone,
                    native.and_then(|(_, sensor)| sensor.color_dq.as_ref()),
                ))
                .collect(),
        })
    }
    fn buffer_limit(&self) -> u64 {
        (self.device.limits().max_storage_buffer_binding_size as u64)
            .min(self.device.limits().max_buffer_size)
            // ponytail: cap each working buffer at 128 MiB; use a device memory
            // budget if previews larger than 2048 px become necessary.
            .min(128 * 1024 * 1024)
    }
    #[allow(clippy::too_many_arguments)]
    fn render_source(
        &self,
        image: &SceneLinearImage,
        source: &mut GpuSource,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
        tiling: Option<(u32, u32)>,
        look: Look<'_>,
    ) -> Result<RenderedImage, RenderError> {
        cancelled(cancel)?;
        let plan = self.plan_source(image, recipe, options, tiling, look)?;
        let (width, height) = (plan.width, plan.height);
        let frame_bytes = width as u64 * height as u64 * 4;
        if options.rgba8 && frame_bytes > self.buffer_limit() {
            return Err(RenderError::Gpu(
                "Preview exceeds this GPU's buffer limit".into(),
            ));
        }
        // All cached queue writes and submissions share this lock, including export.
        let mut cached = self
            .workspace
            .lock()
            .map_err(|_| RenderError::Gpu("Renderer unavailable".into()))?;
        if cached
            .as_ref()
            .is_none_or(|workspace| workspace.size < plan.buffer_bytes)
        {
            *cached = None;
            *cached = Some(self.new_workspace(plan.buffer_bytes));
        }
        let workspace = cached.as_mut().unwrap();
        if let Some(weights) = plan.fill {
            self.bind_fill(source, image, weights);
        }
        if let Some(tables) = &plan.tables {
            self.queue.write_buffer(
                &workspace.spectral,
                0,
                bytemuck::cast_slice(&tables.spectral),
            );
            self.queue
                .write_buffer(&workspace.tc_lut, 0, bytemuck::cast_slice(&tables.tc_lut));
        }
        self.queue
            .write_buffer(&workspace.curves, 0, bytemuck::cast_slice(&plan.curves));
        if options.rgba8 {
            self.frame_buffer(workspace, frame_bytes);
        } else if workspace.readback.is_none() {
            workspace.readback = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Preview readback"),
                size: workspace.size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }));
        }
        let mut data = if options.rgba8 {
            Pixels::Rgba8(Vec::new())
        } else {
            Pixels::Rgb16(vec![0u16; width as usize * height as usize * 3])
        };
        for (index, tile) in plan.tiles.iter().enumerate() {
            cancelled(cancel)?;
            let mut encoder = self.encode(source, workspace, &plan, tile, options.rgba8);
            let Pixels::Rgb16(data) = &mut data else {
                // RGBA8 tiles go to the frame buffer; one readback follows.
                // Queue writes for the next tile apply after this submit.
                self.queue.submit(Some(encoder.finish()));
                // Wait after every second tile, so a cancel stops a large
                // region within about two tiles of GPU work.
                if index % 2 == 1 && index + 1 < plan.tiles.len() {
                    let (tx, rx) = mpsc::channel();
                    self.queue.on_submitted_work_done(move || {
                        let _ = tx.send(Ok(()));
                    });
                    self.wait(rx, cancel)?;
                }
                continue;
            };
            let bw = tile.width + 2 * plan.margin;
            let size = bw as u64 * (tile.height + 2 * plan.margin) as u64 * 16;
            let readback = workspace.readback.as_ref().unwrap();
            encoder.copy_buffer_to_buffer(&workspace.buffers[plan.output], 0, readback, 0, size);
            self.queue.submit(Some(encoder.finish()));
            let result = self.read(readback, size, cancel, |bytes| {
                let result: &[[f32; 4]] = bytemuck::cast_slice(bytes);
                for row in 0..tile.height {
                    for col in 0..tile.width {
                        let src = ((plan.margin + row) * bw + plan.margin + col) as usize;
                        let dst = ((tile.y + row) * width + tile.x + col) as usize * 3;
                        for c in 0..3 {
                            let v = result[src][c];
                            if !v.is_finite() {
                                return Err(RenderError::Gpu(
                                    "GPU produced non-finite pixels".into(),
                                ));
                            }
                            data[dst + c] = quantize16(v);
                        }
                    }
                }
                Ok(())
            });
            if let Err(error) = result {
                // A cancelled/failed mapping must never enter the reusable cache.
                *cached = None;
                return Err(error);
            }
        }
        if let Pixels::Rgba8(data) = &mut data {
            let (_, frame, readback, _) = workspace.frame.as_ref().unwrap();
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("RGBA8 frame readback"),
                });
            encoder.copy_buffer_to_buffer(frame, 0, readback, 0, frame_bytes);
            self.queue.submit(Some(encoder.finish()));
            let result = self.read(readback, frame_bytes, cancel, |bytes| {
                *data = checked_frame(width, height, bytes)?;
                Ok(())
            });
            if let Err(error) = result {
                *cached = None;
                return Err(error);
            }
        }
        cancelled(cancel)?;
        Ok(RenderedImage {
            width,
            height,
            data,
            color_profile: options.color_profile,
            full_width: plan.full_width,
            full_height: plan.full_height,
            region: plan.region,
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn parameters(
        &self,
        image: &SceneLinearImage,
        r: &EditRecipe,
        o: RenderOptions,
        g: &geometry::Geometry,
        film: Option<&FilmSettings>,
        pair: Option<&film::FilmPair>,
        spatial: Option<&film::Spatial>,
        look: Look<'_>,
    ) -> Result<Parameters, RenderError> {
        let mut p: Parameters = [[0.; 4]; PARAMETER_SLOTS];
        // A B&W film already makes a neutral image; the sensor-layer mix is
        // only for colour film or no film. Both neutralize the output.
        let silver = r.film.is_some() && pair.is_some_and(|pair| pair.monochrome);
        let sensor_mix = r.monochrome.filter(|_| !silver);
        let neutral = r.monochrome.is_some() || silver;
        p[1] = [
            g.scale,
            o.color_profile.index(),
            f32::from(r.film.is_some()),
            f32::from(neutral),
        ];
        p[2] = [
            r.exposure,
            r.contrast / 100.,
            r.highlights / 100.,
            r.shadows / 100.,
        ];
        p[3] = [
            r.whites / 100.,
            r.blacks / 100.,
            if neutral { 0. } else { r.saturation / 100. },
            if neutral { 0. } else { r.vibrance / 100. },
        ];
        p[4][0] = r.sharpen / 100.;
        if let Some(monochrome) = sensor_mix {
            p[4][1..].copy_from_slice(&color::monochrome_mix(
                &image.white_balance,
                monochrome.filter,
            )?);
        }
        let wb = match &r.raw_color {
            Some(raw) => color::raw_color_matrix(&image.white_balance, raw)?,
            None => match r.white_balance_gains {
                Some(gains) => color::gain_white_balance_matrix(&image.white_balance, gains)?,
                None => color::white_balance_matrix(&image.white_balance, r.temperature, r.tint)?,
            },
        };
        for i in 0..3 {
            for j in 0..3 {
                p[5 + i][j] = wb[i * 3 + j] as f32;
            }
        }
        let centers = [0., 1. / 12., 1. / 6., 1. / 3., 0.5, 2. / 3., 0.75, 5. / 6.];
        if neutral {
            for (i, value) in r.tone_mixer.iter().enumerate() {
                p[60 + i / 4][i % 4] = value / 100.;
            }
            p[62][0] = r.warmth / 100.;
        }
        for (i, b) in r.hsl.iter().enumerate() {
            p[8 + i] = [
                if neutral { 0. } else { b.hue / 100. },
                if neutral { 0. } else { b.saturation / 100. },
                if neutral { 0. } else { b.luminance / 100. },
                centers[i],
            ];
        }
        // Color wheels: rows 56..58 hold each zone's RGB offset and log2 gain;
        // row 59 the two zone borders, the ramp half-width (zero is a hard
        // split) and an on flag. Without an offset or gain the flag stays off,
        // so `finish` skips the grade.
        let w = &r.wheels;
        for (row, wheel) in [w.shadows, w.midtones, w.highlights]
            .into_iter()
            .enumerate()
        {
            // Keep hidden color grades in the recipe for a return to color.
            if !neutral {
                // The dot on a hue wheel with red at 0°, green at 120° and blue
                // at 240°. 0.1 at the rim is a strong tint that rarely clips.
                for (c, hue) in [0f32, 120., 240.].into_iter().enumerate() {
                    let (sin, cos) = hue.to_radians().sin_cos();
                    p[56 + row][c] = 0.1 * (wheel.x * cos + wheel.y * sin);
                }
                p[56 + row][3] = wheel.luminance / 100.;
            }
        }
        if p[56..59].iter().flatten().any(|&v| v != 0.) {
            let shift = -0.2 * w.balance / 100.;
            p[59] = [
                1. / 3. + shift,
                2. / 3. + shift,
                0.3 * w.blending / 100.,
                1.,
            ];
        }
        if let (Some(f), Some(pair), Some(_)) = (film, pair, spatial) {
            p[62][1] = pair.silver_scale;
            let channels = |values| film::channels(values, pair.monochrome);
            let grain = pair.grain.spatial_for(g.long_edge(), f);
            let native = f.halation_params.as_ref();
            let scatter_strength = channels(native.map_or(f.scatter_strength_rgb, |_| {
                film::SCATTER_TAIL_WEIGHT.map(|v| v as f32)
            }));
            // The recipe's halation strength scales the per-channel strength,
            // as spektrafilm's `halation_amount` does. The default scale is one.
            let strength = native.map_or(f.halation_strength / 0.35, |p| p.halation_amount);
            let halation_strength = channels(native.map_or(f.halation_strength_rgb, |_| {
                film::halation_preset(f.film).1.map(|v| v as f32)
            }))
            .map(|v| v * strength);
            // The camera's metered gray exposes the film as its mid-gray. The
            // scanner correction keeps it there after the white and black
            // remap.
            let (print_correction, film_correction) = if look.scanner {
                (
                    pair.print_exposure_correction,
                    pair.film_exposure_correction,
                )
            } else {
                (1., 1.)
            };
            // A native camera look already maps scene values to output luminance.
            let metering = if look.native.is_some() {
                1.
            } else {
                (0.184 / look.metered_gray) as f32
            };
            p[16] = [
                2f32.powf(f.ev_film) * metering * film_correction,
                1.,
                1.,
                f32::from(f.negative),
            ];
            p[17] = [
                pair.print_normalization * print_correction,
                pair.scan_normalization,
                if f.grain_params.is_some() {
                    1.
                } else {
                    f.grain_amount
                },
                if f.grain_params.is_some() {
                    1.
                } else {
                    f.grain_saturation
                },
            ];
            for i in 0..3 {
                p[18 + i][..3].copy_from_slice(&pair.rgb_to_adapted_xyz[i]);
                p[26 + i][..3].copy_from_slice(&pair.scan_xyz_to_rgb[i]);
                p[29 + i][..3].copy_from_slice(&pair.dir_matrix[i]);
                p[32][i] = pair.dir_density_max[i];
                p[51][i] = pair.dir_receiver_reference[i];
                p[53][i] = pair.grain.preset.uniformity[i] as f32;
                p[54][i] = pair.grain.preset.floor[i] as f32;
                p[37][i] = scatter_strength[i];
                p[38][i] = halation_strength[i];
                p[39][i] = 1. / (1. + p[38][i]);
            }
            if let Some([m, q]) = pair.scan_remap.filter(|_| look.scanner) {
                p[26][3] = m;
                p[27][3] = q;
                p[28][3] = 1.;
            }
            p[32][3] = f32::from(pair.dir_positive);
            // One silver layer: every channel draws the same grain.
            p[37][3] = f32::from(pair.monochrome);
            p[52] = [
                pair.grain_offset as f32,
                pair.grain.layers.len() as f32,
                pair.grain.curve_count as f32,
                0.,
            ];
            p[53][3] = grain.micro_sigma;
            p[54][3] = grain.usm_amount;
            p[55][0] = grain.pixel_area;
            p[34][3] = f32::from_bits(r.seed);
            p[35][3] = if f.grain_params.is_some() {
                0.
            } else {
                f.grain_roughness
            };
            p[36][3] = if f.grain_params.is_some() {
                1.
            } else {
                film::grain_clump_cell(f, g.native_width.max(g.native_height) as f32)
            };
            p[38][3] = if native.is_some() {
                0.
            } else {
                f.halation_midtones
            };
        }
        let grain = g.grain_transform();
        p[22] = grain[0];
        p[23] = grain[1];
        let source = g.source_transform(image);
        p[24] = source[0];
        p[25] = source[1];
        p[40] = source[2];
        Ok(p)
    }
    fn new_workspace(&self, size: u64) -> Workspace {
        let buffer = |label, size, usage| {
            self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage,
                mapped_at_creation: false,
            })
        };
        let uniform_stride = PARAMETER_BYTES
            .div_ceil(self.device.limits().min_uniform_buffer_offset_alignment as u64)
            * self.device.limits().min_uniform_buffer_offset_alignment as u64;
        Workspace {
            size,
            frame: None,
            buffers: (0..BUFFERS)
                .map(|_| {
                    buffer(
                        "Editor pixels",
                        size,
                        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    )
                })
                .collect(),
            readback: None,
            uniform: buffer(
                "Dispatch parameters",
                uniform_stride * MAX_DISPATCHES,
                wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            ),
            uniform_stride: uniform_stride as u32,
            spectral: buffer(
                "Film and paper spectral tables",
                (film::SPECTRAL_FLOATS * 4) as u64,
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            ),
            tc_lut: buffer(
                "Spectral upsampling LUT",
                (film::spectra::LUT_SIZE * film::spectra::LUT_SIZE * 3 * 4) as u64,
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            ),
            curves: buffer(
                "Edit curves",
                (1024 + camera::LOOK_ROWS) as u64 * 16,
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            ),
            bindings: HashMap::new(),
        }
    }
    /// Grows the RGBA8 frame buffer and its readback copy to `bytes`.
    fn frame_buffer(&self, workspace: &mut Workspace, bytes: u64) {
        if workspace.frame.as_ref().is_some_and(|f| f.0 >= bytes) {
            return;
        }
        workspace.frame = None;
        let frame = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("RGBA8 frame"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("RGBA8 frame readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("RGBA8 frame"),
            layout: &self.frame_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            }],
        });
        workspace.frame = Some((bytes, frame, readback, bind));
    }
    /// Records the passes of one tile. With `pack`, the tile interior also goes
    /// to the RGBA8 frame buffer.
    fn encode(
        &self,
        source: &GpuSource,
        workspace: &mut Workspace,
        plan: &Plan,
        tile: &Tile,
        pack: bool,
    ) -> wgpu::CommandEncoder {
        let slot0 = plan.slot0(tile);
        let pack = pack.then(|| {
            let mut params: Parameters = [[0.; 4]; PARAMETER_SLOTS];
            params[21] = [
                plan.margin as f32,
                plan.width as f32,
                tile.x as f32,
                tile.y as f32,
            ];
            // `pack` only reads; its destination binding must not alias the source.
            Pass {
                entry: "pack",
                buffers: [plan.output, plan.output, (plan.output + 1) % BUFFERS],
                params,
            }
        });
        assert!(plan.passes.len() + usize::from(pack.is_some()) <= MAX_DISPATCHES as usize);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("RAW edit frame/tile"),
            });
        for (slot, pass) in plan.passes.iter().chain(&pack).enumerate() {
            let mut params = pass.params;
            params[0] = slot0;
            let indices = pass.buffers;
            // Each dispatch has its own aligned uniform slot. Rewriting a single
            // slot before submit would make every dispatch see the last parameters.
            let offset = slot as u32 * workspace.uniform_stride;
            self.queue.write_buffer(
                &workspace.uniform,
                offset as u64,
                bytemuck::cast_slice(&params),
            );
            let bind = workspace.bindings.entry(indices).or_insert_with(|| {
                let bound = [
                    &workspace.buffers[indices[0]],
                    &workspace.buffers[indices[1]],
                    &workspace.buffers[indices[2]],
                    &workspace.uniform,
                    &workspace.spectral,
                    &workspace.tc_lut,
                    &workspace.curves,
                    &self.output_gamut,
                ];
                let entries: Vec<_> = bound
                    .iter()
                    .enumerate()
                    .map(|(i, buffer)| wgpu::BindGroupEntry {
                        binding: i as u32,
                        resource: if i == 3 {
                            wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer,
                                offset: 0,
                                size: std::num::NonZeroU64::new(PARAMETER_BYTES),
                            })
                        } else {
                            buffer.as_entire_binding()
                        },
                    })
                    .collect();
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.layout,
                    entries: &entries,
                })
            });
            let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(pass.entry),
                timestamp_writes: None,
            });
            compute.set_pipeline(&self.pipelines[pass.entry]);
            compute.set_bind_group(0, &*bind, &[offset]);
            let (width, height) = match pass.entry {
                "sample" => {
                    compute.set_bind_group(1, &source.bind, &[]);
                    (slot0[0] as u32, slot0[1] as u32)
                }
                "pack" => {
                    let (_, _, _, frame) = workspace.frame.as_ref().unwrap();
                    compute.set_bind_group(1, frame, &[]);
                    (tile.width, tile.height)
                }
                _ => (slot0[0] as u32, slot0[1] as u32),
            };
            compute.dispatch_workgroups(width.div_ceil(16), height.div_ceil(8), 1);
        }
        encoder
    }
    /// Maps the first `size` bytes of a submitted readback buffer and passes them
    /// to `use_bytes`. On error the caller must drop the workspace.
    fn read<T>(
        &self,
        readback: &wgpu::Buffer,
        size: u64,
        cancel: &AtomicBool,
        use_bytes: impl FnOnce(&[u8]) -> Result<T, RenderError>,
    ) -> Result<T, RenderError> {
        let slice = readback.slice(..size);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r.map_err(|e| e.to_string()));
        });
        self.wait(rx, cancel)?;
        let view = slice.get_mapped_range();
        let result = use_bytes(&view);
        drop(view);
        readback.unmap();
        result
    }
    /// Polls the device until `done` reports, the GPU fails or `cancel` is set.
    fn wait(
        &self,
        done: mpsc::Receiver<Result<(), String>>,
        cancel: &AtomicBool,
    ) -> Result<(), RenderError> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            // A poll error is not fatal here. The loop checks the GPU error and the deadline.
            let _ = self.device.poll(wgpu::PollType::Poll);
            cancelled(cancel)?;
            if let Ok(error) = self.gpu_error.lock() {
                if let Some(error) = error.as_ref() {
                    return Err(RenderError::Gpu(error.clone()));
                }
            }
            if std::time::Instant::now() > deadline {
                return Err(RenderError::Gpu(
                    "The GPU did not finish a tile within 60 seconds".into(),
                ));
            }
            // Mapping callbacks are driven by poll(), not by the channel wait.
            // A long timeout here adds that delay to every otherwise-fast tile.
            match done.recv_timeout(std::time::Duration::from_micros(200)) {
                Ok(result) => {
                    result.map_err(RenderError::Gpu)?;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(e) => return Err(RenderError::Gpu(e.to_string())),
            }
            // Dropping a cancelled request discards its buffers/results; a submitted
            // dispatch itself remains owned by wgpu until the GPU has finished it.
        }
        cancelled(cancel)
    }
}

/// One source texture texel: scene-linear RGB with alpha 1.
fn texel(rgb: &[f32; 3]) -> [f32; 4] {
    [rgb[0], rgb[1], rgb[2], 1.]
}

pub fn output_dimensions(
    image: &SceneLinearImage,
    recipe: &EditRecipe,
) -> Result<(u32, u32), RenderError> {
    recipe.validate().map_err(RenderError::Invalid)?;
    let g = geometry::Geometry::new(image, recipe, RenderOptions::default())?;
    Ok((g.width, g.height))
}

#[cfg(test)]
mod coupler_chain_tests {
    use super::*;

    #[test]
    fn exponential_components_read_the_original_source_and_keep_it_live() {
        for decay in [0., 0.1, 0.2, 1., 30.] {
            let mut chain = Chain::new([[0.; 4]; PARAMETER_SLOTS]);
            let src = chain.alloc();
            let output = chain.exponential(src, [decay; 3]);
            assert!(chain.busy[src]);
            assert!(chain.busy[output]);
            assert_eq!(
                chain.busy.iter().filter(|&&busy| busy).count(),
                if output == src { 1 } else { 2 }
            );
            for (name, [input, auxiliary, destination], parameters) in &chain.passes {
                assert_ne!(input, destination);
                assert_ne!(auxiliary, destination);
                if *name == "blur" && parameters[22][0] == 0. {
                    assert_eq!(*input, src);
                }
            }
            if decay <= 0.1 {
                assert!(chain.passes.is_empty());
                assert_eq!(output, src);
            }
        }
    }

    #[test]
    fn coupler_tail_passes_fit_the_workspace_at_zero_and_subpixel_radii() {
        for radius in [0., 0.000001, 0.0015, 0.01] {
            let settings = FilmSettings {
                couplers: 1.,
                couplers_radius: radius,
                halation: true,
                grain: true,
                ..FilmSettings::default()
            };
            for long_edge in [1., 128., 6000., 100_000.] {
                let spatial = film::Spatial::new(&settings, long_edge, false);
                let profile = film::profile::load(settings.film as usize).unwrap();
                let grain = film::grain::Grain::build(&profile)
                    .unwrap()
                    .spatial(long_edge, settings.grain_size);
                assert_eq!(spatial.coupler_tail == 0., radius == 0.);
                let (passes, _) = build_passes(
                    [[0.; 4]; PARAMETER_SLOTS],
                    Some((&settings, &spatial, &grain)),
                    false,
                    1.,
                );
                assert!(passes.len() < MAX_DISPATCHES as usize);
                for pass in &passes {
                    assert_ne!(pass.buffers[0], pass.buffers[2]);
                    assert_ne!(pass.buffers[1], pass.buffers[2]);
                }
            }
        }
    }
}
