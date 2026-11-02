//! Real Sony ARW and Panasonic RW2 files: color, lens corrections and the
//! half-size path, compared with the camera JPEG. See
//! `_local/RAW_FORMATS_PLAN.md` "Acceptance tests". Set the variables
//! below to absolute paths, then run with `--release --ignored --nocapture`.
//!
//! - `X3FUSE_TEST_ARW`: `DSC01602.ARW` (Sony RX100 VA).
//! - `X3FUSE_TEST_ARW_A7`: `5679546482.arw` (Sony A7 II).
//! - `X3FUSE_TEST_RW2`: `P1032867.RW2` (Panasonic GX9).
//! - `X3FUSE_TEST_RW2_B`: `P1033061.RW2` (Panasonic GX9).

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
};

const RX100: &str = "X3FUSE_TEST_ARW";
const A7: &str = "X3FUSE_TEST_ARW_A7";
const RW2: &str = "X3FUSE_TEST_RW2";
const RW2_B: &str = "X3FUSE_TEST_RW2_B";
const ALL: [&str; 4] = [RW2, RW2_B, RX100, A7];

fn sample(var: &str) -> PathBuf {
    let path = std::env::var_os(var).unwrap_or_else(|| panic!("{var} is not set"));
    PathBuf::from(path)
}

fn name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

/// The scene with all lens corrections on, or all off.
fn scene(path: &Path, half_size: bool, lens: bool) -> Scene {
    scene_with(path, half_size, lens, lens)
}

/// The scene; with `lens` true and `vignetting` false, only the lens Warp.
fn scene_with(path: &Path, half_size: bool, lens: bool, vignetting: bool) -> Scene {
    let cancel = AtomicBool::new(false);
    let s = x3f_dng::prepare_for_test(path, half_size, lens, vignetting, &cancel).unwrap();
    assert_eq!(s.data.len(), s.width as usize * s.height as usize * 3);
    x3f_dng_scene::Scene {
        data: s.data,
        width: s.width as usize,
        height: s.height as usize,
    }
}

/// `scene` cropped to the as-shot crop, which the camera JPEG shows. The
/// RX100 sample was shot in 4:3 mode. This maps the upright crop to the
/// unrotated pixels as `preview_crop` in `lib.rs` does.
fn shown_scene(path: &Path, half_size: bool, lens: bool) -> Scene {
    shown(path, scene(path, half_size, lens))
}

/// The scene `s` of `path` cropped to the as-shot crop.
fn shown(path: &Path, s: Scene) -> Scene {
    let info = x3f_dng::inspect(path, &AtomicBool::new(false)).unwrap();
    let Some([x, y, w, h]) = info.as_shot_crop else {
        return s;
    };
    let map = |x: f32, y: f32| match info.orientation {
        2 => (1. - x, y),
        3 => (1. - x, 1. - y),
        4 => (x, 1. - y),
        5 => (y, x),
        6 => (y, 1. - x),
        7 => (1. - y, 1. - x),
        8 => (1. - y, x),
        _ => (x, y),
    };
    let (a, b) = (map(x, y), map(x + w, y + h));
    let px = |v: f32, n: usize| ((v * n as f32).round() as usize).min(n);
    let (x0, x1) = (px(a.0.min(b.0), s.width), px(a.0.max(b.0), s.width));
    let (y0, y1) = (px(a.1.min(b.1), s.height), px(a.1.max(b.1), s.height));
    println!(
        "  as-shot crop {:?} orientation {} -> pixels x {x0}..{x1} y {y0}..{y1} of {}x{}",
        info.as_shot_crop, info.orientation, s.width, s.height
    );
    let mut data = Vec::with_capacity((x1 - x0) * (y1 - y0) * 3);
    for row in y0..y1 {
        data.extend_from_slice(&s.data[(row * s.width + x0) * 3..(row * s.width + x1) * 3]);
    }
    Scene {
        data,
        width: x1 - x0,
        height: y1 - y0,
    }
}

/// Plain containers, so the helpers do not depend on `x3f_core`.
mod x3f_dng_scene {
    /// Unrotated scene-linear RGB (linear sRGB primaries), three samples per pixel.
    pub struct Scene {
        pub data: Vec<f32>,
        pub width: usize,
        pub height: usize,
    }
}
use x3f_dng_scene::Scene;

/// One float plane.
#[derive(Clone)]
struct Plane {
    w: usize,
    h: usize,
    v: Vec<f32>,
}

impl Plane {
    fn at(&self, x: usize, y: usize) -> f32 {
        self.v[y * self.w + x]
    }
}

fn decode_srgb(v: f32) -> f32 {
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn encode_srgb(v: f32) -> f32 {
    let v = v.clamp(0., 1.);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1. / 2.4) - 0.055
    }
}

fn luma([r, g, b]: [f32; 3]) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// The bundled ExifTool, selected as `ExifTool::run` in
/// `src-tauri/src/metadata.rs` does: `exiftool.exe` on Windows, else Perl
/// with the bundled script.
fn exiftool() -> Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/exiftool");
    #[cfg(windows)]
    let command = Command::new(root.join("exiftool.exe"));
    #[cfg(not(windows))]
    let command = {
        let mut c = Command::new("perl");
        c.arg(root.join("exiftool"));
        c
    };
    command
}

/// The camera JPEG, extracted by the bundled ExifTool from a temporary copy.
/// Each call uses its own temporary directory, so parallel tests do not race.
fn camera_jpeg(path: &Path) -> image::RgbImage {
    static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("x3f-dng-raw-formats-{}-{call}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let copy = dir.join(name(path));
    std::fs::copy(path, &copy).unwrap();
    let mut jpeg = Vec::new();
    for tag in ["-JpgFromRaw", "-PreviewImage"] {
        let out = exiftool()
            .args(["-b", tag])
            .arg(&copy)
            .output()
            .expect("run the bundled ExifTool; run `npm run sync:resources` first");
        if out.status.success() && out.stdout.starts_with(&[0xff, 0xd8]) {
            jpeg = out.stdout;
            break;
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(!jpeg.is_empty(), "{} has no camera JPEG", name(path));
    image::load_from_memory(&jpeg).unwrap().into_rgb8()
}

/// The camera JPEG content rectangle `[x, y, w, h]`: trim edge rows and
/// columns whose mean is below 2/255.
fn content_rect(jpeg: &image::RgbImage) -> [usize; 4] {
    let (w, h) = (jpeg.width() as usize, jpeg.height() as usize);
    let raw = jpeg.as_raw();
    let mean = |x0: usize, x1: usize, y0: usize, y1: usize| {
        let mut sum = 0u64;
        for y in y0..y1 {
            for x in x0..x1 {
                let i = (y * w + x) * 3;
                sum += u64::from(raw[i]) + u64::from(raw[i + 1]) + u64::from(raw[i + 2]);
            }
        }
        sum as f64 / ((x1 - x0) * (y1 - y0) * 3) as f64
    };
    let dark = |m: f64| m < 2.;
    let (mut top, mut bottom, mut left, mut right) = (0, h, 0, w);
    while top < bottom && dark(mean(0, w, top, top + 1)) {
        top += 1;
    }
    while bottom > top && dark(mean(0, w, bottom - 1, bottom)) {
        bottom -= 1;
    }
    while left < right && dark(mean(left, left + 1, top, bottom)) {
        left += 1;
    }
    while right > left && dark(mean(right - 1, right, top, bottom)) {
        right -= 1;
    }
    assert!(
        right - left > w / 2 && bottom - top > h / 2,
        "content {left} {top} {right} {bottom}"
    );
    [left, top, right - left, bottom - top]
}

/// Linear-light RGB of the JPEG content rectangle.
fn jpeg_linear(jpeg: &image::RgbImage, [x0, y0, w, h]: [usize; 4]) -> Vec<[f32; 3]> {
    let mut out = Vec::with_capacity(w * h);
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let p = jpeg.get_pixel(x as u32, y as u32).0;
            out.push(p.map(|v| decode_srgb(f32::from(v) / 255.)));
        }
    }
    out
}

/// The scene as the preview shows it: clamped to [0, 1] after `gain`.
fn scene_linear(scene: &Scene, gain: f32) -> Vec<[f32; 3]> {
    scene
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .map(|p| p.map(|v| (v * gain).clamp(0., 1.)))
        .collect()
}

/// The gain that gives the scene the mean luminance of the JPEG.
fn exposure_match(scene: &Scene, jpeg: &[[f32; 3]]) -> f32 {
    let mean = |px: &mut dyn Iterator<Item = f32>| {
        let (s, n) = px.fold((0f64, 0usize), |(s, n), v| (s + f64::from(v), n + 1));
        s / n as f64
    };
    let target = mean(&mut jpeg.iter().map(|p| luma(*p)));
    let mut gain = 1f32;
    // The clamp makes this nonlinear; a few fixed-point steps converge.
    for _ in 0..6 {
        let m = mean(
            &mut scene
                .data
                .as_chunks::<3>()
                .0
                .iter()
                .step_by(7)
                .map(|p| luma(p.map(|v| (v * gain).clamp(0., 1.)))),
        );
        if m <= 0. {
            break;
        }
        gain *= (target / m) as f32;
    }
    gain
}

/// sRGB-encoded luminance.
fn gray(px: &[[f32; 3]], w: usize, h: usize) -> Plane {
    Plane {
        w,
        h,
        v: px.iter().map(|p| encode_srgb(luma(*p))).collect(),
    }
}

/// Area (box) resampling of each axis to the new size.
fn resize_area(src: &Plane, w: usize, h: usize) -> Plane {
    fn weights(from: usize, to: usize) -> Vec<Vec<(usize, f32)>> {
        let step = from as f64 / to as f64;
        (0..to)
            .map(|i| {
                let (a, b) = (i as f64 * step, (i + 1) as f64 * step);
                let mut out = Vec::new();
                let mut j = a.floor() as usize;
                while (j as f64) < b && j < from {
                    let cover = (b.min(j as f64 + 1.) - a.max(j as f64)) / step;
                    if cover > 0. {
                        out.push((j, cover as f32));
                    }
                    j += 1;
                }
                out
            })
            .collect()
    }
    let wx = weights(src.w, w);
    let wy = weights(src.h, h);
    let mut rows = vec![0f32; w * src.h];
    for y in 0..src.h {
        for (x, ws) in wx.iter().enumerate() {
            rows[y * w + x] = ws.iter().map(|(j, k)| src.v[y * src.w + j] * k).sum();
        }
    }
    let mut v = vec![0f32; w * h];
    for (y, ws) in wy.iter().enumerate() {
        for x in 0..w {
            v[y * w + x] = ws.iter().map(|(j, k)| rows[j * w + x] * k).sum();
        }
    }
    Plane { w, h, v }
}

/// Sobel gradient magnitude. Border pixels are zero.
fn gradient(p: &Plane) -> Plane {
    let mut v = vec![0f32; p.w * p.h];
    for y in 1..p.h - 1 {
        for x in 1..p.w - 1 {
            let col = |x: usize| p.at(x, y - 1) + 2. * p.at(x, y) + p.at(x, y + 1);
            let row = |y: usize| p.at(x - 1, y) + 2. * p.at(x, y) + p.at(x + 1, y);
            let gx = col(x + 1) - col(x - 1);
            let gy = row(y + 1) - row(y - 1);
            v[y * p.w + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    Plane { w: p.w, h: p.h, v }
}

/// One patch match. `offset` is where the patch of the reference shows in
/// the other image, relative to the same position.
#[derive(Debug)]
struct Match {
    center: [f64; 2],
    offset: [f64; 2],
    best: f64,
    second: f64,
}

#[derive(Debug, PartialEq)]
enum Reject {
    LowEnergy,
    LowCorrelation,
    Boundary,
    Ambiguous,
    Ridge,
}

/// Normalized cross-correlation of the reference patch of size `2 half`
/// at (`cx`, `cy`) against `other` over +-`search` px, with parabolic
/// subpixel refinement. Applies the plan's validity rules. `min_energy` is
/// the lowest mean gradient magnitude of a usable reference patch.
fn match_patch(
    reference: &Plane,
    other: &Plane,
    (cx, cy): (usize, usize),
    half: usize,
    search: usize,
    min_energy: f32,
) -> Result<Match, (Reject, f64)> {
    let (x0, y0) = (cx - half, cy - half);
    let n = (2 * half) * (2 * half);
    let mut t = Vec::with_capacity(n);
    for y in y0..y0 + 2 * half {
        t.extend_from_slice(&reference.v[y * reference.w + x0..y * reference.w + x0 + 2 * half]);
    }
    let energy = t.iter().sum::<f32>() / n as f32;
    if energy < min_energy {
        return Err((Reject::LowEnergy, f64::from(energy)));
    }
    let tm = t.iter().map(|v| f64::from(*v)).sum::<f64>() / n as f64;
    let t: Vec<f64> = t.iter().map(|v| f64::from(*v) - tm).collect();
    let tn = t.iter().map(|v| v * v).sum::<f64>().sqrt();
    let side = 2 * search + 1;
    let mut map = vec![-1f64; side * side];
    for dy in 0..side {
        for dx in 0..side {
            let (ox, oy) = (x0 + dx - search, y0 + dy - search);
            let (mut s, mut ss, mut st) = (0f64, 0f64, 0f64);
            for y in 0..2 * half {
                let row = &other.v[(oy + y) * other.w + ox..(oy + y) * other.w + ox + 2 * half];
                for (x, v) in row.iter().enumerate() {
                    let v = f64::from(*v);
                    s += v;
                    ss += v * v;
                    st += v * t[y * 2 * half + x];
                }
            }
            let var = ss - s * s / n as f64;
            if var > 0. && tn > 0. {
                map[dy * side + dx] = st / (var.sqrt() * tn);
            }
        }
    }
    let at = |x: usize, y: usize| map[y * side + x];
    let (bi, best) = map
        .iter()
        .copied()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap();
    let (bx, by) = (bi % side, bi / side);
    // The second-best separate peak: a local maximum more than 2 px away.
    // A periodic pattern (window rows) gives such a peak, often weakly
    // separated, so a valley test is not used.
    let mut second = -1f64;
    for y in 0..side {
        for x in 0..side {
            if x.abs_diff(bx) <= 2 && y.abs_diff(by) <= 2 {
                continue;
            }
            let v = at(x, y);
            let mut peak = true;
            for ny in y.saturating_sub(1)..(y + 2).min(side) {
                for nx in x.saturating_sub(1)..(x + 2).min(side) {
                    if (nx, ny) != (x, y) && at(nx, ny) > v {
                        peak = false;
                    }
                }
            }
            if peak {
                second = second.max(v);
            }
        }
    }
    if best < 0.5 {
        return Err((Reject::LowCorrelation, best));
    }
    if bx == 0 || by == 0 || bx == side - 1 || by == side - 1 {
        return Err((Reject::Boundary, best));
    }
    if best - second < 0.05 {
        return Err((Reject::Ambiguous, second));
    }
    // A ridge (one straight edge) has no peak along the edge. Reject the
    // patch if the correlation 3 px away, in x, y or a diagonal direction,
    // is within 0.05 of the best.
    let step = |v: usize, d: isize| (v as isize + 3 * d).clamp(0, side as isize - 1) as usize;
    for (dx, dy) in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        let ridge = at(step(bx, dx), step(by, dy)).max(at(step(bx, -dx), step(by, -dy)));
        if best - ridge < 0.05 {
            return Err((Reject::Ridge, ridge));
        }
    }
    let parabola = |l: f64, c: f64, r: f64| {
        let d = l - 2. * c + r;
        if d < 0. {
            (0.5 * (l - r) / d).clamp(-0.5, 0.5)
        } else {
            0.
        }
    };
    // Subpixel: NCC at quarter-pixel offsets within +-1 px of the integer
    // peak (bilinear samples of `other`), then a parabola at that step. A
    // parabola on the integer map alone locks toward whole pixels.
    let ncc_at = |ox: f64, oy: f64| {
        let (mut s, mut ss, mut st) = (0f64, 0f64, 0f64);
        for y in 0..2 * half {
            for x in 0..2 * half {
                let (px, py) = (x0 as f64 + x as f64 + ox, y0 as f64 + y as f64 + oy);
                let (ix, iy) = (px.floor() as usize, py.floor() as usize);
                let (fx, fy) = (px - ix as f64, py - iy as f64);
                let o = |x: usize, y: usize| f64::from(other.v[y * other.w + x]);
                let v = (o(ix, iy) * (1. - fx) + o(ix + 1, iy) * fx) * (1. - fy)
                    + (o(ix, iy + 1) * (1. - fx) + o(ix + 1, iy + 1) * fx) * fy;
                s += v;
                ss += v * v;
                st += v * t[y * 2 * half + x];
            }
        }
        let var = ss - s * s / n as f64;
        if var > 0. {
            st / (var.sqrt() * tn)
        } else {
            -1.
        }
    };
    let (ix, iy) = (bx as f64 - search as f64, by as f64 - search as f64);
    let mut fine = [[0f64; 9]; 9];
    for (j, row) in fine.iter_mut().enumerate() {
        for (i, v) in row.iter_mut().enumerate() {
            *v = ncc_at(ix + (i as f64 - 4.) / 4., iy + (j as f64 - 4.) / 4.);
        }
    }
    let (mut fi, mut fj) = (4, 4);
    for j in 0..9 {
        for i in 0..9 {
            if fine[j][i] > fine[fj][fi] {
                (fi, fj) = (i, j);
            }
        }
    }
    let (fi, fj) = (fi.clamp(1, 7), fj.clamp(1, 7));
    let c = fine[fj][fi];
    let sx = parabola(fine[fj][fi - 1], c, fine[fj][fi + 1]);
    let sy = parabola(fine[fj - 1][fi], c, fine[fj + 1][fi]);
    Ok(Match {
        center: [cx as f64, cy as f64],
        offset: [
            ix + (fi as f64 - 4. + sx) / 4.,
            iy + (fj as f64 - 4. + sy) / 4.,
        ],
        best,
        second,
    })
}

/// The plan's 3 x 3 patch grid, as fractions of the size.
const GRID_3: [f64; 3] = [0.1, 0.5, 0.9];
/// The 5 x 5 grid of the camera JPEG comparison (orchestrator decision: the
/// RW2 samples have too few valid patches on the 3 x 3 grid).
const GRID_5: [f64; 5] = [0.1, 0.3, 0.5, 0.7, 0.9];

/// The patch centers: a grid at the fractions `at` of the size.
fn grid(w: usize, h: usize, fractions: &[f64]) -> Vec<(usize, usize)> {
    let at = |f: f64, n: usize| (f * n as f64).round() as usize;
    let mut out = Vec::new();
    for &fy in fractions {
        for &fx in fractions {
            out.push((at(fx, w), at(fy, h)));
        }
    }
    out
}

/// Least-squares scale and translation about the image center:
/// `offset = (scale - 1) (center - mid) + translation`.
#[derive(Debug)]
struct Fit {
    valid: usize,
    scale: f64,
    translation: [f64; 2],
    residual_max: f64,
    residual_rms: f64,
    /// Valid patches on the outer ring of the grid.
    ring: usize,
}

fn fit(matches: &[Match], w: usize, h: usize) -> Fit {
    let mid = [w as f64 / 2., h as f64 / 2.];
    let n = matches.len() as f64;
    let p: Vec<[f64; 2]> = matches
        .iter()
        .map(|m| [m.center[0] - mid[0], m.center[1] - mid[1]])
        .collect();
    let pm = [0, 1].map(|a| p.iter().map(|v| v[a]).sum::<f64>() / n);
    let dm = [0, 1].map(|a| matches.iter().map(|m| m.offset[a]).sum::<f64>() / n);
    let (mut num, mut den) = (0., 0.);
    for (m, p) in matches.iter().zip(&p) {
        for a in 0..2 {
            num += (p[a] - pm[a]) * (m.offset[a] - dm[a]);
            den += (p[a] - pm[a]).powi(2);
        }
    }
    let k = if den > 0. { num / den } else { 0. };
    let translation = [dm[0] - k * pm[0], dm[1] - k * pm[1]];
    let residuals: Vec<f64> = matches
        .iter()
        .zip(&p)
        .map(|(m, p)| {
            let ex = m.offset[0] - (k * p[0] + translation[0]);
            let ey = m.offset[1] - (k * p[1] + translation[1]);
            (ex * ex + ey * ey).sqrt()
        })
        .collect();
    Fit {
        valid: matches.len(),
        scale: 1. + k,
        translation,
        residual_max: residuals.iter().copied().fold(0., f64::max),
        residual_rms: (residuals.iter().map(|r| r * r).sum::<f64>() / n).sqrt(),
        ring: 0,
    }
}

/// Matches the 3 x 3 grid of 96 px patches of the gradient of the gray
/// image `reference` in that of `other` (+-12 px) and fits scale and
/// translation. Patches whose reference mean gradient is below a quarter of
/// the image mean are low energy. Patches with more than 2% clipped pixels
/// (gray >= 0.99) in either image are invalid too: clipped highlights do
/// not keep their shape between renders, so they do not show geometry.
fn geometry(label: &str, reference: &Plane, other: &Plane) -> Option<Fit> {
    geometry_on(label, reference, other, &GRID_3)
}

/// `geometry` on a grid at the fractions `fractions` of the size. `Fit::ring`
/// counts the valid patches on the outer ring (first or last fraction).
fn geometry_on(label: &str, reference: &Plane, other: &Plane, fractions: &[f64]) -> Option<Fit> {
    assert_eq!((reference.w, reference.h), (other.w, other.h));
    let edge = |v: usize, n: usize| {
        let at = |f: f64| (f * n as f64).round() as usize;
        v == at(fractions[0]) || v == at(fractions[fractions.len() - 1])
    };
    let clipped = |p: &Plane, (cx, cy): (usize, usize)| {
        let mut n = 0;
        for y in cy - 48..cy + 48 {
            n += p.v[y * p.w + cx - 48..y * p.w + cx + 48]
                .iter()
                .filter(|v| **v >= 0.99)
                .count();
        }
        n as f64 / (96. * 96.)
    };
    let (gray, reference, other) = ((reference, other), gradient(reference), gradient(other));
    let min_energy = 0.25 * reference.v.iter().sum::<f32>() / reference.v.len() as f32;
    let mut matches = Vec::new();
    for c in grid(reference.w, reference.h, fractions) {
        let clip = clipped(gray.0, c).max(clipped(gray.1, c));
        if clip > 0.02 {
            println!("  {label} patch {c:?}: invalid Clipped ({clip:.3})");
            continue;
        }
        match match_patch(&reference, &other, c, 48, 12, min_energy) {
            Ok(m) => {
                println!(
                    "  {label} patch {c:?}: offset ({:+.2}, {:+.2}) ncc {:.3} second {:.3}",
                    m.offset[0], m.offset[1], m.best, m.second
                );
                matches.push(m);
            }
            Err((why, value)) => println!("  {label} patch {c:?}: invalid {why:?} ({value:.3})"),
        }
    }
    if matches.len() < 3 {
        println!("  {label}: {} valid patches, no fit", matches.len());
        return None;
    }
    let mut f = fit(&matches, reference.w, reference.h);
    f.ring = matches
        .iter()
        .filter(|m| {
            let (x, y) = (m.center[0] as usize, m.center[1] as usize);
            edge(x, reference.w) || edge(y, reference.h)
        })
        .count();
    println!(
        "  {label}: valid {} (ring {}) scale {:.5} translation ({:+.2}, {:+.2}) residual max {:.3} rms {:.3}",
        f.valid, f.ring, f.scale, f.translation[0], f.translation[1], f.residual_max, f.residual_rms
    );
    Some(f)
}

/// Mean linear luminance of a normalized box `[x0, y0, x1, y1]`.
fn box_luma(px: &[[f32; 3]], w: usize, h: usize, [x0, y0, x1, y1]: [f64; 4]) -> f64 {
    let (ax, bx) = ((x0 * w as f64) as usize, (x1 * w as f64) as usize);
    let (ay, by) = ((y0 * h as f64) as usize, (y1 * h as f64) as usize);
    let mut sum = 0f64;
    for y in ay..by {
        for p in &px[y * w + ax..y * w + bx] {
            sum += f64::from(luma(*p));
        }
    }
    sum / ((bx - ax) * (by - ay)) as f64
}

const CENTER: [f64; 4] = [0.45, 0.45, 0.55, 0.55];
const CORNERS: [[f64; 4]; 4] = [
    [0.02, 0.02, 0.10, 0.10],
    [0.90, 0.02, 0.98, 0.10],
    [0.02, 0.90, 0.10, 0.98],
    [0.90, 0.90, 0.98, 0.98],
];

/// Corner-to-center mean luminance ratios, one per corner.
fn corner_ratios(px: &[[f32; 3]], w: usize, h: usize) -> [f64; 4] {
    let center = box_luma(px, w, h, CENTER);
    CORNERS.map(|b| box_luma(px, w, h, b) / center)
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2, X3FUSE_TEST_RW2_B"]
fn sony_and_panasonic_open_with_color() {
    let cancel = AtomicBool::new(false);
    for var in ALL {
        let path = sample(var);
        let info = x3f_dng::inspect(&path, &cancel).unwrap();
        let start = std::time::Instant::now();
        let s = x3f_dng::prepare(&path, &cancel).unwrap();
        let elapsed = start.elapsed();
        println!("{}: {info:?} prepare {elapsed:.2?}", name(&path));
        assert!(info.bayer, "{} is not Bayer", name(&path));
        assert!(!info.monochrome);
        assert_eq!((s.width, s.height), (info.width, info.height));
        assert_eq!(s.orientation, info.orientation);
        assert_eq!(s.data.len(), s.width as usize * s.height as usize * 3);
        assert!(s.data.iter().all(|v| v.is_finite()));
        let wb = &s.white_balance;
        assert!(wb.camera_to_rgb.iter().all(|v| v.is_finite()));
        assert!(wb.camera_to_rgb.iter().any(|v| *v != 0.));
        assert!(wb.as_shot_neutral.iter().all(|v| v.is_finite() && *v > 0.));
        let mean = [0, 1, 2].map(|c| {
            s.data
                .iter()
                .skip(c)
                .step_by(3 * 13)
                .map(|v| f64::from(*v))
                .sum::<f64>()
                / (s.data.len() / (3 * 13)) as f64
        });
        println!("  neutral {:?} mean rgb {mean:.4?}", wb.as_shot_neutral);
        assert!(mean.iter().all(|m| *m > 0.), "{mean:?}");
        let expected = if var == A7 { 8 } else { 1 };
        assert_eq!(info.orientation, expected, "{}", name(&path));
    }
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2, X3FUSE_TEST_RW2_B"]
fn color_matches_camera_jpeg() {
    for var in ALL {
        let path = sample(var);
        let jpeg = camera_jpeg(&path);
        let rect = content_rect(&jpeg);
        let reference = jpeg_linear(&jpeg, rect);
        // The preview path: half size, lens corrections on, sRGB clamp.
        let s = shown_scene(&path, true, true);
        let render = scene_linear(&s, 1.);
        let means = |px: &[[f32; 3]]| {
            [0, 1, 2].map(|c| px.iter().map(|p| f64::from(p[c])).sum::<f64>() / px.len() as f64)
        };
        let (a, b) = (means(&render), means(&reference));
        let ratios = |m: [f64; 3]| [m[0] / m[1], m[2] / m[1]];
        let (ra, rb) = (ratios(a), ratios(b));
        let err = [ra[0] / rb[0] - 1., ra[1] / rb[1] - 1.];
        println!(
            "{}: jpeg {}x{} content {rect:?} render {}x{} linear means render {a:.4?} jpeg {b:.4?} \
             R/G {:.4} vs {:.4} ({:+.1}%), B/G {:.4} vs {:.4} ({:+.1}%)",
            name(&path),
            jpeg.width(),
            jpeg.height(),
            s.width,
            s.height,
            ra[0],
            rb[0],
            err[0] * 100.,
            ra[1],
            rb[1],
            err[1] * 100.
        );
        assert!(
            err.iter().all(|e| e.abs() <= 0.10),
            "{}: {err:?}",
            name(&path)
        );
    }
}

/// The gray image of the render, exposure-matched and area-scaled to
/// the JPEG content rectangle.
fn render_gray(s: &Scene, reference: &[[f32; 3]], [_, _, w, h]: [usize; 4]) -> Plane {
    let gain = exposure_match(s, reference);
    let full = gray(&scene_linear(s, gain), s.width, s.height);
    resize_area(&full, w, h)
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2, X3FUSE_TEST_RW2_B"]
fn lens_geometry_matches_camera_jpeg() {
    let mut failures = Vec::new();
    for var in ALL {
        let path = sample(var);
        let jpeg = camera_jpeg(&path);
        let rect = content_rect(&jpeg);
        let reference = jpeg_linear(&jpeg, rect);
        let jg = gray(&reference, rect[2], rect[3]);
        println!("{}: content {rect:?}", name(&path));
        let Some(corrected) = geometry_on(
            "corrected",
            &jg,
            &render_gray(&shown_scene(&path, false, true), &reference, rect),
            &GRID_5,
        ) else {
            failures.push(format!("{}: too few valid patches", name(&path)));
            continue;
        };
        let [tx, ty] = corrected.translation;
        // At least 6 valid patches, 3 of them on the outer 10% / 90% ring,
        // where distortion is largest.
        if corrected.valid < 6
            || corrected.ring < 3
            || corrected.residual_max > 1.5
            || corrected.residual_rms > 0.75
            || (corrected.scale - 1.).abs() > 0.03
            || tx.hypot(ty) > 3.
        {
            failures.push(format!("{}: {corrected:?}", name(&path)));
        }
        // A7 II distortion is Off: no distortion warp, so no comparison.
        if var != A7 {
            let uncorrected = geometry_on(
                "uncorrected",
                &jg,
                &render_gray(&shown_scene(&path, false, false), &reference, rect),
                &GRID_5,
            );
            // The 1.5x rule needs a fit of the control (at least 3 valid patches).
            let Some(uncorrected) = uncorrected else {
                failures.push(format!("{}: no uncorrected fit", name(&path)));
                continue;
            };
            let rms = uncorrected.residual_rms;
            println!(
                "  uncorrected rms / corrected rms = {:.2}",
                rms / corrected.residual_rms
            );
            if rms < 1.5 * corrected.residual_rms {
                failures.push(format!(
                    "{}: uncorrected rms {rms} corrected {}",
                    name(&path),
                    corrected.residual_rms
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2"]
fn half_size_matches_full_size() {
    for var in [RW2, A7] {
        let path = sample(var);
        let half = scene(&path, true, true);
        let full = scene(&path, false, true);
        println!(
            "{}: half {}x{} full {}x{}",
            name(&path),
            half.width,
            half.height,
            full.width,
            full.height
        );
        assert!(half.width.abs_diff(full.width / 2) <= 1);
        assert!(half.height.abs_diff(full.height / 2) <= 1);
        let hl = scene_linear(&half, 1.);
        let fl = scene_linear(&full, 1.);
        let hg = gray(&hl, half.width, half.height);
        let fg = resize_area(&gray(&fl, full.width, full.height), half.width, half.height);
        let f = geometry("half vs full", &hg, &fg)
            .unwrap_or_else(|| panic!("{}: too few valid patches", name(&path)));
        assert!(f.valid >= 6, "{f:?}");
        assert!(f.residual_max <= 0.5, "{}: {f:?}", name(&path));
        // Unclamped: a clamp at 0 biases dark noisy corners by resolution.
        let rh = corner_ratios(half.data.as_chunks::<3>().0, half.width, half.height);
        let rf = corner_ratios(full.data.as_chunks::<3>().0, full.width, full.height);
        println!("  corner/center half {rh:.4?} full {rf:.4?}");
        for (a, b) in rh.iter().zip(&rf) {
            assert!((a / b - 1.).abs() <= 0.02, "{}: {rh:?} {rf:?}", name(&path));
        }
    }
}

const CA_HALF: usize = 64;
const CA_SEARCH: usize = 6;
/// Box blur radius; two passes (a 5-tap triangle). Radius 2 widened the
/// correlation peaks so much that the ridge rule rejected the RX100 corners.
const CA_BLUR: usize = 1;
/// Crop radius: room for the search, the blur and the gradient.
const CA_R: usize = CA_HALF + CA_SEARCH + 2 * CA_BLUR + 2;

/// Gradient magnitude of channel `c`, sRGB-encoded and blurred against
/// noise (two passes of a separable box of radius `CA_BLUR`), in a crop of
/// radius `CA_R` around (`cx`, `cy`). Edge values of the crop are clamped.
fn ca_crop(s: &Scene, (cx, cy): (usize, usize), c: usize) -> Plane {
    let (x0, y0, n) = (cx - CA_R, cy - CA_R, 2 * CA_R);
    let mut v: Vec<f32> = (0..n * n)
        .map(|i| encode_srgb(s.data[((y0 + i / n) * s.width + x0 + i % n) * 3 + c]))
        .collect();
    let b = CA_BLUR as isize;
    let k = (2 * b + 1) as f32;
    for _ in 0..2 {
        for (sx, sy) in [(1, 0), (0, 1)] {
            let src = v.clone();
            for y in 0..n as isize {
                for x in 0..n as isize {
                    let mut sum = 0.;
                    for t in -b..=b {
                        let px = (x + t * sx).clamp(0, n as isize - 1) as usize;
                        let py = (y + t * sy).clamp(0, n as isize - 1) as usize;
                        sum += src[py * n + px];
                    }
                    v[y as usize * n + x as usize] = sum / k;
                }
            }
        }
    }
    gradient(&Plane { w: n, h: n, v })
}

/// The CA patches as `(region, center)`. Regions 0 to 3 are the corners
/// (the outer 20% of width and height); region 4 is the central 20%. Each
/// region gives up to 4 separate 128 px patches with the most green
/// gradient energy, on a 32 px grid. More patches average the noise.
fn ca_patches(s: &Scene) -> Vec<(usize, (usize, usize))> {
    // 0: near edge, 1: far edge, 2: center.
    let span = |n: usize, part: usize| {
        let (lo, hi) = match part {
            0 => (CA_R + 1, n / 5),
            1 => (n - n / 5, n - CA_R - 1),
            _ => (n * 2 / 5, n * 3 / 5),
        };
        (lo..=hi).step_by(32).collect::<Vec<_>>()
    };
    let mut out = Vec::new();
    for (region, (rx, ry)) in [(0, 0), (1, 0), (0, 1), (1, 1), (2, 2)]
        .into_iter()
        .enumerate()
    {
        let mut candidates = Vec::new();
        for &y in &span(s.height, ry) {
            for &x in &span(s.width, rx) {
                let g = ca_crop(s, (x, y), 1);
                let mut e = 0f32;
                for py in CA_R - CA_HALF..CA_R + CA_HALF {
                    e += g.v[py * g.w + CA_R - CA_HALF..py * g.w + CA_R + CA_HALF]
                        .iter()
                        .sum::<f32>();
                }
                candidates.push((e, (x, y)));
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut chosen: Vec<(usize, usize)> = Vec::new();
        for (_, (x, y)) in candidates {
            let apart = |&(cx, cy): &(usize, usize)| {
                x.abs_diff(cx) >= 2 * CA_HALF || y.abs_diff(cy) >= 2 * CA_HALF
            };
            if chosen.len() < 4 && chosen.iter().all(apart) {
                chosen.push((x, y));
            }
        }
        out.extend(chosen.into_iter().map(|c| (region, c)));
    }
    out
}

/// The red-to-green (`c` 0) or blue-to-green (`c` 2) offset of a patch at
/// full resolution, +-6 px. None for an invalid patch.
fn ca_offset(s: &Scene, center: (usize, usize), c: usize) -> Option<[f64; 2]> {
    let green = ca_crop(s, center, 1);
    let other = ca_crop(s, center, c);
    // The Sobel magnitude of a 3 x 3 blurred sRGB channel; 0.01 is flat.
    match match_patch(&green, &other, (CA_R, CA_R), CA_HALF, CA_SEARCH, 0.01) {
        Ok(m) => Some(m.offset),
        Err((why, value)) => {
            println!("  patch {center:?} channel {c}: invalid {why:?} ({value:.3})");
            None
        }
    }
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7"]
fn chromatic_aberration_is_reduced() {
    let (mut improved, mut failures) = (0, Vec::<String>::new());
    // Per sample: (name, covered, passed). Coverage: each channel (red and
    // blue) has valid pairs in at least `min_corners` corners.
    let mut results = Vec::new();
    for var in [RX100, A7] {
        let min_corners = if var == A7 { 3 } else { 2 };
        let mut corners = [
            std::collections::BTreeSet::new(),
            std::collections::BTreeSet::new(),
        ];
        let path = sample(var);
        let corrected = scene(&path, false, true);
        let patches = ca_patches(&corrected);
        println!("{}: patches (region, center) {patches:?}", name(&path));
        let measure = |s: &Scene| {
            patches
                .iter()
                .map(|(_, p)| [ca_offset(s, *p, 0), ca_offset(s, *p, 2)])
                .collect::<Vec<_>>()
        };
        let on = measure(&corrected);
        drop(corrected);
        let off = measure(&scene(&path, false, false));
        // Lateral CA grows with radius. A constant shift between channels,
        // the mean of the valid center patches, is not CA: subtract it.
        let bias = |o: &[[Option<[f64; 2]>; 2]], c: usize| {
            let v: Vec<[f64; 2]> = patches
                .iter()
                .zip(o)
                .filter(|((region, _), _)| *region == 4)
                .filter_map(|(_, m)| m[c])
                .collect();
            if v.is_empty() {
                return [0., 0.];
            }
            let n = v.len() as f64;
            [
                v.iter().map(|d| d[0]).sum::<f64>() / n,
                v.iter().map(|d| d[1]).sum::<f64>() / n,
            ]
        };
        let (mut sum_on, mut sum_off, mut n) = (0., 0., 0);
        for (c, label) in ["red", "blue"].iter().enumerate() {
            let (bon, boff) = (bias(&on, c), bias(&off, c));
            println!(
                "{} {label} center bias: corrected {bon:.3?} uncorrected {boff:.3?}",
                name(&path)
            );
            for (i, (region, p)) in patches.iter().enumerate() {
                if *region == 4 {
                    continue;
                }
                let a = on[i][c].map(|a| [a[0] - bon[0], a[1] - bon[1]]);
                let b = off[i][c].map(|b| [b[0] - boff[0], b[1] - boff[1]]);
                println!(
                    "{} corner {region} {p:?} {label} (bias subtracted): corrected {a:.3?} uncorrected {b:.3?}",
                    name(&path),
                );
                if let (Some(a), Some(b)) = (a, b) {
                    sum_on += a[0].hypot(a[1]);
                    sum_off += b[0].hypot(b[1]);
                    n += 1;
                    corners[c].insert(*region);
                }
            }
        }
        let covered = corners.iter().all(|s| s.len() >= min_corners);
        let (on, off) = (sum_on / n.max(1) as f64, sum_off / n.max(1) as f64);
        println!(
            "{}: mean |offset| corrected {on:.3} px uncorrected {off:.3} px over {n} pairs; \
             corners with pairs: red {:?} blue {:?} (need {min_corners} each)",
            name(&path),
            corners[0],
            corners[1]
        );
        let passed = n > 0 && (on <= 0.6 * off || (off < 0.25 && on < 0.25));
        if covered && n > 0 && on <= 0.6 * off {
            improved += 1;
        }
        results.push((name(&path), covered, passed));
    }
    // The A7 II must be covered and pass. A sample below the coverage limit
    // is not measurable; that is allowed only when the other sample passes
    // with full coverage. `results[1]` is the A7 II.
    let full = |(_, covered, passed): &(String, bool, bool)| *covered && *passed;
    for (i, r) in results.iter().enumerate() {
        let other = &results[1 - i];
        match (r.1, r.2) {
            (true, true) => {}
            (true, false) => failures.push(format!("{}: CA not reduced enough", r.0)),
            (false, _) if i == 1 => failures.push(format!("{}: too few corners", r.0)),
            (false, _) if full(other) => println!("{}: not measurable (too few corners)", r.0),
            (false, _) => failures.push(format!("{}: too few corners", r.0)),
        }
    }
    if improved == 0 {
        failures.push("no covered sample shows a 0.6x CA improvement".into());
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The render luminance `y` through the camera's tone curve. The curve is
/// a lookup table from render to JPEG linear luminance, fitted on the
/// pixels of the central 40% (where vignetting is close to 0), in
/// quarter-stop bins. A JPEG linearized with the sRGB curve still has the
/// camera's contrast curve, which darkens dark corners.
fn tone_map(y: &Plane, jpeg: &[f32]) -> Vec<f32> {
    const BINS: usize = 64;
    let bin = |v: f32| ((v.max(1e-6).log2() + 14.) * 4.).clamp(0., (BINS - 1) as f32);
    let mut sum = [0f64; BINS];
    let mut count = [0usize; BINS];
    for py in y.h * 3 / 10..y.h * 7 / 10 {
        for px in y.w * 3 / 10..y.w * 7 / 10 {
            let b = bin(y.at(px, py)).round() as usize;
            sum[b] += f64::from(jpeg[py * y.w + px]);
            count[b] += 1;
        }
    }
    let known: Vec<(f32, f32)> = (0..BINS)
        .filter(|b| count[*b] >= 20)
        .map(|b| (b as f32, (sum[b] / count[b] as f64) as f32))
        // Monotone: each value is at least the one before it.
        .scan(0f32, |top, (b, v)| {
            *top = top.max(v);
            Some((b, *top))
        })
        .collect();
    assert!(known.len() >= 8, "too few tone curve bins: {}", known.len());
    let map = |v: f32| {
        let b = bin(v);
        match known.iter().position(|k| k.0 >= b) {
            Some(0) => known[0].1,
            None => known[known.len() - 1].1,
            Some(i) => {
                let (a, c) = (known[i - 1], known[i]);
                a.1 + (c.1 - a.1) * (b - a.0) / (c.0 - a.0)
            }
        }
    };
    y.v.iter().map(|v| map(*v)).collect()
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7"]
fn vignetting_matches_camera_jpeg() {
    // The plan's rule compares with the camera JPEG. It cannot pass with
    // these samples: neither camera JPEG shows shading compensation,
    // although SubIFD 0x7031 is 257 on both. Tone-matched, the RX100 JPEG
    // matches the render without the GainMap within 0.1% (with it: +14%),
    // the A7 II JPEG within 8% (with it: +49%). So the test checks the
    // shipped GainMap against the darktable model on the real files, and
    // only prints the camera JPEG comparison.
    let mut failures = Vec::new();
    for var in [RX100, A7] {
        let path = sample(var);
        for (corner, (model, measured)) in vignetting_gain(&path).into_iter().enumerate() {
            let error = measured / model - 1.;
            println!(
                "{} corner {corner}: corrected/control corner-to-center {measured:.4}, model {model:.4} ({:+.2}%)",
                name(&path),
                error * 100.
            );
            if error.abs() > 0.03 {
                failures.push(format!(
                    "{} corner {corner}: {measured} vs {model}",
                    name(&path)
                ));
            }
        }
        vignetting(&path);
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Linear interpolation of Sony knot values at radii `i / (n - 1)`: the
/// first value below the first knot, the last above the last.
fn sony_curve(values: &[f64], r: f64) -> f64 {
    let n = values.len();
    let f = (r * (n - 1) as f64).clamp(0., (n - 1) as f64);
    let i = (f as usize).min(n - 2);
    values[i] + (values[i + 1] - values[i]) * (f - i as f64)
}

/// Per corner box, the corner-to-center ratio of the darktable model gain
/// and of the measured gain (half-size render with the vignetting GainMap
/// over the control without it, both with the lens Warp). The GainMap
/// applies before the Warp, so a pixel at output radius r has the gain of
/// its source radius `(r / k) f(r / k)`, with the fill zoom k. Model gain:
/// `1 / max(v, 1e-4)`, `v = 2^(0.5 - 2^(p 2^-13 - 1))` at the knots, linear
/// between knots. Both ratios weight each pixel by the control luminance,
/// so the scene content cancels.
fn vignetting_gain(path: &Path) -> [(f64, f64); 4] {
    let tags = x3f_dng::lens_tags(path, &AtomicBool::new(false)).unwrap();
    let values = |params: &[i16], n: usize, at: usize, map: &dyn Fn(f64) -> f64| {
        params[at..at + n]
            .iter()
            .map(|p| map(f64::from(*p)))
            .collect::<Vec<_>>()
    };
    let vn = tags.vignetting_params[0] as usize;
    let v = values(&tags.vignetting_params, vn, 1, &|p| {
        2f64.powf(0.5 - 2f64.powf(p * 2f64.powi(-13) - 1.))
    });
    let distortion = matches!(tags.distortion, 1 | 17).then(|| {
        let n = tags.distortion_params[0] as usize;
        values(&tags.distortion_params, n, 1, &|p| 1. + p * 2f64.powi(-14))
    });
    let cn = tags.ca_params[0] as usize / 2;
    let ca = (tags.ca == 1).then(|| {
        let f = |p| 1. + p * 2f64.powi(-21);
        [
            values(&tags.ca_params, cn, 1, &f),
            values(&tags.ca_params, cn, 1 + cn, &f),
        ]
    });
    let dist = |r: f64| distortion.as_ref().map_or(1., |d| sony_curve(d, r));
    let corrected = scene_with(path, true, true, true);
    let control = scene_with(path, true, true, false);
    let (w, h) = (control.width, control.height);
    let (cx, cy) = (w as f64 / 2., h as f64 / 2.);
    let m = cx.hypot(cy);
    // The fill zoom: the smallest k >= 1 with f_p(r / k) <= k on the border
    // for every plane (fixed-point iteration; lens.rs uses bisection).
    let factor = |r: f64| {
        let d = dist(r);
        ca.as_ref().map_or(d, |[red, blue]| {
            d * sony_curve(red, r).max(sony_curve(blue, r)).max(1.)
        })
    };
    let border: Vec<f64> = (0..=256)
        .flat_map(|i| {
            let t = i as f64 / 256.;
            [(t * w as f64, 0.), (0., t * h as f64)]
        })
        .map(|(x, y)| (x - cx).hypot(y - cy) / m)
        .collect();
    let mut k = 1f64;
    for _ in 0..50 {
        k = border.iter().map(|r| factor(r / k)).fold(1., f64::max);
    }
    println!("{}: fill zoom k {k:.6}", name(path));
    let boxed = |[x0, y0, x1, y1]: [f64; 4]| {
        let (mut ctrl, mut corr, mut model) = (0f64, 0f64, 0f64);
        for y in (y0 * h as f64) as usize..(y1 * h as f64) as usize {
            for x in (x0 * w as f64) as usize..(x1 * w as f64) as usize {
                let i = (y * w + x) * 3;
                let lc = f64::from(luma([
                    control.data[i],
                    control.data[i + 1],
                    control.data[i + 2],
                ]));
                let lv = f64::from(luma([
                    corrected.data[i],
                    corrected.data[i + 1],
                    corrected.data[i + 2],
                ]));
                let r = (x as f64 + 0.5 - cx).hypot(y as f64 + 0.5 - cy) / m;
                let source = r / k * dist(r / k);
                ctrl += lc;
                corr += lv;
                model += lc / sony_curve(&v, source).max(1e-4);
            }
        }
        (model / ctrl, corr / ctrl)
    };
    let (model_center, measured_center) = boxed(CENTER);
    CORNERS.map(|b| {
        let (model, measured) = boxed(b);
        (model / model_center, measured / measured_center)
    })
}

/// Mean corner-to-center ratio of the camera JPEG, of the corrected render,
/// and of the control: the render with the lens Warp but without the
/// vignetting GainMap, so that both renders show the same content in the
/// corner boxes. The ratio is tone-matched: the render luminance goes
/// through the camera tone curve (`tone_map`, fitted on the middle 40%).
/// The plan's plain linear-light ratios are printed too.
fn vignetting(path: &Path) -> (f64, f64, f64) {
    let jpeg = camera_jpeg(path);
    let rect = content_rect(&jpeg);
    let reference = jpeg_linear(&jpeg, rect);
    let [_, _, w, h] = rect;
    let jy: Vec<f32> = reference.iter().map(|p| luma(*p)).collect();
    let mean4 = |r: [f64; 4]| r.iter().sum::<f64>() / 4.;
    let gray3 = |y: &[f32]| y.iter().map(|v| [*v; 3]).collect::<Vec<_>>();
    let target = corner_ratios(&reference, w, h);
    println!(
        "{}: jpeg corner/center {target:.4?} mean {:.4}",
        name(path),
        mean4(target)
    );
    let ratio = |label: &str, vignetting: bool| {
        let s = shown(path, scene_with(path, true, true, vignetting));
        let gain = exposure_match(&s, &reference);
        let linear = corner_ratios(&scene_linear(&s, gain), s.width, s.height);
        let y = Plane {
            w: s.width,
            h: s.height,
            v: s.data.as_chunks::<3>().0.iter().map(|p| luma(*p)).collect(),
        };
        let toned = corner_ratios(&gray3(&tone_map(&resize_area(&y, w, h), &jy)), w, h);
        let (l, t) = (mean4(linear), mean4(toned));
        println!(
            "  {label}: tone-matched {t:.4} ({:+.1}%) {toned:.4?}; linear {l:.4} ({:+.1}%) {linear:.4?}",
            (t / mean4(target) - 1.) * 100.,
            (l / mean4(target) - 1.) * 100.
        );
        t
    };
    let on = ratio("corrected", true);
    let control = ratio("control (Warp only)", false);
    (mean4(target), on, control)
}

#[test]
#[ignore = "needs X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2, X3FUSE_TEST_RW2_B"]
fn lens_tags_match_samples() {
    let cancel = AtomicBool::new(false);
    let tags = |var| {
        let t = x3f_dng::lens_tags(&sample(var), &cancel).unwrap();
        println!("{var}: {t:?}");
        t
    };

    let rx = tags(RX100);
    assert_eq!((rx.vignetting, rx.ca, rx.distortion), (257, 1, 17));
    assert!(rx.has_vignetting != 0 && rx.has_ca != 0 && rx.has_distortion != 0);
    assert_eq!(
        (rx.vignetting_count, rx.ca_count, rx.distortion_count),
        (17, 33, 17)
    );
    assert_eq!(
        rx.vignetting_params,
        [16, 0, 0, 0, 27, 95, 217, 405, 656, 970, 1343, 1772, 2255, 2788, 3365, 3986, 4645]
    );
    assert_eq!(
        rx.ca_params,
        [
            22, 0, 0, 256, 128, 128, 384, 512, 768, 1024, 1152, 1280, 0, 1408, 1408, 1408, 1152,
            896, 640, 384, 256, 128, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        ]
    );
    assert_eq!(
        rx.distortion_params,
        [11, 1265, 1218, 1083, 860, 562, 209, -179, -580, -972, -1353, -1725, 0, 0, 0, 0, 0]
    );
    assert_eq!(rx.has_panasonic, 0);

    let a7 = tags(A7);
    assert_eq!((a7.vignetting, a7.ca, a7.distortion), (257, 1, 0));
    assert!(a7.has_vignetting != 0 && a7.has_ca != 0 && a7.has_distortion != 0);
    assert_eq!(
        (a7.vignetting_count, a7.ca_count, a7.distortion_count),
        (17, 33, 17)
    );
    assert_eq!(
        a7.vignetting_params,
        [
            16, 0, 48, 176, 400, 688, 1056, 1504, 2016, 2608, 3312, 4080, 4880, 5680, 6496, 7280,
            8096
        ]
    );
    assert_eq!(
        a7.ca_params,
        [
            32, -384, -384, -384, -384, -256, -256, -128, -128, -128, 0, 0, 128, 128, 256, 256,
            384, 896, 896, 896, 896, 896, 896, 896, 896, 896, 768, 640, 512, 512, 384, 256, 256
        ]
    );
    assert_eq!(
        a7.distortion_params,
        [16, 0, 0, 0, 4, 7, 13, 22, 36, 54, 79, 111, 151, 198, 255, 323, 406]
    );
    assert_eq!(a7.has_panasonic, 0);

    // Panasonic tag 0x119 as 16 little-endian int16 values (ExifTool -v3).
    // ExifTool names value i "Param i": DistortionParam02 = v[2],
    // DistortionParam04 = v[4], DistortionScale = 1 / (1 + v[5] / 32768),
    // DistortionCorrection = v[7] & 0x0f, DistortionParam08 = v[8],
    // DistortionParam09 = v[9], DistortionParam11 = v[11]; params are v / 32768.
    for (var, expected, params) in [
        (
            RW2,
            [
                -9291, 29877, 74, 619, -432, -32, 80, -4095, 3821, 456, 434, -138, 3240, 956,
                29694, -31271,
            ],
            [
                0.002_258_300_781_25,
                -0.013_183_593_75,
                1.000_977_517_106_55,
                0.116_607_666_015_625,
                -0.004_211_425_781_25,
            ],
        ),
        (
            RW2_B,
            [
                -1729, -24072, 189, 0, -560, 0, 565, 1, 1767, 116, 434, 81, 3240, 616, 20114,
                -13636,
            ],
            [
                0.005_767_822_265_625,
                -0.017_089_843_75,
                1.,
                0.053_924_560_546_875,
                0.002_471_923_828_125,
            ],
        ),
    ] {
        let t = tags(var);
        assert_ne!(t.has_panasonic, 0);
        assert_eq!(t.panasonic, expected, "{var}");
        let v = t.panasonic.map(|v| f64::from(v) / 32768.);
        assert_eq!(t.panasonic[7] & 0x0f, 1, "{var}: DistortionCorrection On");
        let scale = 1. / (1. + v[5]);
        let got = [v[2], v[4], scale, v[8], v[11]];
        for (g, e) in got.iter().zip(&params) {
            assert!((g - e).abs() < 1e-9, "{var}: {got:?} vs {params:?}");
        }
        assert_eq!(
            (t.has_vignetting, t.has_ca, t.has_distortion),
            (0, 0, 0),
            "{var}"
        );
    }
}
