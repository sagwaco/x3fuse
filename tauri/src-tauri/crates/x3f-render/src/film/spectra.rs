//! Hanatos2025 spectral upsampling: the bundled irradiance table and the
//! per-film tc LUT built from it. Ported from spektrafilm-rs
//! `spektrafilm-math/src/npy.rs`, `spektrafilm-core/src/spectral_service.rs`
//! and `spektrafilm-core/src/input_gamut.rs` (v0.1.2 / 9dd59b0, GPL-3.0-only).
use super::data::{self, N_WL};
use crate::{film::pairwise_sum, RenderError};

/// Grid resolution of the bundled `irradiance_xy_tc.npy` table.
pub const LUT_SIZE: usize = 192;

const SPECTRA_NPY: &[u8] = include_bytes!("../../assets/irradiance_xy_tc.npy");

/// Decode the bundled little-endian float16 `(192, 192, 81)` C-order array.
/// Only that one shape/dtype is accepted; anything else means a corrupt asset.
pub fn spectra_table() -> Result<Vec<f32>, RenderError> {
    let bad = || RenderError::Invalid("Invalid bundled spectral upsampling table".into());
    let bytes = SPECTRA_NPY;
    if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
        return Err(bad());
    }
    let (header_len, start) = match bytes[6] {
        1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
        _ => (
            u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| bad())?) as usize,
            12,
        ),
    };
    let header = std::str::from_utf8(bytes.get(start..start + header_len).ok_or_else(bad)?)
        .map_err(|_| bad())?;
    let expected = format!("({LUT_SIZE}, {LUT_SIZE}, {N_WL})");
    if !header.contains("'<f2'")
        || !header.contains("'fortran_order': False")
        || !header.contains(&expected)
    {
        return Err(bad());
    }
    let raw = &bytes[start + header_len..];
    let count = LUT_SIZE * LUT_SIZE * N_WL;
    if raw.len() != count * 2 {
        return Err(bad());
    }
    Ok(raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| half::f16::from_le_bytes(*b).to_f32())
        .collect())
}

/// erf4 spectral bandpass modelling the camera UV/IR cutoff, normalised so it
/// preserves white balance under `illuminant`.
fn window(params: &[f64], sensitivity: &[[f64; 3]], illuminant: &[f64]) -> Vec<[f64; 3]> {
    if params.len() < 4 {
        return vec![[1.; 3]; N_WL];
    }
    let sqrt2 = std::f64::consts::SQRT_2;
    let mut w: Vec<[f64; 3]> = (0..N_WL)
        .map(|i| {
            let wl = data::WL_MIN + i as f64 * data::WL_STEP;
            let uv = 0.5 * (1. + libm::erf((wl - params[0]) / (params[1] * sqrt2)));
            let ir = 0.5 * (1. - libm::erf((wl - params[2]) / (params[3] * sqrt2)));
            [uv * ir; 3]
        })
        .collect();
    for c in 0..3 {
        let si: Vec<f64> = (0..N_WL)
            .map(|i| sensitivity[i][c] * illuminant[i])
            .collect();
        let num = pairwise_sum(
            &si.iter()
                .enumerate()
                .map(|(i, v)| v * w[i][c])
                .collect::<Vec<_>>(),
        );
        let den = pairwise_sum(&si);
        if num > 1e-10 && den > 1e-10 {
            let n = num / den;
            for row in w.iter_mut() {
                row[c] /= n;
            }
        }
    }
    w
}

/// `tc_lut[i][j][c] = sum_wl spectra[i][j][wl] * sensitivity[wl][c] * window[wl][c]`.
///
/// spektrafilm routes this contraction through BLAS for numpy bit-parity; a
/// plain f64 accumulation lands within ~2 ULP, well under the f32 the shader
/// samples it in.
pub fn tc_lut(
    spectra: &[f32],
    sensitivity: &[[f64; 3]],
    window_params: &[f64],
    illuminant: &[f64],
) -> Vec<f64> {
    let w = window(window_params, sensitivity, illuminant);
    let sw: Vec<[f64; 3]> = (0..N_WL)
        .map(|i| std::array::from_fn(|c| sensitivity[i][c] * w[i][c]))
        .collect();
    let mut out = vec![0.0f64; LUT_SIZE * LUT_SIZE * 3];
    for (cell, raw) in out
        .as_chunks_mut::<3>()
        .0
        .iter_mut()
        .zip(spectra.as_chunks::<N_WL>().0)
    {
        for (s, m) in raw.iter().zip(&sw) {
            let s = *s as f64;
            cell[0] += s * m[0];
            cell[1] += s * m[1];
            cell[2] += s * m[2];
        }
    }
    out
}

/// Sample the tc LUT with the same Mitchell-Netravali bicubic the renderer
/// uses, for the midgray calibration that has to agree with the shader.
pub fn sample(lut: &[f64], tx: f64, ty: f64) -> [f64; 3] {
    let scale = (LUT_SIZE - 1) as f64;
    let (fx, fy) = (tx * scale, ty * scale);
    let clamp = |v: f64| v.clamp(0., scale);
    let (xi, yi) = (
        (clamp(fx).floor() as usize).min(LUT_SIZE - 2),
        (clamp(fy).floor() as usize).min(LUT_SIZE - 2),
    );
    let (dx, dy) = (clamp(fx) - xi as f64, clamp(fy) - yi as f64);
    let mitchell = |t: f64| {
        let a = t.abs();
        let b = 1. / 3.;
        if a < 1. {
            ((12. - 15. * b) * a * a * a + (-18. + 18. * b) * a * a + (6. - 2. * b)) / 6.
        } else if a < 2. {
            ((-7. * b) * a * a * a + (36. * b) * a * a + (-60. * b) * a + 32. * b) / 6.
        } else {
            0.
        }
    };
    let reflect = |i: isize| {
        let n = LUT_SIZE as isize;
        let mut idx = i.abs() % (2 * (n - 1));
        if idx >= n {
            idx = 2 * (n - 1) - idx;
        }
        idx.clamp(0, n - 1) as usize
    };
    let mut sum = [0.0f64; 3];
    let mut total = 0.0f64;
    for j in 0..4 {
        let wy = mitchell(dy - (j as f64 - 1.));
        let sy = reflect(yi as isize + j as isize - 1);
        for i in 0..4 {
            let w = mitchell(dx - (i as f64 - 1.)) * wy;
            let sx = reflect(xi as isize + i as isize - 1);
            total += w;
            let base = (sx * LUT_SIZE + sy) * 3;
            for c in 0..3 {
                sum[c] += w * lut[base + c];
            }
        }
    }
    if total != 0. {
        for v in &mut sum {
            *v /= total;
        }
    }
    sum
}

/// ACES-RGC-style radial compression toward the CIE 1931 spectral locus,
/// baked into the tc LUT so the per-pixel path stays compression-agnostic.
/// This is spektrafilm's default `io.input_gamut_compress.algorithm = "xy"`.
pub fn compress_input_gamut(lut: &[f64], white: [f64; 2]) -> Vec<f64> {
    // 380..700 nm at 5 nm, closed.
    let mut locus: Vec<[f64; 2]> = (0..65)
        .map(|i| {
            let (x, y, z) = (data::CMF_X_F64[i], data::CMF_Y_F64[i], data::CMF_Z_F64[i]);
            let t = (x + y + z).max(1e-12);
            [x / t, y / t]
        })
        .collect();
    locus.push(locus[0]);

    let boundary = |dir: [f64; 2]| {
        let mut t_min = f64::INFINITY;
        for seg in locus.windows(2) {
            let (a, b) = (seg[0], seg[1]);
            let e = [b[0] - a[0], b[1] - a[1]];
            let denom = dir[0] * e[1] - dir[1] * e[0];
            if denom.abs() <= 1e-12 {
                continue;
            }
            let o = [white[0] - a[0], white[1] - a[1]];
            let t = (-o[0] * e[1] + o[1] * e[0]) / denom;
            let s = (-o[0] * dir[1] + o[1] * dir[0]) / denom;
            if t > 1e-9 && (0. ..=1.).contains(&s) && t < t_min {
                t_min = t;
            }
        }
        t_min
    };
    // Reinhard knee at spektrafilm's default (threshold 0, limit 1, power 6).
    let knee = |d: f64| {
        if d > 0. {
            d / (1. + d.powf(6.)).powf(1. / 6.)
        } else {
            d
        }
    };

    let inv = 1. / (LUT_SIZE as f64 - 1.);
    let mut out = vec![0.0f64; lut.len()];
    for i in 0..LUT_SIZE {
        for j in 0..LUT_SIZE {
            let (x, y) = data::tc_to_xy(i as f64 * inv, j as f64 * inv);
            let delta = [x - white[0], y - white[1]];
            let dist = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
            let (cx, cy) = if dist < 1e-9 {
                (x, y)
            } else {
                let dir = [delta[0] / dist, delta[1] / dist];
                let edge = boundary(dir).max(1e-12);
                let scaled = knee(dist / edge) * edge;
                (white[0] + dir[0] * scaled, white[1] + dir[1] * scaled)
            };
            let (tx, ty) = data::xy_to_tc(cx, cy);
            let s = bilinear(
                lut,
                tx * (LUT_SIZE as f64 - 1.),
                ty * (LUT_SIZE as f64 - 1.),
            );
            out[(i * LUT_SIZE + j) * 3..][..3].copy_from_slice(&s);
        }
    }
    out
}

/// Clamp-to-edge bilinear fetch, matching `scipy.ndimage.map_coordinates(order=1, mode="nearest")`.
fn bilinear(lut: &[f64], ci: f64, cj: f64) -> [f64; 3] {
    let max = LUT_SIZE as isize - 1;
    let clamp = |v: isize| v.clamp(0, max) as usize;
    let (bi, bj) = (ci.floor(), cj.floor());
    let (fi, fj) = (ci - bi, cj - bj);
    let (i0, i1) = (clamp(bi as isize), clamp(bi as isize + 1));
    let (j0, j1) = (clamp(bj as isize), clamp(bj as isize + 1));
    let cell = |i: usize, j: usize, c: usize| lut[(i * LUT_SIZE + j) * 3 + c];
    std::array::from_fn(|c| {
        cell(i0, j0, c) * (1. - fi) * (1. - fj)
            + cell(i0, j1, c) * (1. - fi) * fj
            + cell(i1, j0, c) * fi * (1. - fj)
            + cell(i1, j1, c) * fi * fj
    })
}
