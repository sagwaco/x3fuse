//! SIGMA Photo Pro's X3 Fill Light. SPP builds a Retinex map once per image
//! (`GenerateRetinexLogGain` in its Retinex.cpp): for each pixel, the log
//! luminance it moves toward minus the log luminance it has. The slider only
//! sets how far the pixel moves: the gain is
//! `exp(k tanh(x / (|k| + 1/16)^0.25))` with `k = 1.33 * slider`.
//!
//! This module builds the slowly varying part of the map on a reduced grid.
//! The `sample` pass adds each pixel's own luminance.
use x3f_core::SceneLinearImage;

/// Long edge of the grid, in cells. The pyramid is relative to the image
/// size, so the grid resolution changes the map very little.
/// ponytail: CPU fields on a 1024-cell grid; build them on the GPU if WB
/// drags with Fill Light set become slow.
const GRID: u32 = 1024;
/// SPP's luminance weights on its Stage 2 RGB.
pub(crate) const LUMA: [f32; 3] = [0.25, 0.65, 0.1];

/// Native pixels per grid cell and the grid size.
pub(crate) fn grid_size(width: u32, height: u32) -> (u32, u32, u32) {
    let cell = width.max(height).div_ceil(GRID).max(1);
    (cell, width.div_ceil(cell), height.div_ceil(cell))
}

/// The prepared scene, box-averaged on the grid.
pub(crate) struct Grid(Vec<[f32; 3]>);
impl Grid {
    pub(crate) fn new(image: &SceneLinearImage) -> Self {
        let (cell, w, h) = grid_size(image.width, image.height);
        let mut sum = vec![[0f32; 4]; (w * h) as usize];
        for (y, row) in image
            .data
            .chunks_exact(image.width as usize * 3)
            .enumerate()
        {
            let line = &mut sum[(y as u32 / cell * w) as usize..];
            for (at, block) in line.iter_mut().zip(row.chunks(cell as usize * 3)) {
                for rgb in block.as_chunks::<3>().0 {
                    for c in 0..3 {
                        at[c] += rgb[c];
                    }
                    at[3] += 1.;
                }
            }
        }
        Self(
            sum.iter()
                .map(|s| [s[0] / s[3], s[1] / s[3], s[2] / s[3]])
                .collect(),
        )
    }
}

/// One channel image. Each [`Plane::rows`] call also transposes it, so two
/// calls process both axes.
#[derive(Clone)]
struct Plane {
    width: usize,
    height: usize,
    v: Vec<f32>,
}
impl Plane {
    /// Rebuilds each row to `width` samples with `f(row, x)`, where `row`
    /// replicates its edge samples, and returns the transpose.
    fn rows(&self, width: usize, f: impl Fn(&dyn Fn(isize) -> f32, usize) -> f32) -> Self {
        let mut v = vec![0.; width * self.height];
        for y in 0..self.height {
            let line = &self.v[y * self.width..(y + 1) * self.width];
            let row = |x: isize| line[x.clamp(0, self.width as isize - 1) as usize];
            for x in 0..width {
                v[x * self.height + y] = f(&row, x);
            }
        }
        Self {
            width: self.height,
            height: width,
            v,
        }
    }
    /// SPP `Downscale2x2`: the mean of each 2x2 block.
    fn half(&self) -> Self {
        let half =
            |r: &dyn Fn(isize) -> f32, x: usize| 0.5 * (r(2 * x as isize) + r(2 * x as isize + 1));
        self.rows(self.width.div_ceil(2), half)
            .rows(self.height.div_ceil(2), half)
    }
    /// SPP `SmoothDoubleBlend` interpolation: a [1 2 1] smooth, then a cubic
    /// 2x upsample, cut to `width` x `height`.
    fn double(&self, width: usize, height: usize) -> Self {
        let smooth = |r: &dyn Fn(isize) -> f32, x: usize| {
            let x = x as isize;
            0.25 * (r(x - 1) + 2. * r(x) + r(x + 1))
        };
        let up = |r: &dyn Fn(isize) -> f32, x: usize| {
            let (p, d) = ((x / 2) as isize, if x.is_multiple_of(2) { -1 } else { 1 });
            (25. * r(p) + 9. * r(p + d) - r(p - d) - r(p + 2 * d)) / 32.
        };
        self.rows(self.width, smooth)
            .rows(self.height, smooth)
            .rows(width, up)
            .rows(height, up)
    }
    /// SPP `PyramidFilter`: a 2x2 mip chain, blended from the coarsest level
    /// back to full size with weight `0.9 * 0.65^i` on the finer level.
    fn pyramid(&self) -> Self {
        let mut levels = vec![self.clone()];
        while let Some(last) = levels.last().filter(|l| l.width >= 3 && l.height >= 3) {
            levels.push(last.half());
        }
        let mut blended = levels.pop().unwrap();
        for (i, level) in levels.iter().rev().enumerate() {
            let beta = 0.9 * 0.65f32.powi(i as i32);
            let up = blended.double(level.width, level.height);
            blended = Self {
                v: up
                    .v
                    .iter()
                    .zip(&level.v)
                    .map(|(u, p)| (1. - beta) * u + beta * p)
                    .collect(),
                ..up
            };
        }
        blended
    }
    fn mean(&self) -> f32 {
        (self.v.iter().map(|&v| f64::from(v)).sum::<f64>() / self.v.len() as f64) as f32
    }
}

/// SPP's log luminance: `ln(Y + 30)` on 12-bit counts, clamped as its 15-bit
/// table is.
pub(crate) fn log_luma(y: f32) -> f32 {
    (y.clamp(0., 32767.) + 30.).ln()
}

/// The GPU buffer of the map: element 0 holds the target shift, then each cell
/// holds the local log mean `b` and the contrast scale `r`, so that
/// `x = r (l - b) - (l - shift)` for a pixel of log luminance `l`.
/// `weights` turn the prepared RGB into Sigma's counts: `w . rgb + w0`.
pub(crate) fn map(grid: &Grid, width: u32, height: u32, weights: [f32; 4]) -> Vec<[f32; 2]> {
    let (_, w, h) = grid_size(width, height);
    let luma = |c: &[f32; 3]| (0..3).map(|i| weights[i] * c[i]).sum::<f32>() + weights[3];
    let l = Plane {
        width: w as usize,
        height: h as usize,
        v: grid.0.iter().map(|c| log_luma(luma(c))).collect(),
    };
    let b = l.pyramid();
    // Halfway from the mean to 18% gray of 4096, then half a natural stop up.
    let shift = 0.5 * (l.mean() + 737.28f32.ln()) + 0.5;
    let variance = Plane {
        v: l.v
            .iter()
            .zip(&b.v)
            .map(|(l, b)| (l - b).powi(2).min(32.))
            .collect(),
        ..l.clone()
    }
    .pyramid();
    let sd: Vec<f32> = variance
        .v
        .iter()
        .map(|v| (v.max(0.) + 1. / 16.).sqrt())
        .collect();
    let scale = Plane { v: sd.clone(), ..l }.mean().sqrt();
    std::iter::once([shift, 0.])
        .chain(b.v.iter().zip(&sd).map(|(&b, sd)| [b, scale / sd]))
        .collect()
}

/// The gain's `k` and `1 / (|k| + 1/16)^0.25` for a slider value.
pub(crate) fn curve(slider: f32) -> (f32, f32) {
    let k = 1.33 * slider;
    (k, (k.abs() + 1. / 16.).powf(-0.25))
}
