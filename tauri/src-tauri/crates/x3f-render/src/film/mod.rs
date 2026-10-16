//! The spektrafilm film/paper model, ported from spektrafilm-rs v0.1.2
//! (`9dd59b0`, GPL-3.0-only) into this crate's single-device, tiled pass list.
//! See ../../NOTICE for attribution and ../../assets/PROVENANCE.md for hashes.
//!
//! CPU side: profiles, the per-film spectral upsampling LUT, the enlarger
//! solve, and every scalar the shader stages need. GPU side: `render.wgsl`.
pub mod couplers;
pub mod data;
pub mod enlarger;
pub mod filter;
pub mod gamut;
pub mod grain;
pub mod profile;
pub mod spectra;

use crate::{recipe::FilmSettings, MonochromeFilter, RenderError};
use data::N_WL;

/// Fixed 35 mm frame; spektrafilm's spatial parameters are physical (µm).
const FILM_FORMAT_MM: f64 = 35.0;
/// Roughness clump cell at grain size 1, in µm (X3Fuse extension).
const GRAIN_CLUMP_UM: f64 = 40.0;
/// spektrafilm `HalationParams` defaults. The recipe's per-channel scatter and
/// halation settings default to them.
const SCATTER_CORE_UM: [f64; 3] = [2.2, 2.0, 1.6];
pub(crate) const SCATTER_TAIL_UM: [f64; 3] = [9.3, 9.7, 9.1];
pub(crate) const SCATTER_TAIL_WEIGHT: [f64; 3] = [0.78, 0.65, 0.67];
pub(crate) const HALATION_STRENGTH: [f64; 3] = [0.015, 0.005, 0.0];
pub(crate) const HALATION_FIRST_SIGMA_UM: [f64; 3] = [65.0, 65.0, 65.0];
pub const HALATION_BOUNCES: usize = 3;
const HALATION_BOUNCE_DECAY: f64 = 0.5;
/// The recipe's halation radius is a fraction of the long edge; this default
/// reproduces spektrafilm's `halation_first_sigma_um` exactly.
const HALATION_RADIUS_DEFAULT: f64 = 0.0015;
/// `tune_m`/`tune_y` span ±20 dichroic CC units.
const TUNE_RANGE_CC: f64 = 20.0;
/// spektrafilm `ScannerParams` white and black levels, sRGB-encoded.
const SCAN_WHITE_LEVEL: f64 = 0.98;
const SCAN_BLACK_LEVEL: f64 = 0.01;

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
pub const SPECTRAL_FLOATS: usize =
    (offset::TOTAL.next_multiple_of(4) + grain::MAX_TABLE_FLOATS).next_multiple_of(4);

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
    /// The taking filter folded into the LUT. Only B&W films use one.
    filter: Option<MonochromeFilter>,
    /// A B&W film: one silver layer, loaded as three identical channels.
    pub monochrome: bool,
    /// Grid values in f64 for the mid-gray solve.
    pub data: Vec<f64>,
    /// The same grid the shader samples.
    pub uploadable: Vec<f32>,
    /// `RGB -> CAT16-adapted XYZ` in the film's reference illuminant.
    pub rgb_to_adapted_xyz: [[f64; 3]; 3],
}
impl FilmLut {
    /// `filter` is the recipe's monochrome filter. Colour films ignore it, so
    /// a filter change does not rebuild their LUT.
    pub fn matches(&self, settings: &FilmSettings, filter: Option<MonochromeFilter>) -> bool {
        self.film == settings.film && self.filter == self.effective(filter)
    }
    fn effective(&self, filter: Option<MonochromeFilter>) -> Option<MonochromeFilter> {
        filter.filter(|&f| self.monochrome && filter::has_curve(f))
    }
    pub fn build(film_index: u32, filter: Option<MonochromeFilter>) -> Result<Self, RenderError> {
        let film = profile::load(film_index as usize)?;
        let (reference, white) = data::reference_illuminant(&film.info.reference_illuminant);
        let monochrome = film.is_monochrome();
        let filter = filter.filter(|&f| monochrome && filter::has_curve(f));
        let table = spectra::spectra_table()?;
        let sum = white[0] + white[1] + white[2];
        let white_xy = [white[0] / sum, white[1] / sum];
        let build = |sensitivity: &[[f64; 3]]| {
            let lut = spectra::tc_lut(
                &table,
                sensitivity,
                &film.data.hanatos2025_adaptation_window_params,
                reference,
            );
            // D65 integrated on the same 5 nm observer grid as the irradiance LUT.
            spectra::compress_input_gamut(&lut, [0.3127205251723142, 0.32903068500484106])
        };
        let mut data = build(&film.sensitivity());
        if let Some(transmittance) = filter.and_then(filter::transmittance) {
            let filtered: Vec<[f64; 3]> = film
                .sensitivity()
                .iter()
                .zip(transmittance)
                .map(|(row, t)| row.map(|s| s * t))
                .collect();
            // The filter changes tone, not exposure: a neutral subject exposes
            // the film as without it, like a meter that reads through the
            // filter. spektrafilm leaves the loss to its auto exposure, which
            // this renderer does not run. Match at the LUT's own neutral point,
            // which is where the print exposure is solved.
            let (tx, ty) = data::xy_to_tc(white_xy[0], white_xy[1]);
            let plain = spectra::sample(&data, tx, ty)[0];
            data = build(&filtered);
            let factor = plain / spectra::sample(&data, tx, ty)[0];
            data.iter_mut().for_each(|v| *v *= factor);
        }
        Ok(Self {
            film: film_index,
            filter,
            monochrome,
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
    /// A B&W film; see [`FilmLut::monochrome`].
    pub monochrome: bool,
    pub spectral: Vec<f32>,
    pub dir_matrix: [[f32; 3]; 3],
    pub dir_density_max: [f32; 3],
    pub dir_receiver_reference: [f32; 3],
    pub dir_positive: bool,
    pub grain: grain::Grain,
    pub grain_offset: usize,
    pub rgb_to_adapted_xyz: [[f32; 3]; 3],
    pub scan_xyz_to_rgb: [[f32; 3]; 3],
    pub scan_normalization: f32,
    pub print_normalization: f32,
    /// Scanner white and black correction `(m, q)` on scan luminance; None
    /// for a negative scanned directly.
    pub scan_remap: Option<[f32; 2]>,
    /// Print and slide film exposures that keep mid-gray at 0.184 after the
    /// remap. `print_normalization` stays spektrafilm's own.
    pub print_exposure_correction: f32,
    pub film_exposure_correction: f32,
}

/// Identifies a prepared pair. Floats are compared by bits so a cached pair is
/// only reused for the exact same settings.
#[derive(PartialEq, Eq, Clone, Copy)]
pub struct Key(
    u32,
    u32,
    bool,
    u32,
    u32,
    u32,
    u32,
    u32,
    u32,
    Option<[u32; 3]>,
);
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
            s.gamma_paper.to_bits(),
            s.couplers.to_bits(),
            s.grain_params
                .as_ref()
                .map(|p| p.rms_granularity.map(f32::to_bits)),
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
        out.extend(self.dir_matrix.iter().flatten());
        out.extend(self.dir_density_max);
        out.extend(self.dir_receiver_reference);
        out.push(f32::from(self.dir_positive));
        out.push(f32::from(self.monochrome));
        out.extend(self.grain.preset.uniformity.map(|v| v as f32));
        out.extend(self.grain.preset.floor.map(|v| v as f32));
        out.extend(self.rgb_to_adapted_xyz.iter().flatten());
        out.extend(self.scan_xyz_to_rgb.iter().flatten());
        out.push(self.scan_normalization);
        out.push(self.print_normalization);
        out.extend(self.scan_remap.into_iter().flatten());
        out.push(self.print_exposure_correction);
        out.push(self.film_exposure_correction);
        out
    }

    /// Solve the enlarger and pack every table for one film/paper pair. Cheap
    /// next to [`FilmLut::build`], which supplies `lut`.
    pub fn build(settings: &FilmSettings, lut: &FilmLut) -> Result<Self, RenderError> {
        let key = Key::new(settings);
        let mut film = profile::load(settings.film as usize)?;
        let mut paper = profile::load(profile::FILM_COUNT + settings.paper as usize)?;
        film.apply_gamma(settings.gamma_film as f64)?;
        paper.apply_gamma(settings.gamma_paper as f64)?;
        let grain = grain::Grain::build_with_params(&film, settings.grain_params.as_ref())?;
        let scan = if settings.negative { &film } else { &paper };
        let rgb_to_adapted_xyz = lut.rgb_to_adapted_xyz;

        // ── Enlarger: per-stock neutral filtration plus the user's trim ────
        // A B&W negative has the same density at every wavelength, so the
        // print exposure normalisation below cancels any filtration. Skip it.
        let monochrome = lut.monochrome;
        let print_illuminant = if monochrome {
            enlarger::filtered_illuminant([0.; 3])
        } else {
            let neutral = enlarger::neutral_filters(&paper.info.stock, &film.info.stock)?;
            enlarger::filtered_illuminant([
                neutral[0],
                neutral[1] + settings.tune_m as f64 * TUNE_RANGE_CC,
                neutral[2] + settings.tune_y as f64 * TUNE_RANGE_CC,
            ])
        };
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
        // Normalize the enlarger against an uncompensated mid-gray card, i.e.
        // spektrafilm's `normalize_print_exposure` without its
        // `print_exposure_compensation`. With compensation on, the enlarger
        // re-solves at the compensated film exposure and cancels `ev_film`
        // back out, so the slider would only move where the scene sits on the
        // H&D curve: no brightness change pulling up, lifted blacks pulling
        // down. `ev_film` has to expose the film and let the print follow.
        let normalized = enlarger::exposure_factor(
            &enlarger::midgray_density(midgray_raw(1.), &film, 1.),
            &print_illuminant,
            &paper_sensitivity,
        );
        let print_normalization = normalized * 2f64.powf(settings.ev_paper.unwrap_or(0.) as f64);

        // ── Scan: density -> XYZ under the viewing illuminant -> linear sRGB ─
        let viewing = data::reference_illuminant(&scan.info.viewing_illuminant).0;
        let n_scan = scan.data.channel_density.len().min(N_WL);
        let scan_normalization: f64 = (0..n_scan).map(|i| viewing[i] * data::CMF_Y_F64[i]).sum();
        let scan_xyz_to_rgb = data::mat_mul(
            &data::XYZ_TO_SRGB,
            &data::cat02(data::illuminant_white(viewing), data::srgb_white()),
        );

        // ── DIR couplers ───────────────────────────────────────────────────
        let dir_positive = film.is_positive();
        let dir_unit = couplers::matrix(&film);
        let dir = dir_unit.map(|row| row.map(|value| value * settings.couplers as f64));

        let film_curves = film.normalized_curves();
        let density_max: [f64; 3] = std::array::from_fn(|c| {
            film_curves
                .iter()
                .map(|r| r[c])
                .filter(|v| v.is_finite())
                .fold(f64::NEG_INFINITY, f64::max)
        });
        let dir_receiver_reference = couplers::receiver_reference(density_max, &dir_unit);
        let curves_0 = curves_before_dir(
            &film_curves,
            &film.data.log_exposure,
            &dir,
            dir_positive,
            density_max,
            dir_receiver_reference,
        );
        let paper_curves = paper.model_curves()?;

        // ── Scanner white and black correction (spektrafilm `color_reference`)
        // A scan maps the whitest and blackest densities the print (or slide)
        // can hold to the scanner's levels, then corrects the exposure so
        // mid-gray still lands on 0.184. References come from the same tables
        // the shader uses, so they match this renderer's print exactly.
        let light = |p: &profile::Profile, cmy: [f64; 3], wl: usize| -> f64 {
            let dye = p
                .data
                .channel_density
                .get(wl)
                .copied()
                .unwrap_or([f64::NAN; 3]);
            let base = p.data.base_density.get(wl).copied().unwrap_or(f64::NAN);
            let d = cmy[0] * dye[0] + cmy[1] * dye[1] + cmy[2] * dye[2] + base;
            if d.is_finite() {
                10f64.powf(-d)
            } else {
                0.
            }
        };
        let scan_y = |cmy: [f64; 3]| -> f64 {
            (0..N_WL)
                .map(|wl| light(scan, cmy, wl) * viewing[wl] * data::CMF_Y_F64[wl])
                .sum::<f64>()
                / scan_normalization
        };
        let remap = |y_white: f64, y_black: f64| {
            let (white, black) = (srgb_decode(SCAN_WHITE_LEVEL), srgb_decode(SCAN_BLACK_LEVEL));
            let m = (white - black) / (y_white - y_black + 1e-10);
            let q = black - m * y_black;
            (m, q, (0.184 - q) / m)
        };
        // Log exposure that develops a neutral of total density `density`.
        let exposure = |p: &profile::Profile, curves: &[[f64; 3]], density: f64, rising: bool| {
            let average: Vec<f64> = curves.iter().map(|row| finite_mean(row)).collect();
            let above_base = density - finite_mean(&p.data.base_density);
            if rising {
                interp(above_base, &average, &p.data.log_exposure)
            } else {
                let falling: Vec<f64> = average.iter().map(|d| -d).collect();
                interp(-above_base, &falling, &p.data.log_exposure)
            }
        };
        let midgray = -(0.184f64.log10());
        let (scan_remap, print_exposure_correction, film_exposure_correction) =
            if !settings.negative {
                // Print: the film's clearest and densest references through the
                // enlarger, developed on the paper at its own contrast.
                let develop = |cmy_film: [f64; 3]| -> [f64; 3] {
                    std::array::from_fn(|c| {
                        let raw: f64 = (0..N_WL)
                            .map(|wl| {
                                light(&film, cmy_film, wl)
                                    * print_illuminant[wl]
                                    * paper_sensitivity.get(wl).map_or(0., |s| s[c])
                            })
                            .sum();
                        let log_raw = ((raw * print_normalization).max(0.) + 1e-10).log10();
                        let column: Vec<f64> = paper_curves.iter().map(|row| row[c]).collect();
                        interp(log_raw, &paper.data.log_exposure, &column)
                    })
                };
                let y_black = scan_y(develop(grain.preset.floor.map(|v| -v)));
                let y_white = scan_y(develop(density_max));
                let (m, q, corrected) = remap(y_white, y_black);
                let shift = exposure(&paper, &paper_curves, -corrected.log10(), true)
                    - exposure(&paper, &paper_curves, midgray, true);
                (Some([m as f32, q as f32]), 10f64.powf(shift) as f32, 1.)
            } else if film.is_positive() {
                // Slide scanned directly: clear film is white, densest is black.
                let (m, q, corrected) = remap(scan_y([0.; 3]), scan_y(density_max));
                let shift = exposure(&film, &film_curves, -corrected.log10(), false)
                    - exposure(&film, &film_curves, midgray, false);
                (Some([m as f32, q as f32]), 1., 10f64.powf(shift) as f32)
            } else {
                // spektrafilm does not correct a negative scanned directly.
                (None, 1., 1.)
            };

        // ── Pack the spectral tables the shader samples ────────────────────
        let mut spectral = vec![0.0f32; offset::TOTAL.next_multiple_of(4)];
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

        let grain_offset = grain.append_to(&mut spectral);
        spectral.resize(SPECTRAL_FLOATS, 0.);
        Ok(Self {
            key,
            monochrome,
            spectral,
            // One silver layer takes the first channel's value, as
            // spektrafilm's `match_channels` does.
            dir_matrix: mat_f32(&dir),
            dir_density_max: density_max.map(|v| v as f32),
            dir_receiver_reference: dir_receiver_reference.map(|v| v as f32),
            dir_positive,
            grain,
            grain_offset,
            rgb_to_adapted_xyz: mat_f32(&rgb_to_adapted_xyz),
            scan_xyz_to_rgb: mat_f32(&scan_xyz_to_rgb),
            scan_normalization: scan_normalization as f32,
            print_normalization: print_normalization as f32,
            scan_remap,
            print_exposure_correction,
            film_exposure_correction,
        })
    }
}

fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn finite_mean(values: &[f64]) -> f64 {
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    finite.iter().sum::<f64>() / finite.len().max(1) as f64
}

/// Numpy `np.interp`: `xp` ascending, clamped to the end values.
fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    let n = xp.len().min(fp.len());
    if n == 0 {
        return f64::NAN;
    }
    if x <= xp[0] {
        return fp[0];
    }
    if x >= xp[n - 1] {
        return fp[n - 1];
    }
    let hi = xp[..n].partition_point(|&v| v <= x).clamp(1, n - 1);
    let dx = xp[hi] - xp[hi - 1];
    let f = if dx > 0. { (x - xp[hi - 1]) / dx } else { 0. };
    fp[hi - 1] + f * (fp[hi] - fp[hi - 1])
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
    receiver_reference: [f64; 3],
) -> Vec<[f64; 3]> {
    let k = curves.len();
    let amount: Vec<[f64; 3]> = curves
        .iter()
        .map(|row| couplers::correction(*row, density_max, matrix, positive, receiver_reference))
        .collect();
    // Strong chemistry can fold the axis. Keep numpy.interp's previous-index
    // search so each query selects the same branch as the reference.
    fn interval(q: f64, x: &[f64], guess: isize) -> isize {
        let n = x.len();
        if q > x[n - 1] {
            return n as isize;
        }
        if q < x[0] {
            return -1;
        }
        if n <= 4 {
            return (1..n).find(|&i| q < x[i]).unwrap_or(n) as isize - 1;
        }
        let guess = guess.clamp(1, n as isize - 3) as usize;
        let (mut low, mut high) = (0, n);
        if q < x[guess] {
            if q >= x[guess - 1] {
                return guess as isize - 1;
            }
            high = guess - 1;
            if guess > 8 && q >= x[guess - 8] {
                low = guess - 8;
            }
        } else {
            if q < x[guess + 1] {
                return guess as isize;
            }
            if q < x[guess + 2] {
                return guess as isize + 1;
            }
            low = guess + 2;
            if guess + 9 < n && q < x[guess + 8] {
                high = guess + 8;
            }
        }
        while low < high {
            let mid = low + (high - low) / 2;
            if q >= x[mid] {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low as isize - 1
    }
    let mut out = vec![[0.; 3]; k];
    for c in 0..3 {
        let axis: Vec<f64> = (0..k).map(|i| log_exposure[i] - amount[i][c]).collect();
        let mut guess = 0;
        for (j, &q) in log_exposure.iter().enumerate() {
            guess = interval(q, &axis, guess);
            out[j][c] = if guess < 0 {
                curves[0][c]
            } else if guess as usize >= k - 1 {
                curves[k - 1][c]
            } else {
                let lo = guess as usize;
                if q == axis[lo] {
                    curves[lo][c]
                } else {
                    let slope = (curves[lo + 1][c] - curves[lo][c]) / (axis[lo + 1] - axis[lo]);
                    slope * (q - axis[lo]) + curves[lo][c]
                }
            };
        }
    }
    out
}

/// Per-channel constants for a film: B&W films repeat the first channel.
///
/// B&W film uses the first emulsion channel for all three output channels.
pub fn channels<T: Copy>(values: [T; 3], monochrome: bool) -> [T; 3] {
    if monochrome {
        [values[0]; 3]
    } else {
        values
    }
}

/// Per-stage blur sigmas in output pixels, derived from spektrafilm's physical
/// parameters and the **full output frame** (never a tile), so previews, tiles
/// and regions all diffuse identically. Scatter and halation have a sigma per
/// channel.
pub struct Spatial {
    pub scatter_core: [f32; 3],
    pub scatter_tail: [f32; 3],
    pub halation: [[f32; 3]; HALATION_BOUNCES],
    pub scatter_amount: f32,
    pub coupler: f32,
    pub coupler_tail: f32,
}
impl Spatial {
    /// A B&W film takes the first channel's sigma for all three, so its
    /// identical channels stay identical.
    pub fn new(settings: &FilmSettings, long_edge: f32, monochrome: bool) -> Self {
        let pixel_um = pixel_size_um(long_edge);
        let px = |um: f64| (um / pixel_um) as f32;
        let rgb = |um: [f64; 3]| channels(um, monochrome).map(px);
        let native = settings.halation_params.as_ref();
        let scatter = native.map_or(settings.scatter_size_rgb.map(f64::from), |p| {
            SCATTER_TAIL_UM.map(|v| v * p.scatter_spatial_scale as f64)
        });
        let scatter_amount = native.map_or(1., |p| p.scatter_amount);
        let core = native.map_or_else(
            || std::array::from_fn(|c| scatter[c] * SCATTER_CORE_UM[c] / SCATTER_TAIL_UM[c]),
            |p| SCATTER_CORE_UM.map(|v| v * p.scatter_spatial_scale as f64),
        );
        let halation_scale = settings.halation_radius as f64 / HALATION_RADIUS_DEFAULT;
        // With no halation light to add, the bounces change nothing; zero
        // sigmas skip them and their tile margin.
        let halates = native.map_or_else(
            || {
                settings.halation_strength > 0.
                    && widest(channels(settings.halation_strength_rgb, monochrome)) > 0.
            },
            |p| p.halation_amount > 0.,
        );
        let first = native
            .map_or(settings.halation_size_rgb.map(f64::from), |_| {
                halation_preset(settings.film).0
            })
            .map(|um| {
                if halates {
                    um * native.map_or(halation_scale, |p| p.halation_spatial_scale as f64)
                } else {
                    0.
                }
            });
        Self {
            // The scatter size sets the tail; the core keeps its ratio to it.
            scatter_core: if scatter_amount > 0. {
                rgb(core)
            } else {
                [0.; 3]
            },
            scatter_tail: if scatter_amount > 0. {
                rgb(scatter)
            } else {
                [0.; 3]
            },
            scatter_amount,
            halation: std::array::from_fn(|k| rgb(first.map(|um| um * (k as f64 + 1.).sqrt()))),
            // `couplers_radius` is a fraction of the frame, so its µm size
            // divided by the µm pixel pitch collapses to the long edge.
            coupler: px(settings.couplers_radius as f64 * FILM_FORMAT_MM * 1000.),
            coupler_tail: if settings.couplers_radius > 0. {
                px(couplers::TAIL_UM)
            } else {
                0.
            },
        }
    }
}

/// Stock baselines from spektrafilm experimental 28bf883 `params_builder.py`.
pub fn halation_preset(film: u32) -> ([f64; 3], [f64; 3]) {
    static PRESETS: std::sync::LazyLock<Vec<([f64; 3], [f64; 3])>> =
        std::sync::LazyLock::new(|| {
            (0..profile::FILM_COUNT)
                .map(|index| {
                    let film = profile::load(index).expect("Bundled film profile must be valid");
                    let sigma = if film.info.use_kind == "cine" {
                        50.
                    } else {
                        65.
                    };
                    let strength = match film.info.antihalation.as_str() {
                        "strong" => HALATION_STRENGTH,
                        "weak" => [0.08, 0.02, 0.],
                        "no" => [0.30, 0.10, 0.015],
                        _ => [0.05, 0.015, 0.],
                    };
                    ([sigma; 3], strength)
                })
                .collect()
        });
    PRESETS[film as usize]
}
/// spektrafilm's `pixel_size_um`, over the whole 35 mm frame.
fn pixel_size_um(long_edge: f32) -> f64 {
    FILM_FORMAT_MM * 1000. / (long_edge as f64).max(1.)
}
/// The largest of three per-channel sigmas.
pub fn widest(sigma: [f32; 3]) -> f32 {
    sigma[0].max(sigma[1]).max(sigma[2])
}

/// Normalised multi-bounce decay weights, `rho^k` summing to one.
pub fn bounce_weights() -> [f32; HALATION_BOUNCES] {
    let raw: [f64; HALATION_BOUNCES] =
        std::array::from_fn(|k| HALATION_BOUNCE_DECAY.powi(k as i32));
    let sum: f64 = raw.iter().sum();
    raw.map(|v| (v / sum) as f32)
}

/// Roughness clump cell in native pixels. The grain RNG is anchored to native
/// pixels, so the clumps are too.
pub fn grain_clump_cell(settings: &FilmSettings, native_long_edge: f32) -> f32 {
    (GRAIN_CLUMP_UM * settings.grain_size as f64 / pixel_size_um(native_long_edge)).max(1.) as f32
}
