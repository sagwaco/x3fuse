//! The spektrafilm film/paper model, ported from spektrafilm-rs v0.1.2
//! (`9dd59b0`, GPL-3.0-only) into this crate's single-device, tiled pass list.
//! See ../../NOTICE for attribution and ../../assets/PROVENANCE.md for hashes.
//!
//! CPU side: profiles, the per-film spectral upsampling LUT, the enlarger
//! solve, and every scalar the shader stages need. GPU side: `render.wgsl`.
pub mod data;
pub mod enlarger;
pub mod profile;
pub mod spectra;

use crate::{recipe::FilmSettings, RenderError};
use data::N_WL;

/// Fixed 35 mm frame; spektrafilm's spatial parameters are physical (µm).
const FILM_FORMAT_MM: f64 = 35.0;
/// spektrafilm `GrainParams` defaults.
const GRAIN_PARTICLE_AREA_UM2: f64 = 0.2;
const GRAIN_PARTICLE_SCALE: [f64; 3] = [1.6, 1.6, 3.2];
const GRAIN_DENSITY_MIN: [f64; 3] = [0.03, 0.03, 0.03];
const GRAIN_UNIFORMITY: [f64; 3] = [0.97, 0.99, 0.97];
pub const GRAIN_BLUR_PX: f32 = 0.65;
const GRAIN_SUB_LAYERS: u32 = 1;
/// spektrafilm `HalationParams` defaults.
const SCATTER_CORE_UM: [f64; 3] = [2.2, 2.0, 1.6];
const SCATTER_TAIL_UM: [f64; 3] = [9.3, 9.7, 9.1];
const SCATTER_TAIL_WEIGHT: [f64; 3] = [0.78, 0.65, 0.67];
const HALATION_STRENGTH: [f64; 3] = [0.05, 0.015, 0.0];
const HALATION_FIRST_SIGMA_UM: f64 = 65.0;
pub const HALATION_BOUNCES: usize = 3;
const HALATION_BOUNCE_DECAY: f64 = 0.5;
/// spektrafilm `DirCouplersParams` defaults. `diffusion_size_um` is driven by
/// the recipe; the exponential tail sub-stage is not ported.
const DIR_INHIBITION: f64 = 1.0;
const DIR_GAMMA_NEGATIVE: ([f64; 3], [f64; 2], [f64; 2], [f64; 2]) = (
    [0.336, 0.319, 0.273],
    [0.353, 0.302],
    [0.154, 0.353],
    [0.168, 0.226],
);
const DIR_GAMMA_POSITIVE: ([f64; 3], [f64; 2], [f64; 2], [f64; 2]) =
    ([0.12, 0.08, 0.06], [0.12, 0.06], [0.08, 0.06], [0.06, 0.06]);
/// The recipe's halation radius is a fraction of the long edge; this default
/// reproduces spektrafilm's `halation_first_sigma_um` exactly.
const HALATION_RADIUS_DEFAULT: f64 = 0.0015;
/// `tune_m`/`tune_y` span ±20 dichroic CC units.
const TUNE_RANGE_CC: f64 = 20.0;

/// Curve samples (`log_exposure` length) and wavelength count are fixed by the
/// bundled profiles; the shader indexes the packed table with these.
pub const CURVE_SAMPLES: usize = 256;

/// Offsets, in f32 elements, into the packed `spectral` storage buffer. Kept in
/// sync with the `SP_*` constants at the top of `render.wgsl`.
mod offset {
    use super::{CURVE_SAMPLES as K, N_WL};
    pub const FILM_LOG_EXP: usize = 0;
    pub const FILM_CURVES: usize = FILM_LOG_EXP + K;
    pub const FILM_CURVES_0: usize = FILM_CURVES + K * 3;
    pub const FILM_DYE: usize = FILM_CURVES_0 + K * 3;
    pub const FILM_BASE: usize = FILM_DYE + N_WL * 3;
    pub const PRINT_ILLUM: usize = FILM_BASE + N_WL;
    pub const PAPER_SENS: usize = PRINT_ILLUM + N_WL;
    pub const PAPER_LOG_EXP: usize = PAPER_SENS + N_WL * 3;
    pub const PAPER_CURVES: usize = PAPER_LOG_EXP + K;
    pub const SCAN_DYE: usize = PAPER_CURVES + K * 3;
    pub const SCAN_BASE: usize = SCAN_DYE + N_WL * 3;
    pub const SCAN_ILLUM_CMF: usize = SCAN_BASE + N_WL;
    pub const TOTAL: usize = SCAN_ILLUM_CMF + N_WL * 3;
}
/// Padded so the storage binding keeps a 16-byte multiple.
pub const SPECTRAL_FLOATS: usize = offset::TOTAL.next_multiple_of(4);

/// Numpy `np.add.reduce` pairwise summation over a wavelength axis.
pub(crate) fn pairwise_sum(xs: &[f64]) -> f64 {
    match xs.len() {
        0 => 0.,
        1 => xs[0],
        2 => xs[0] + xs[1],
        n => pairwise_sum(&xs[..n / 2]) + pairwise_sum(&xs[n / 2..]),
    }
}

/// The spectral upsampling LUT for one film stock. Roughly 9 M multiply-adds
/// plus an input-gamut resample, and it depends on nothing but the film, so it
/// survives paper, trim and exposure changes.
pub struct FilmLut {
    film: u32,
    /// Grid values in f64 for the mid-gray solve.
    pub data: Vec<f64>,
    /// The same grid the shader samples.
    pub uploadable: Vec<f32>,
    /// `RGB -> CAT16-adapted XYZ` in the film's reference illuminant.
    pub rgb_to_adapted_xyz: [[f64; 3]; 3],
}
impl FilmLut {
    pub fn matches(&self, settings: &FilmSettings) -> bool {
        self.film == settings.film
    }
    pub fn build(film_index: u32) -> Result<Self, RenderError> {
        let film = profile::load(film_index as usize)?;
        let (reference, white) = data::reference_illuminant(&film.info.reference_illuminant);
        let lut = spectra::tc_lut(
            &spectra::spectra_table()?,
            &film.sensitivity(),
            &film.data.hanatos2025_adaptation_window_params,
            reference,
        );
        let sum = white[0] + white[1] + white[2];
        let data = spectra::compress_input_gamut(&lut, [white[0] / sum, white[1] / sum]);
        Ok(Self {
            film: film_index,
            uploadable: data.iter().map(|&v| v as f32).collect(),
            data,
            rgb_to_adapted_xyz: data::mat_mul(
                &data::cat16(data::srgb_white(), white),
                &data::SRGB_TO_XYZ,
            ),
        })
    }
}

/// Everything else the film stages need that depends only on the recipe's film
/// settings, not on the image or the tile.
pub struct FilmPair {
    key: Key,
    pub spectral: Vec<f32>,
    /// Per-channel `halation_strength * halation_amount`.
    pub halation_a_tot: [f32; 3],
    pub dir_matrix: [[f32; 3]; 3],
    pub dir_density_max: [f32; 3],
    pub dir_positive: bool,
    pub grain_density_max: [f32; 3],
    pub rgb_to_adapted_xyz: [[f32; 3]; 3],
    pub scan_xyz_to_rgb: [[f32; 3]; 3],
    pub scan_normalization: f32,
    pub print_normalization: f32,
}

/// Identifies a prepared pair. Floats are compared by bits so a cached pair is
/// only reused for the exact same settings.
#[derive(PartialEq, Eq, Clone, Copy)]
pub struct Key(u32, u32, bool, u32, u32, u32, u32, u32);
impl Key {
    /// Every setting [`FilmPair::build`] reads. Anything consumed there and
    /// missing here silently serves a stale pair;
    /// `prepared_pairs_are_keyed_on_every_setting_they_read` guards that.
    /// `ev_film` is deliberately absent: it scales the scene before the front
    /// pass and changes none of the prepared tables, so dragging the film
    /// exposure slider reuses the cached pair.
    fn new(s: &FilmSettings) -> Self {
        Self(
            s.film,
            s.paper,
            s.negative,
            s.tune_m.to_bits(),
            s.tune_y.to_bits(),
            s.ev_paper.unwrap_or(f32::NAN).to_bits(),
            s.gamma_film.to_bits(),
            s.couplers.to_bits(),
        )
    }
}

fn mat_f32(m: &[[f64; 3]; 3]) -> [[f32; 3]; 3] {
    std::array::from_fn(|i| std::array::from_fn(|j| m[i][j] as f32))
}

impl FilmPair {
    pub fn matches(&self, settings: &FilmSettings) -> bool {
        self.key == Key::new(settings)
    }

    /// Every prepared value, flattened, so a cache-key test can tell whether
    /// two settings actually produce different tables. Extend this whenever a
    /// field is added to the struct.
    #[cfg(test)]
    pub fn fingerprint(&self) -> Vec<f32> {
        let mut out = self.spectral.clone();
        out.extend(self.halation_a_tot);
        out.extend(self.dir_matrix.iter().flatten());
        out.extend(self.dir_density_max);
        out.push(f32::from(self.dir_positive));
        out.extend(self.grain_density_max);
        out.extend(self.rgb_to_adapted_xyz.iter().flatten());
        out.extend(self.scan_xyz_to_rgb.iter().flatten());
        out.push(self.scan_normalization);
        out.push(self.print_normalization);
        out
    }

    /// Solve the enlarger and pack every table for one film/paper pair. Cheap
    /// next to [`FilmLut::build`], which supplies `lut`.
    pub fn build(settings: &FilmSettings, lut: &FilmLut) -> Result<Self, RenderError> {
        let key = Key::new(settings);
        let film = profile::load(settings.film as usize)?;
        let paper = profile::load(20 + settings.paper as usize)?;
        let scan = if settings.negative { &film } else { &paper };
        let rgb_to_adapted_xyz = lut.rgb_to_adapted_xyz;

        // ── Enlarger: per-stock neutral filtration plus the user's trim ────
        let neutral = enlarger::neutral_filters(&paper.info.stock, &film.info.stock)?;
        let print_illuminant = enlarger::filtered_illuminant([
            neutral[0],
            neutral[1] + settings.tune_m as f64 * TUNE_RANGE_CC,
            neutral[2] + settings.tune_y as f64 * TUNE_RANGE_CC,
        ]);
        let paper_sensitivity = paper.sensitivity();

        // ── Print exposure normalisation around a mid-gray card ────────────
        let midgray_raw = |scale: f64| -> [f64; 3] {
            let g = 0.184 * scale;
            let xyz: [f64; 3] =
                std::array::from_fn(|i| (0..3).map(|j| rgb_to_adapted_xyz[i][j] * g).sum());
            let b = xyz[0] + xyz[1] + xyz[2];
            if b <= 1e-10 {
                return [0.; 3];
            }
            let (tx, ty) = data::xy_to_tc(xyz[0] / b, xyz[1] / b);
            spectra::sample(&lut.data, tx, ty).map(|v| v * b)
        };
        let gamma_film = settings.gamma_film as f64;
        // Normalize the enlarger against an uncompensated mid-gray card, i.e.
        // spektrafilm's `normalize_print_exposure` without its
        // `print_exposure_compensation`. With compensation on, the enlarger
        // re-solves at the compensated film exposure and cancels `ev_film`
        // back out, so the slider would only move where the scene sits on the
        // H&D curve: no brightness change pulling up, lifted blacks pulling
        // down. `ev_film` has to expose the film and let the print follow.
        let normalized = enlarger::exposure_factor(
            &enlarger::midgray_density(midgray_raw(1.), &film, gamma_film),
            &print_illuminant,
            &paper_sensitivity,
        );
        let print_normalization = normalized * 2f64.powf(settings.ev_paper.unwrap_or(0.) as f64);

        // ── Scan: density -> XYZ under the viewing illuminant -> linear sRGB ─
        // Every bundled profile views under D50 (spektrafilm falls back to D50
        // for the print-film stocks' "K75P" name).
        let viewing = &data::ILLUMINANT_D50_F64[..];
        let n_scan = scan.data.channel_density.len().min(N_WL);
        let scan_normalization: f64 = (0..n_scan).map(|i| viewing[i] * data::CMF_Y_F64[i]).sum();
        let scan_xyz_to_rgb = data::mat_mul(
            &data::XYZ_TO_SRGB,
            &data::cat02(data::illuminant_white(viewing), data::srgb_white()),
        );

        // ── DIR couplers ───────────────────────────────────────────────────
        let dir_positive = film.is_positive();
        let gammas = if dir_positive {
            DIR_GAMMA_POSITIVE
        } else {
            DIR_GAMMA_NEGATIVE
        };
        let (same, r_gb, g_rb, b_rg) = gammas;
        let amount = settings.couplers as f64;
        let mut dir = [[0.0f64; 3]; 3];
        for c in 0..3 {
            dir[c][c] = same[c] * DIR_INHIBITION;
        }
        dir[0][1] = r_gb[0] * DIR_INHIBITION;
        dir[0][2] = r_gb[1] * DIR_INHIBITION;
        dir[1][0] = g_rb[0] * DIR_INHIBITION;
        dir[1][2] = g_rb[1] * DIR_INHIBITION;
        dir[2][0] = b_rg[0] * DIR_INHIBITION;
        dir[2][1] = b_rg[1] * DIR_INHIBITION;
        for row in &mut dir {
            for v in row.iter_mut() {
                *v *= amount;
            }
        }

        let film_curves = film.normalized_curves();
        let density_max: [f64; 3] = std::array::from_fn(|c| {
            film_curves
                .iter()
                .map(|r| r[c])
                .filter(|v| v.is_finite())
                .fold(f64::NEG_INFINITY, f64::max)
        });
        let curves_0 = curves_before_dir(
            &film_curves,
            &film.data.log_exposure,
            &dir,
            dir_positive,
            density_max,
        );
        let paper_curves = paper.model_curves()?;

        // ── Pack the spectral tables the shader samples ────────────────────
        let mut spectral = vec![0.0f32; SPECTRAL_FLOATS];
        let put = |dst: &mut [f32], at: usize, src: &[f64]| {
            for (i, v) in src.iter().enumerate() {
                dst[at + i] = *v as f32;
            }
        };
        let put3 = |dst: &mut [f32], at: usize, src: &[[f64; 3]]| {
            for (i, row) in src.iter().enumerate() {
                for c in 0..3 {
                    dst[at + i * 3 + c] = row[c] as f32;
                }
            }
        };
        put(&mut spectral, offset::FILM_LOG_EXP, &film.data.log_exposure);
        put3(&mut spectral, offset::FILM_CURVES, &film_curves);
        put3(&mut spectral, offset::FILM_CURVES_0, &curves_0);
        put(
            &mut spectral,
            offset::PAPER_LOG_EXP,
            &paper.data.log_exposure,
        );
        put3(&mut spectral, offset::PAPER_CURVES, &paper_curves);
        put3(&mut spectral, offset::PAPER_SENS, &paper_sensitivity);
        // A NaN dye or base density means "no measurement here": spektrafilm's
        // `density_to_light` drops that wavelength, which we do by zeroing both
        // the densities and the illuminant weight rather than in the shader
        // (fast-math GPU backends optimise `x != x` away).
        write_spectral_light(
            &mut spectral,
            offset::FILM_DYE,
            offset::FILM_BASE,
            offset::PRINT_ILLUM,
            &film,
            std::slice::from_ref(&print_illuminant),
        );
        let scan_weights: Vec<Vec<f64>> = (0..3)
            .map(|c| {
                let cmf = [&data::CMF_X_F64, &data::CMF_Y_F64, &data::CMF_Z_F64][c];
                (0..N_WL).map(|i| viewing[i] * cmf[i]).collect()
            })
            .collect();
        write_spectral_light(
            &mut spectral,
            offset::SCAN_DYE,
            offset::SCAN_BASE,
            offset::SCAN_ILLUM_CMF,
            scan,
            &scan_weights,
        );

        Ok(Self {
            key,
            spectral,
            halation_a_tot: HALATION_STRENGTH.map(|v| v as f32),
            dir_matrix: mat_f32(&dir),
            dir_density_max: density_max.map(|v| v as f32),
            dir_positive,
            grain_density_max: std::array::from_fn(|c| {
                (density_max[c] + GRAIN_DENSITY_MIN[c]) as f32
            }),
            rgb_to_adapted_xyz: mat_f32(&rgb_to_adapted_xyz),
            scan_xyz_to_rgb: mat_f32(&scan_xyz_to_rgb),
            scan_normalization: scan_normalization as f32,
            print_normalization: print_normalization as f32,
        })
    }
}

/// Write a profile's dye/base densities plus one or more spectral weight
/// vectors, zeroing every wavelength with no measurement.
fn write_spectral_light(
    spectral: &mut [f32],
    dye_at: usize,
    base_at: usize,
    weight_at: usize,
    profile: &profile::Profile,
    weights: &[Vec<f64>],
) {
    for wl in 0..N_WL {
        let dye = profile
            .data
            .channel_density
            .get(wl)
            .copied()
            .unwrap_or([f64::NAN; 3]);
        let base = profile
            .data
            .base_density
            .get(wl)
            .copied()
            .unwrap_or(f64::NAN);
        let usable = base.is_finite() && dye.iter().all(|v| v.is_finite());
        for c in 0..3 {
            spectral[dye_at + wl * 3 + c] = if usable { dye[c] as f32 } else { 0. };
        }
        spectral[base_at + wl] = if usable { base as f32 } else { 0. };
        for (c, weight) in weights.iter().enumerate() {
            spectral[weight_at + wl * weights.len() + c] =
                if usable { weight[wl] as f32 } else { 0. };
        }
    }
}

/// Density curves as they would be without DIR inhibition, re-interpolated on
/// the coupler-shifted exposure axis. Port of spektrafilm
/// `couplers::compute_curves_before_dir`.
fn curves_before_dir(
    curves: &[[f64; 3]],
    log_exposure: &[f64],
    matrix: &[[f64; 3]; 3],
    positive: bool,
    density_max: [f64; 3],
) -> Vec<[f64; 3]> {
    let k = curves.len();
    let silver: Vec<[f64; 3]> = curves
        .iter()
        .map(|row| {
            std::array::from_fn(|c| {
                if positive {
                    density_max[c] - row[c]
                } else {
                    row[c]
                }
            })
        })
        .collect();
    let amount: Vec<[f64; 3]> = silver
        .iter()
        .map(|s| {
            std::array::from_fn(|m| s[0] * matrix[0][m] + s[1] * matrix[1][m] + s[2] * matrix[2][m])
        })
        .collect();
    (0..k)
        .map(|j| {
            std::array::from_fn(|c| {
                // Interpolate the original curve, sampled on a monotonically
                // shifted axis, back onto the unshifted exposure grid.
                let x = |i: usize| log_exposure[i] - amount[i][c];
                let q = log_exposure[j];
                if q <= x(0) {
                    return curves[0][c];
                }
                if q >= x(k - 1) {
                    return curves[k - 1][c];
                }
                let hi = (1..k).find(|&i| x(i) > q).unwrap_or(k - 1);
                let dx = x(hi) - x(hi - 1);
                let f = if dx != 0. { (q - x(hi - 1)) / dx } else { 0. };
                curves[hi - 1][c] + f * (curves[hi][c] - curves[hi - 1][c])
            })
        })
        .collect()
}

/// Per-stage blur sigmas in output pixels, derived from spektrafilm's physical
/// parameters and the **full output frame** (never a tile), so previews, tiles
/// and regions all diffuse identically.
pub struct Spatial {
    pub scatter_core: f32,
    pub scatter_tail: f32,
    pub halation: [f32; HALATION_BOUNCES],
    pub coupler: f32,
}
impl Spatial {
    pub fn new(settings: &FilmSettings, long_edge: f32) -> Self {
        let pixel_um = pixel_size_um(long_edge);
        let px = |um: f64| (um / pixel_um) as f32;
        let halation_scale = settings.halation_radius as f64 / HALATION_RADIUS_DEFAULT;
        let first = HALATION_FIRST_SIGMA_UM * halation_scale;
        Self {
            scatter_core: px(mean(SCATTER_CORE_UM)),
            scatter_tail: px(mean(SCATTER_TAIL_UM)),
            halation: std::array::from_fn(|k| px(first * (k as f64 + 1.).sqrt())),
            // `couplers_radius` is a fraction of the frame, so its µm size
            // divided by the µm pixel pitch collapses to the long edge.
            coupler: px(settings.couplers_radius as f64 * FILM_FORMAT_MM * 1000.),
        }
    }
}
/// spektrafilm's `pixel_size_um`, over the whole 35 mm frame.
fn pixel_size_um(long_edge: f32) -> f64 {
    FILM_FORMAT_MM * 1000. / (long_edge as f64).max(1.)
}
fn mean(v: [f64; 3]) -> f64 {
    (v[0] + v[1] + v[2]) / 3.
}

/// Normalised multi-bounce decay weights, `rho^k` summing to one.
pub fn bounce_weights() -> [f32; HALATION_BOUNCES] {
    let raw: [f64; HALATION_BOUNCES] =
        std::array::from_fn(|k| HALATION_BOUNCE_DECAY.powi(k as i32));
    let sum: f64 = raw.iter().sum();
    raw.map(|v| (v / sum) as f32)
}

/// Grain particles per pixel per channel, already divided by the sub-layer
/// count. `grain_size` scales the particle *area*.
pub fn grain_particles(settings: &FilmSettings, long_edge: f32) -> [f32; 3] {
    let pixel_um = pixel_size_um(long_edge);
    let size = (settings.grain_size as f64).powi(2);
    std::array::from_fn(|c| {
        let area = GRAIN_PARTICLE_AREA_UM2 * GRAIN_PARTICLE_SCALE[c] * size;
        (pixel_um * pixel_um / area / GRAIN_SUB_LAYERS as f64) as f32
    })
}
pub fn grain_constants() -> ([f32; 3], [f32; 3], u32) {
    (
        GRAIN_DENSITY_MIN.map(|v| v as f32),
        GRAIN_UNIFORMITY.map(|v| v as f32),
        GRAIN_SUB_LAYERS,
    )
}
pub fn scatter_tail_weight() -> [f32; 3] {
    SCATTER_TAIL_WEIGHT.map(|v| v as f32)
}
