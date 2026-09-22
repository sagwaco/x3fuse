//! GPU-only scene-linear RAW editing. The physical film implementation is GPL-3.0-only.
mod color;
mod film;
mod geometry;
mod recipe;
mod stocks;
pub use color::pick_white_balance;
pub use recipe::{
    Crop, Curves, EditRecipe, FilmSettings, HslBand, MonochromeFilter, MonochromeSettings, Point,
};
pub use stocks::STOCKS_JSON;

/// Identifies the rendering output, not the crate API. **Bump it whenever a
/// change alters rendered pixels** - a shader edit, a model or asset change, a
/// different default. Callers that persist rendered images must mix it into
/// their cache keys, or previews produced by an older build keep being served
/// next to freshly rendered exports. `2` is the spektrafilm model; `1` was the
/// implementation it replaced.
pub const RENDER_VERSION: u32 = 2;

use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};
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
}
pub struct RenderedImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u16>,
    pub color_profile: ColorProfile,
    /// Native edited output dimensions, independent of proxy/region resolution.
    pub full_width: u32,
    pub full_height: u32,
    /// Actual pixel-aligned normalized region within the edited output.
    pub region: Option<Crop>,
}
impl RenderedImage {
    pub fn rgb8(&self) -> Vec<u8> {
        self.data
            .iter()
            .map(|&v| ((v as u32 + 128) / 257) as u8)
            .collect()
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
            &self.data,
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
    gpu: Mutex<Option<GpuSource>>,
}
impl PreparedImage {
    pub fn new(image: SceneLinearImage, cancel: &AtomicBool) -> Result<Self, RenderError> {
        validate_scene(&image, cancel)?;
        Ok(Self {
            image,
            gpu: Mutex::new(None),
        })
    }
    pub fn image(&self) -> &SceneLinearImage {
        &self.image
    }
}

struct GpuSource {
    device: wgpu::Device,
    bind: wgpu::BindGroup,
}

type Parameters = [[f32; 4]; 40];
const PARAMETER_BYTES: u64 = std::mem::size_of::<Parameters>() as u64;
const MAX_DISPATCHES: u64 = 36;
/// Blurs below this radius are indistinguishable from a copy; skipping them
/// keeps sub-pixel spektrafilm stages off the pass list entirely.
const MIN_SIGMA: f32 = 0.3;
/// Working pixel buffers available to the pass list.
const BUFFERS: usize = 6;

/// One reusable working set, bounded by the largest preview/tile rendered.
struct Workspace {
    size: u64,
    buffers: Vec<wgpu::Buffer>,
    readback: wgpu::Buffer,
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
    /// Separable Gaussian. Returns `src` unchanged when the radius would round
    /// away, so sub-pixel spektrafilm stages cost no dispatches.
    fn blur(&mut self, src: usize, sigma: f32) -> usize {
        if sigma < MIN_SIGMA || sigma.is_nan() {
            return src;
        }
        let mut q = self.base;
        q[21] = [sigma, 0., (3. * sigma).ceil(), 0.];
        let mid = self.emit("blur", src, src, q);
        q[21][1] = 1.;
        let dst = self.emit("blur", mid, mid, q);
        self.release(mid);
        dst
    }
    fn scaled(&mut self, src: usize, aux: usize, a: f32, b: f32) -> usize {
        let mut q = self.base;
        q[21] = [a, b, 0., 0.];
        self.emit("combine", src, aux, q)
    }
    /// Scatter mix plus the multi-bounce halation add, on linear film raw.
    fn halation(&mut self, raw: usize, spatial: &film::Spatial) -> usize {
        let mut current = raw;
        if spatial.scatter_tail >= MIN_SIGMA {
            let core = self.blur(current, spatial.scatter_core);
            let tail = self.blur(current, spatial.scatter_tail);
            let scattered = self.two("scatter_mix", core, tail);
            if core != current {
                self.release(core);
            }
            self.release(tail);
            self.release(current);
            current = scattered;
        }
        if spatial.halation[0] < MIN_SIGMA {
            return current;
        }
        let weights = film::bounce_weights();
        let mut accumulated: Option<usize> = None;
        for (k, &weight) in weights.iter().enumerate() {
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

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    source_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
    /// ponytail: one-entry film/paper cache; make it a small LRU only if
    /// switching stocks in the UI measurably stalls.
    film: Mutex<Option<(film::FilmLut, film::FilmPair)>>,
    pub adapter_name: String,
    gpu_error: Arc<Mutex<Option<String>>>,
    workspace: Mutex<Option<Workspace>>,
}
impl Renderer {
    pub fn new() -> Result<Self, RenderError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter=pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions{power_preference:wgpu::PowerPreference::HighPerformance,force_fallback_adapter:false,compatible_surface:None}))
            .ok_or_else(||RenderError::Gpu("No compatible GPU adapter. Update your graphics driver or use original conversion.".into()))?;
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu {
            return Err(RenderError::Gpu(
                "A hardware GPU is required for editing".into(),
            ));
        }
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("X3Fuse editor"),
                required_features: wgpu::Features::empty(),
                required_limits: limits,
                memory_hints: wgpu::MemoryHints::MemoryUsage,
            },
            None,
        ))
        .map_err(|e| RenderError::Gpu(e.to_string()))?;
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Spectral RAW editor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("render.wgsl").into()),
        });
        let entries: Vec<_> = (0..7)
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
            label: Some("Prepared RAW texture"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let sample_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("RAW geometry"),
            bind_group_layouts: &[&layout, &source_layout],
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
            "grain",
            "print_spectral",
            "print_develop",
            "scan",
            "blur",
            "finish",
            "output",
        ]
        .into_iter()
        .map(|name| {
            (
                name,
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(if name == "sample" {
                        &sample_layout
                    } else {
                        &pipeline_layout
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
        device.on_uncaptured_error(Box::new(move |e| {
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
        Ok(Self {
            device,
            queue,
            layout,
            source_layout,
            pipelines,
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
        let source = self.upload(image, cancel)?;
        self.render_source(image, &source, recipe, options, cancel, None)
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
        self.render_source(
            image.image(),
            gpu.as_ref().unwrap(),
            recipe,
            options,
            cancel,
            None,
        )
    }
    #[cfg(test)]
    fn render_tiled(
        &self,
        image: &SceneLinearImage,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
        tile_size: u32,
    ) -> Result<RenderedImage, RenderError> {
        let source = self.upload(image, cancel)?;
        self.render_source(image, &source, recipe, options, cancel, Some(tile_size))
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
            let rgba: Vec<[f32; 4]> = rows
                .as_chunks::<3>()
                .0
                .iter()
                .map(|p| [p[0], p[1], p[2], 1.])
                .collect();
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
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Prepared RAW source"),
            layout: &self.source_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        Ok(GpuSource {
            device: self.device.clone(),
            bind,
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn render_source(
        &self,
        image: &SceneLinearImage,
        source: &GpuSource,
        recipe: &EditRecipe,
        options: RenderOptions,
        cancel: &AtomicBool,
        tile_size: Option<u32>,
    ) -> Result<RenderedImage, RenderError> {
        cancelled(cancel)?;
        recipe.validate().map_err(RenderError::Invalid)?;
        let geom = geometry::Geometry::new(image, recipe, options)?;
        let (full_width, full_height) = output_dimensions(image, recipe)?;
        let (width, height) = (geom.width, geom.height);
        let mut data = vec![0u16; width as usize * height as usize * 3];
        // spektrafilm's spatial parameters are physical, so they are derived
        // from the full output frame; a tile or region must never change them.
        let spatial = recipe
            .film
            .as_ref()
            .map(|f| film::Spatial::new(f, geom.long_edge()));
        let stage_sigma =
            |pick: fn(&film::Spatial, &FilmSettings) -> f32| match (&spatial, &recipe.film) {
                (Some(s), Some(f)) => pick(s, f),
                _ => 0.,
            };
        let coupler_sigma = stage_sigma(|s, f| if f.couplers > 0. { s.coupler } else { 0. });
        // Scatter and the widest bounce are applied in series, so their halos add.
        let halation_sigma = stage_sigma(|s, f| {
            if f.halation {
                s.scatter_tail + s.halation[film::HALATION_BOUNCES - 1]
            } else {
                0.
            }
        });
        let grain_sigma = stage_sigma(|_, f| if f.grain { film::GRAIN_BLUR_PX } else { 0. });
        let sharpen_sigma = if recipe.sharpen > 0. {
            1.0 / geom.scale
        } else {
            0.
        };
        let margin = ((3. * coupler_sigma).ceil()
            + (3. * halation_sigma).ceil()
            + (3. * grain_sigma).ceil()
            + (3. * sharpen_sigma).ceil()) as u32;
        // Preparing the pair is the expensive CPU step; hold its cache for the
        // whole render so tiles reuse it. Always locked before the workspace.
        let mut film_cache = self
            .film
            .lock()
            .map_err(|_| RenderError::Gpu("Renderer unavailable".into()))?;
        if let Some(settings) = &recipe.film {
            let stale = film_cache
                .as_ref()
                .is_none_or(|(lut, pair)| !lut.matches(settings) || !pair.matches(settings));
            if stale {
                // Rebuild the LUT only when the film itself changed; paper,
                // trim and exposure changes reuse it.
                let lut = match film_cache.take() {
                    Some((lut, _)) if lut.matches(settings) => lut,
                    _ => film::FilmLut::build(settings.film)?,
                };
                let pair = film::FilmPair::build(settings, &lut)?;
                *film_cache = Some((lut, pair));
            }
        }
        let prepared = recipe.film.as_ref().and(film_cache.as_ref());
        let pair = prepared.map(|(_, pair)| pair);
        let mut params = self.parameters(image, recipe, options, &geom, pair, spatial.as_ref())?;
        let curves = color::curve_table(&recipe.curves);
        let limit = (self.device.limits().max_storage_buffer_binding_size as u64)
            .min(self.device.limits().max_buffer_size)
            // ponytail: cap each working buffer at 128 MiB; use a device memory
            // budget if previews larger than 2048 px become necessary.
            .min(128 * 1024 * 1024);
        let frame_size =
            (width as u64 + 2 * margin as u64) * (height as u64 + 2 * margin as u64) * 16;
        let working_set = |tile: u32| {
            (width.min(tile) as u64 + 2 * margin as u64)
                * (height.min(tile) as u64 + 2 * margin as u64)
                * 16
        };
        let tile_size = tile_size.unwrap_or_else(|| {
            if options.max_dimension.is_some_and(|edge| edge <= 2048) && frame_size <= limit {
                width.max(height)
            } else if working_set(1024) <= limit {
                // Larger tiles amortize the per-tile readback round trip and the
                // halo overdraw, which the 81-wavelength spectral loops make
                // expensive at native resolution. A large diffusion radius can
                // still push them past the buffer limit; fall back rather than
                // refuse the render.
                1024
            } else {
                512
            }
        });
        let size = working_set(tile_size);
        if size > limit {
            return Err(RenderError::Gpu(
                "Effect radius exceeds this GPU's tile memory limit. Reduce diffusion radius."
                    .into(),
            ));
        }
        // All cached queue writes and submissions share this lock, including export.
        let mut cached = self
            .workspace
            .lock()
            .map_err(|_| RenderError::Gpu("Renderer unavailable".into()))?;
        if cached
            .as_ref()
            .is_none_or(|workspace| workspace.size < size)
        {
            *cached = None;
            *cached = Some(self.new_workspace(size));
        }
        let workspace = cached.as_mut().unwrap();
        if let Some((lut, pair)) = prepared {
            self.queue
                .write_buffer(&workspace.spectral, 0, bytemuck::cast_slice(&pair.spectral));
            self.queue
                .write_buffer(&workspace.tc_lut, 0, bytemuck::cast_slice(&lut.uploadable));
        }
        self.queue
            .write_buffer(&workspace.curves, 0, bytemuck::cast_slice(&curves));
        for y in (0..height).step_by(tile_size as usize) {
            for x in (0..width).step_by(tile_size as usize) {
                cancelled(cancel)?;
                let tw = tile_size.min(width - x);
                let th = tile_size.min(height - y);
                let gx = geom.region_x + x;
                let gy = geom.region_y + y;
                // Expand through crop edges into the original frame; only the actual
                // sensor boundary clamps. Crop/zoom must not change diffusion.
                let sx = gx as i32 - margin as i32;
                let sy = gy as i32 - margin as i32;
                let bw = tw + 2 * margin;
                let bh = th + 2 * margin;
                params[0] = [bw as f32, bh as f32, sx as f32, sy as f32];
                let result = self.tile(
                    source,
                    workspace,
                    params,
                    recipe.film.as_ref().zip(spatial.as_ref()),
                    sharpen_sigma,
                    cancel,
                );
                let result = match result {
                    Ok(result) => result,
                    Err(error) => {
                        // A cancelled/failed mapping must never enter the reusable cache.
                        *cached = None;
                        return Err(error);
                    }
                };
                for row in 0..th {
                    for col in 0..tw {
                        let src = ((margin + row) * bw + margin + col) as usize;
                        let dst = ((y + row) * width + x + col) as usize * 3;
                        for c in 0..3 {
                            let v = result[src][c];
                            if !v.is_finite() {
                                return Err(RenderError::Gpu(
                                    "GPU produced non-finite pixels".into(),
                                ));
                            }
                            data[dst + c] = (v.clamp(0., 1.) * 65535.).round() as u16;
                        }
                    }
                }
            }
        }
        cancelled(cancel)?;
        Ok(RenderedImage {
            width,
            height,
            data,
            color_profile: options.color_profile,
            full_width,
            full_height,
            region: options.region.map(|_| Crop {
                x: geom.region_x as f32 / geom.full_width as f32,
                y: geom.region_y as f32 / geom.full_height as f32,
                width: width as f32 / geom.full_width as f32,
                height: height as f32 / geom.full_height as f32,
            }),
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn parameters(
        &self,
        image: &SceneLinearImage,
        r: &EditRecipe,
        o: RenderOptions,
        g: &geometry::Geometry,
        pair: Option<&film::FilmPair>,
        spatial: Option<&film::Spatial>,
    ) -> Result<Parameters, RenderError> {
        let mut p: Parameters = [[0.; 4]; 40];
        p[1] = [
            g.scale,
            o.color_profile.index(),
            f32::from(r.film.is_some()),
            f32::from(r.monochrome.is_some()),
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
            r.saturation / 100.,
            r.vibrance / 100.,
        ];
        p[4][0] = r.sharpen / 100.;
        if let Some(monochrome) = r.monochrome {
            p[4][1..].copy_from_slice(&color::monochrome_mix(
                &image.white_balance,
                monochrome.filter,
            )?);
        }
        let wb = color::white_balance_matrix(&image.white_balance, r.temperature, r.tint)?;
        for i in 0..3 {
            for j in 0..3 {
                p[5 + i][j] = wb[i * 3 + j] as f32;
            }
        }
        let centers = [0., 1. / 12., 1. / 6., 1. / 3., 0.5, 2. / 3., 0.75, 5. / 6.];
        for (i, b) in r.hsl.iter().enumerate() {
            p[8 + i] = [
                b.hue / 100.,
                b.saturation / 100.,
                b.luminance / 100.,
                centers[i],
            ];
        }
        if let (Some(f), Some(pair), Some(_)) = (&r.film, pair, spatial) {
            let (grain_min, grain_uniformity, sub_layers) = film::grain_constants();
            let particles = film::grain_particles(f, g.long_edge());
            // The recipe's halation strength scales spektrafilm's per-channel
            // baseline, which its own default reproduces exactly.
            let strength = f.halation_strength / recipe::FilmSettings::default().halation_strength;
            p[16] = [
                2f32.powf(f.ev_film),
                1. / f.gamma_film,
                1. / f.gamma_paper,
                f32::from(f.negative),
            ];
            p[17] = [
                pair.print_normalization,
                pair.scan_normalization,
                f.grain_amount,
                f.grain_saturation,
            ];
            for i in 0..3 {
                p[18 + i][..3].copy_from_slice(&pair.rgb_to_adapted_xyz[i]);
                p[26 + i][..3].copy_from_slice(&pair.scan_xyz_to_rgb[i]);
                p[29 + i][..3].copy_from_slice(&pair.dir_matrix[i]);
                p[32][i] = pair.dir_density_max[i];
                p[33][i] = grain_min[i];
                p[34][i] = pair.grain_density_max[i];
                p[35][i] = particles[i];
                p[36][i] = grain_uniformity[i];
                p[37][i] = film::scatter_tail_weight()[i];
                p[38][i] = pair.halation_a_tot[i] * strength;
                p[39][i] = 1. / (1. + p[38][i]);
            }
            p[32][3] = f32::from(pair.dir_positive);
            p[33][3] = sub_layers as f32;
            p[34][3] = f32::from_bits(r.seed);
            p[38][3] = f.halation_midtones;
        }
        let grain = g.grain_transform();
        p[22] = grain[0];
        p[23] = grain[1];
        let source = g.source_transform(image);
        p[24] = source[0];
        p[25] = source[1];
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
            buffers: (0..BUFFERS)
                .map(|_| {
                    buffer(
                        "Editor pixels",
                        size,
                        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    )
                })
                .collect(),
            readback: buffer(
                "Preview readback",
                size,
                wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            ),
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
                1024 * 16,
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            ),
            bindings: HashMap::new(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn tile(
        &self,
        source: &GpuSource,
        workspace: &mut Workspace,
        p: Parameters,
        film: Option<(&FilmSettings, &film::Spatial)>,
        sharpen: f32,
        cancel: &AtomicBool,
    ) -> Result<Vec<[f32; 4]>, RenderError> {
        let size = p[0][0] as u64 * p[0][1] as u64 * 16;
        let mut chain = Chain::new(p);
        let mut current = chain.start();
        if let Some((settings, spatial)) = film {
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
                let diffused = chain.blur(inhibitor, spatial.coupler);
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
            if settings.grain {
                let grained = chain.one("grain", current);
                chain.release(current);
                current = chain.blur(grained, film::GRAIN_BLUR_PX);
                if current != grained {
                    chain.release(grained);
                }
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
            chain.blur(finished, sharpen)
        } else {
            finished
        };
        let readback = chain.two("output", finished, sharp);
        let passes = chain.passes;
        assert!(passes.len() <= MAX_DISPATCHES as usize);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("RAW edit frame/tile"),
            });
        for (slot, (name, indices, params)) in passes.into_iter().enumerate() {
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
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(name),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipelines[name]);
            pass.set_bind_group(0, &*bind, &[offset]);
            if name == "sample" {
                pass.set_bind_group(1, &source.bind, &[]);
            }
            pass.dispatch_workgroups(
                (params[0][0] as u32).div_ceil(16),
                (params[0][1] as u32).div_ceil(8),
                1,
            );
        }
        encoder.copy_buffer_to_buffer(
            &workspace.buffers[readback],
            0,
            &workspace.readback,
            0,
            size,
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = workspace.readback.slice(..size);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            self.device.poll(wgpu::Maintain::Poll);
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
            match rx.recv_timeout(std::time::Duration::from_micros(200)) {
                Ok(result) => {
                    result.map_err(|e| RenderError::Gpu(e.to_string()))?;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(e) => return Err(RenderError::Gpu(e.to_string())),
            }
            // Dropping a cancelled request discards its buffers/results; a submitted
            // dispatch itself remains owned by wgpu until the GPU has finished it.
        }
        cancelled(cancel)?;
        let view = slice.get_mapped_range();
        let result = bytemuck::cast_slice(&view).to_vec();
        drop(view);
        workspace.readback.unmap();
        Ok(result)
    }
}

pub fn output_dimensions(
    image: &SceneLinearImage,
    recipe: &EditRecipe,
) -> Result<(u32, u32), RenderError> {
    recipe.validate().map_err(RenderError::Invalid)?;
    let g = geometry::Geometry::new(image, recipe, RenderOptions::default())?;
    Ok((g.width, g.height))
}
