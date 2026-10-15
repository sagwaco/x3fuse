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
/// preserves the neutral spectrum reconstructed by the irradiance LUT.
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
    let white = data::illuminant_white(illuminant);
    let sum = white.iter().sum::<f64>();
    let (tx, ty) = data::xy_to_tc(white[0] / sum, white[1] / sum);
    let neutral = sample_channels::<N_WL>(tx, ty, |i| spectra[i] as f64);
    let w = window(window_params, sensitivity, &neutral);
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
    sample_channels(tx, ty, |i| lut[i])
}

fn sample_channels<const C: usize>(tx: f64, ty: f64, value: impl Fn(usize) -> f64) -> [f64; C] {
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
    let mut sum = [0.0f64; C];
    let mut total = 0.0f64;
    for j in 0..4 {
        let wy = mitchell(dy - (j as f64 - 1.));
        let sy = reflect(yi as isize + j as isize - 1);
        for i in 0..4 {
            let w = mitchell(dx - (i as f64 - 1.)) * wy;
            let sx = reflect(xi as isize + i as isize - 1);
            total += w;
            let base = (sx * LUT_SIZE + sy) * C;
            for (c, sum) in sum.iter_mut().enumerate() {
                *sum += w * value(base + c);
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

fn ray_polygon_distance(white: [f64; 2], dir: [f64; 2], polygon: &[[f64; 2]]) -> f64 {
    let mut t_min = f64::INFINITY;
    for seg in polygon.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let e = [b[0] - a[0], b[1] - a[1]];
        let denom = dir[0] * e[1] - dir[1] * e[0];
        if denom.abs() <= 1e-12 {
            continue;
        }
        let o = [white[0] - a[0], white[1] - a[1]];
        let t = (-o[0] * e[1] + o[1] * e[0]) / denom;
        let s = (-o[0] * dir[1] + o[1] * dir[0]) / denom;
        if t > 1e-9 && (-1e-9..=1. + 1e-9).contains(&s) && t < t_min {
            t_min = t;
        }
    }
    if t_min.is_finite() {
        t_min
    } else {
        f64::NAN
    }
}

/// Build the 1024-angle inscribed hull from Spektrafilm 28bf883, with detail 5.
fn inscribed_locus_hull(white: [f64; 2]) -> Vec<[f64; 2]> {
    const N: usize = 1024;
    let mut locus: Vec<[f64; 2]> = (0..65)
        .map(|i| {
            let (x, y, z) = (data::CMF_X_F64[i], data::CMF_Y_F64[i], data::CMF_Z_F64[i]);
            let t = (x + y + z).max(1e-12);
            [x / t, y / t]
        })
        .collect();
    locus.push(locus[0]);
    let angle = |i: usize| std::f64::consts::TAU * i as f64 / N as f64;
    let dirs: Vec<_> = (0..N).map(|i| [angle(i).cos(), angle(i).sin()]).collect();
    let mut reach: Vec<_> = dirs
        .iter()
        .map(|&d| ray_polygon_distance(white, d, &locus))
        .collect();
    if reach.iter().any(|v| !v.is_finite()) {
        let mut finite: Vec<_> = reach.iter().copied().filter(|v| v.is_finite()).collect();
        finite.sort_by(f64::total_cmp);
        let median = if finite.is_empty() {
            1e-12
        } else {
            (finite[(finite.len() - 1) / 2] + finite[finite.len() / 2]) * 0.5
        };
        for r in &mut reach {
            if !r.is_finite() {
                *r = median;
            }
        }
    }
    // This small table uses a direct real DFT to avoid an FFT dependency.
    let modes: Vec<[f64; 2]> = (0..=N / 2)
        .map(|k| {
            let weight = (-0.5 * (k as f64 / 5.).powi(2)).exp() / N as f64;
            let mut mode = [0.; 2];
            for (i, &r) in reach.iter().enumerate() {
                let (s, c) = (angle(i) * k as f64).sin_cos();
                mode[0] += r * c;
                mode[1] += r * s;
            }
            mode.map(|v| v * weight)
        })
        .collect();
    let smooth: Vec<_> = (0..N)
        .map(|i| {
            modes
                .iter()
                .enumerate()
                .map(|(k, m)| {
                    let (s, c) = (angle(i) * k as f64).sin_cos();
                    let factor = if k == 0 || k == N / 2 { 1. } else { 2. };
                    factor * (m[0] * c + m[1] * s)
                })
                .sum::<f64>()
                .max(1e-12)
        })
        .collect();
    let scale = reach
        .iter()
        .zip(&smooth)
        .map(|(r, s)| r / s)
        .fold(f64::INFINITY, f64::min);
    let mut hull: Vec<_> = dirs
        .iter()
        .zip(smooth)
        .map(|(d, r)| [white[0] + scale * r * d[0], white[1] + scale * r * d[1]])
        .collect();
    hull.push(hull[0]);
    hull
}

fn compress_xy(xy: [f64; 2], white: [f64; 2], hull: &[[f64; 2]]) -> [f64; 2] {
    let delta = [xy[0] - white[0], xy[1] - white[1]];
    let dist = delta[0].hypot(delta[1]);
    if dist < 1e-9 {
        return xy;
    }
    let dir = delta.map(|v| v / dist);
    let edge = ray_polygon_distance(white, dir, hull).max(1e-12);
    let scaled = super::gamut::reinhard_knee(dist / edge, 0.815, 1.2) * edge;
    [white[0] + dir[0] * scaled, white[1] + dir[1] * scaled]
}

/// Bake the default inscribed-hull compression into the tc LUT.
pub fn compress_input_gamut(lut: &[f64], white: [f64; 2]) -> Vec<f64> {
    let hull = inscribed_locus_hull(white);
    let inv = 1. / (LUT_SIZE as f64 - 1.);
    let mut out = vec![0.0f64; lut.len()];
    for i in 0..LUT_SIZE {
        for j in 0..LUT_SIZE {
            let (x, y) = data::tc_to_xy(i as f64 * inv, j as f64 * inv);
            let [cx, cy] = compress_xy([x, y], white, &hull);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hull_vertex_rays_do_not_fall_between_edges() {
        for white in [[0.3127, 0.329], [0.3457, 0.3585]] {
            let hull = inscribed_locus_hull(white);
            for vertex in &hull {
                let delta = [vertex[0] - white[0], vertex[1] - white[1]];
                let length = delta[0].hypot(delta[1]);
                let reach = ray_polygon_distance(white, delta.map(|v| v / length), &hull);
                assert!(reach.is_finite() && (reach - length).abs() < 1e-10);
            }
        }
    }

    #[test]
    fn inscribed_hull_and_input_knee_match_upstream() {
        // Expected values come from Spektrafilm 28bf883, not this port.
        let white = [0.3127, 0.329];
        let hull = inscribed_locus_hull(white);
        assert_eq!(hull.len(), 1025);
        assert_eq!(hull[0], hull[1024]);
        let expected: [[f64; 2]; 7] = [
            [0.6475331787387982, 0.329],
            [0.6466905293614581, 0.33104936594080664],
            [0.5187509448948979, 0.47411744838131176],
            [0.3127, 0.681606418520718],
            [0.044498320444501305, 0.32900000000000007],
            [0.3126999999999999, 0.0725399745244869],
            [0.6483359046004842, 0.3269405380364674],
        ];
        for (i, expected) in [0, 1, 100, 256, 512, 768, 1023].into_iter().zip(expected) {
            for c in 0..2 {
                assert!((hull[i][c] - expected[c]).abs() < 2e-12);
            }
        }
        let xy = [
            [0.3127, 0.329],
            [0.2, 0.3],
            [0.8, 0.1],
            [0.05, 0.8],
            [0.0, 0.0],
            [1.0, 0.0],
        ];
        let expected = [
            [0.3127, 0.329],
            [0.2, 0.3],
            [0.5819120746384399, 0.2024874510728448],
            [0.09185518908991444, 0.7249570077603742],
            [0.11390299622632555, 0.11984037658606048],
            [0.5821179189999044, 0.20003376203845694],
        ];
        for (xy, expected) in xy.into_iter().zip(expected) {
            let actual = compress_xy(xy, white, &hull);
            for c in 0..2 {
                assert!((actual[c] - expected[c]).abs() < 2e-12);
            }
        }
        let white = [0.3457, 0.3585];
        let hull = inscribed_locus_hull(white);
        assert_eq!(hull.len(), 1025);
        assert_eq!(hull[0], hull[1024]);
        let expected: [[f64; 2]; 7] = [
            [0.631886209192307, 0.3585],
            [0.6306288313615156, 0.3602483233541457],
            [0.5137897264368662, 0.47688214191190886],
            [0.3457, 0.6505202560534786],
            [0.0433384143714729, 0.35850000000000004],
            [0.34569999999999995, 0.09070220309317667],
            [0.6331262289031261, 0.3567363526141453],
        ];
        for (i, expected) in [0, 1, 100, 256, 512, 768, 1023].into_iter().zip(expected) {
            for c in 0..2 {
                assert!((hull[i][c] - expected[c]).abs() < 2e-12);
            }
        }
        let xy = [
            [0.3457, 0.3585],
            [0.2, 0.3],
            [0.8, 0.1],
            [0.05, 0.8],
            [0.0, 0.0],
            [1.0, 0.0],
        ];
        let expected = [
            [0.3457, 0.3585],
            [0.2, 0.3],
            [0.5971588143038845, 0.21541810808374612],
            [0.0992139164847477, 0.7265203106932158],
            [0.12052548429152687, 0.12498809985106271],
            [0.6038958765108267, 0.21703091589617704],
        ];
        for (xy, expected) in xy.into_iter().zip(expected) {
            let actual = compress_xy(xy, white, &hull);
            for c in 0..2 {
                assert!((actual[c] - expected[c]).abs() < 2e-12);
            }
        }
        let white = [0.33242, 0.34743];
        let hull = inscribed_locus_hull(white);
        assert_eq!(hull.len(), 1025);
        assert_eq!(hull[0], hull[1024]);
        let expected: [[f64; 2]; 7] = [
            [0.6390023695665581, 0.34743],
            [0.6378624268057416, 0.3493041947790249],
            [0.515330088921398, 0.4762498188123395],
            [0.33242, 0.6634224085585141],
            [0.043338179216843076, 0.34743000000000007],
            [0.33241999999999994, 0.0832018294633462],
            [0.6401162585797875, 0.3455419757088543],
        ];
        for (i, expected) in [0, 1, 100, 256, 512, 768, 1023].into_iter().zip(expected) {
            for c in 0..2 {
                assert!((hull[i][c] - expected[c]).abs() < 2e-12);
            }
        }
        let xy = [
            [0.33242, 0.34743],
            [0.2, 0.3],
            [0.8, 0.1],
            [0.05, 0.8],
            [0.0, 0.0],
            [1.0, 0.0],
        ];
        let expected = [
            [0.33242, 0.34743],
            [0.2, 0.3],
            [0.5914860419556218, 0.21033963950323045],
            [0.09598661699660244, 0.7263077570492444],
            [0.11757275416880072, 0.1228816015307937],
            [0.5958394298148582, 0.210338097156032],
        ];
        for (xy, expected) in xy.into_iter().zip(expected) {
            let actual = compress_xy(xy, white, &hull);
            for c in 0..2 {
                assert!((actual[c] - expected[c]).abs() < 2e-12);
            }
        }
    }
}
