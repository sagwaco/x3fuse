//! Sony ARW and Panasonic RW2 lens corrections from the camera's own tags.
//! See `_local/RAW_FORMATS_PLAN.md` task 6. The tag formulas come from
//! darktable `src/common/exif.cc` and `src/iop/lens.cc`
//! (GPL-3.0-or-later). See NOTICE.

use crate::ffi;
use crate::opcode::{radial, GainMap, Opcode, Plane, Warp};

/// The radius of Sony knot `i` of `n`. True: darktable v2, `(i + 0.5) / (n - 1)`.
/// False: `i / (n - 1)`.
pub(crate) const SONY_HALF_KNOT: bool = false;
/// The exponent of the vignetting gain `1 / v`. 2 gives the squared gain.
pub(crate) const VIGNETTING_EXPONENT: i32 = 1;

/// Values in a warp table, at radii from 0 to 1.
const TABLE: usize = 1025;
/// The fill zoom range. A value below 1 would let a barrel correction
/// zoom out to the camera framing; the plan keeps 1.
const MIN_ZOOM: f64 = 1.;
const MAX_ZOOM: f64 = 1.5;
/// Fill test samples per image edge.
const BORDER: usize = 256;
/// Grid points per side of the vignetting GainMap.
const GRID: u32 = 33;

/// The opcodes to append to OpcodeList3 of a non-DNG file: an optional
/// vignetting GainMap, then an optional Warp for distortion and CA.
/// `width` and `height` are the full-size active area before DefaultScale.
/// A DNG (`dng` true) gets none. Invalid tags give no correction.
pub(crate) fn opcodes(tags: &ffi::Lens, dng: bool, width: usize, height: usize) -> Vec<Opcode> {
    if dng || width < 2 || height < 2 || u32::try_from(width.max(height)).is_err() {
        return Vec::new();
    }
    let lens = Corrections::of(tags);
    let mut out = Vec::new();
    if let Some(v) = &lens.vignetting {
        out.push(Opcode::Gain(gain_map(v, width, height)));
    }
    if let Some(warp) = lens.warp(width as f64, height as f64) {
        out.push(Opcode::Warp(warp));
    }
    out
}

/// A radial curve. The radius is 1 at the image corner.
#[derive(Clone, Debug, PartialEq)]
enum Curve {
    /// Sony knot values. See `SONY_HALF_KNOT`.
    Sony(Vec<f64>),
    /// Values at radii `i / (len - 1)`.
    Uniform(Vec<f64>),
}

impl Curve {
    /// Linear between knots; the first or last value outside them.
    fn at(&self, r: f64) -> f64 {
        match self {
            Curve::Uniform(values) => radial(values, r),
            Curve::Sony(values) => sony_at(values, r, SONY_HALF_KNOT),
        }
    }
}

/// Sony knots, linear between knots. `half` selects the knot radius
/// `(i + 0.5) / (n - 1)`, else `i / (n - 1)`.
fn sony_at(values: &[f64], r: f64, half: bool) -> f64 {
    let n = values.len();
    let knot = |i: usize| (i as f64 + if half { 0.5 } else { 0. }) / (n - 1) as f64;
    match (1..n).find(|&i| r < knot(i)) {
        None => values[n - 1],
        Some(i) => {
            let t = ((r - knot(i - 1)) / (knot(i) - knot(i - 1))).max(0.);
            values[i - 1] + (values[i] - values[i - 1]) * t
        }
    }
}

/// The valid corrections of one photo.
#[derive(Debug, PartialEq)]
struct Corrections {
    /// Source radius factor of all planes.
    distortion: Option<Curve>,
    /// Source radius factors of the red and blue planes.
    ca: Option<[Curve; 2]>,
    /// Relative brightness `v`. The gain is `1 / v`.
    vignetting: Option<Curve>,
}

impl Corrections {
    fn of(t: &ffi::Lens) -> Self {
        let distortion = sony(
            t.has_distortion != 0 && matches!(t.distortion, 1 | 17),
            t.distortion_count,
            &t.distortion_params,
            1,
            |p| 1. + p * 2f64.powi(-14),
        )
        .map(|mut v| Curve::Sony(v.remove(0)))
        .or_else(|| panasonic(t));
        let ca = sony(
            t.has_ca != 0 && t.ca == 1,
            t.ca_count,
            &t.ca_params,
            2,
            |p| 1. + p * 2f64.powi(-21),
        )
        .map(|mut v| {
            let blue = Curve::Sony(v.remove(1));
            [Curve::Sony(v.remove(0)), blue]
        });
        let vignetting = sony(
            t.has_vignetting != 0 && matches!(t.vignetting, 257 | 272),
            t.vignetting_count,
            &t.vignetting_params,
            1,
            |p| 2f64.powf(0.5 - 2f64.powf(p * 2f64.powi(-13) - 1.)),
        )
        .map(|mut v| Curve::Sony(v.remove(0)));
        Corrections {
            distortion,
            ca,
            vignetting,
        }
    }

    /// Distortion and CA with the fill zoom folded in. If no zoom fills the
    /// frame, the distortion part is dropped, then the CA part.
    fn warp(&self, width: f64, height: f64) -> Option<Warp> {
        for distortion in [self.distortion.as_ref(), None] {
            if distortion.is_none() && self.ca.is_none() {
                return None;
            }
            let factor = |p: usize, r: f64| {
                distortion.map_or(1., |c| c.at(r))
                    * match (&self.ca, p) {
                        (Some(ca), 0) => ca[0].at(r),
                        (Some(ca), 2) => ca[1].at(r),
                        _ => 1.,
                    }
            };
            // Output radius r reads source radius (r / k) f(r / k).
            let zoomed = |k: f64| Warp {
                planes: (0..3)
                    .map(|p| {
                        Plane::Radial(
                            (0..TABLE)
                                .map(|i| factor(p, i as f64 / (TABLE - 1) as f64 / k) / k)
                                .collect(),
                        )
                    })
                    .collect(),
                center: [0.5, 0.5],
            };
            if let Some(k) = fill(|k| inside(&zoomed(k), width, height)) {
                return Some(zoomed(k));
            }
            // ponytail: x3f-dng has no log crate, so this goes to stderr.
            eprintln!(
                "x3f-dng: no fill zoom in [{MIN_ZOOM}, {MAX_ZOOM}]; {} correction skipped",
                if distortion.is_some() {
                    "distortion"
                } else {
                    "CA"
                }
            );
            distortion?;
        }
        None
    }
}

/// The knot values of a Sony table, split in `groups` of `n`, or None if the
/// flag is off or the table is invalid. `params[0]` holds `groups * n`, and
/// `count` is the number of int16 values read, the header included.
fn sony(
    on: bool,
    count: u32,
    params: &[i16],
    groups: usize,
    value: impl Fn(f64) -> f64,
) -> Option<Vec<Vec<f64>>> {
    let total = usize::try_from(*params.first()?).ok()?;
    let n = total / groups;
    if !on
        || total % groups != 0
        || !(2..=16).contains(&n)
        || (count as usize).min(params.len()) <= total
    {
        return None;
    }
    let values: Vec<f64> = params[1..=total].iter().map(|p| value(*p as f64)).collect();
    valid(&values).then(|| values.chunks(n).map(<[f64]>::to_vec).collect())
}

/// Panasonic distortion, as a source radius factor `Rd / Ru` at uniform radii.
fn panasonic(t: &ffi::Lens) -> Option<Curve> {
    if t.has_panasonic == 0 || t.panasonic[7] & 0x0f != 1 {
        return None;
    }
    let v = t.panasonic.map(f64::from);
    let scale = 1. / (1. + v[5] / 32768.);
    let (a, b, c) = (v[8] / 32768., v[4] / 32768., v[11] / 32768.);
    // Ru = Rd (1 + gain(Rd)) = Rd + scale (a Rd^3 + b Rd^5 + c Rd^7).
    let gain = |rd: f64| {
        let q = rd * rd;
        scale * q * (a + q * (b + q * c))
    };
    let slope = |rd: f64| {
        let q = rd * rd;
        1. + scale * q * (3. * a + q * (5. * b + 7. * c * q))
    };
    if !scale.is_finite() || !(0..=1200).all(|i| slope(i as f64 / 1000.) > 0.) {
        return None;
    }
    let table = (0..TABLE)
        .map(|i| {
            let r = i as f64 / (TABLE - 1) as f64;
            if i == 0 {
                return Some(1.);
            }
            let mut rd = r;
            for _ in 0..20 {
                let next = r / (1. + gain(rd));
                let done = (next - rd).abs() < 1e-9;
                rd = next;
                if done {
                    break;
                }
            }
            ((rd * (1. + gain(rd)) - r).abs() < 1e-6).then_some(rd / r)
        })
        .collect::<Option<Vec<f64>>>()?;
    valid(&table).then_some(Curve::Uniform(table))
}

fn valid(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite() && *v > 0.)
}

/// The smallest zoom in [MIN_ZOOM, MAX_ZOOM] that `fits`, by bisection.
fn fill(fits: impl Fn(f64) -> bool) -> Option<f64> {
    if fits(MIN_ZOOM) {
        return Some(MIN_ZOOM);
    }
    if !fits(MAX_ZOOM) {
        return None;
    }
    let (mut lo, mut hi) = (MIN_ZOOM, MAX_ZOOM);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.;
        if fits(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Some(hi)
}

/// True if every border sample of every plane reads inside the image.
fn inside(warp: &Warp, w: f64, h: f64) -> bool {
    let geometry = warp.geometry(w, h);
    let at = |i: usize, len: f64| 0.5 + (len - 1.) * i as f64 / (BORDER - 1) as f64;
    let ok = |v: f64, len: f64| (0.5 - 1e-9..=len - 0.5 + 1e-9).contains(&v);
    (0..BORDER)
        .flat_map(|i| {
            [
                (at(i, w), 0.5),
                (at(i, w), h - 0.5),
                (0.5, at(i, h)),
                (w - 0.5, at(i, h)),
            ]
        })
        .all(|(x, y)| {
            (0..3).all(|p| {
                let (sx, sy) = warp.source(p, x, y, &geometry);
                ok(sx, w) && ok(sy, h)
            })
        })
}

/// A GainMap of `1 / v` over the full active area. The rectangle is in
/// pixels; the grid origin and spacing are relative to the image size.
fn gain_map(v: &Curve, width: usize, height: usize) -> GainMap {
    let n = GRID as usize;
    let (w, h) = (width as f64, height as f64);
    let half = (w / 2.).hypot(h / 2.);
    let gains = (0..n * n)
        .flat_map(|i| {
            let row = (i / n) as f64 / (n - 1) as f64;
            let col = (i % n) as f64 / (n - 1) as f64;
            let r = ((col - 0.5) * w).hypot((row - 0.5) * h) / half;
            [(1. / v.at(r).max(1e-4)).powi(VIGNETTING_EXPONENT) as f32; 3]
        })
        .collect();
    GainMap {
        top: 0,
        left: 0,
        bottom: height as u32,
        right: width as u32,
        plane: 0,
        planes: 3,
        row_pitch: 1,
        col_pitch: 1,
        points: [GRID; 2],
        spacing: [1. / (n - 1) as f64; 2],
        origin: [0.; 2],
        map_planes: 3,
        gains,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RX100_VIG: [i16; 17] = [
        16, 0, 0, 0, 27, 95, 217, 405, 656, 970, 1343, 1772, 2255, 2788, 3365, 3986, 4645,
    ];
    const RX100_CA: [i16; 33] = [
        22, 0, 0, 256, 128, 128, 384, 512, 768, 1024, 1152, 1280, 0, 1408, 1408, 1408, 1152, 896,
        640, 384, 256, 128, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    const RX100_DIST: [i16; 17] = [
        11, 1265, 1218, 1083, 860, 562, 209, -179, -580, -972, -1353, -1725, 0, 0, 0, 0, 0,
    ];
    const A7_VIG: [i16; 17] = [
        16, 0, 48, 176, 400, 688, 1056, 1504, 2016, 2608, 3312, 4080, 4880, 5680, 6496, 7280, 8096,
    ];
    const A7_CA: [i16; 33] = [
        32, -384, -384, -384, -384, -256, -256, -128, -128, -128, 0, 0, 128, 128, 256, 256, 384,
        896, 896, 896, 896, 896, 896, 896, 896, 896, 768, 640, 512, 512, 384, 256, 256,
    ];
    const A7_DIST: [i16; 17] = [
        16, 0, 0, 0, 4, 7, 13, 22, 36, 54, 79, 111, 151, 198, 255, 323, 406,
    ];
    const GX9_12MM: [i16; 16] = [
        -9291, 29877, 74, 619, -432, -32, 80, -4095, 3821, 456, 434, -138, 3240, 956, 29694, -31271,
    ];
    const GX9_19MM: [i16; 16] = [
        -1729, -24072, 189, 0, -560, 0, 565, 1, 1767, 116, 434, 81, 3240, 616, 20114, -13636,
    ];

    fn sony_tags(flags: [i16; 3], vig: &[i16], ca: &[i16], dist: &[i16]) -> ffi::Lens {
        let mut t = panasonic_tags([0; 16]);
        t.has_panasonic = 0;
        (t.has_vignetting, t.has_ca, t.has_distortion) = (1, 1, 1);
        [t.vignetting, t.ca, t.distortion] = flags;
        t.vignetting_count = vig.len() as u32;
        t.ca_count = ca.len() as u32;
        t.distortion_count = dist.len() as u32;
        t.vignetting_params[..vig.len()].copy_from_slice(vig);
        t.ca_params[..ca.len()].copy_from_slice(ca);
        t.distortion_params[..dist.len()].copy_from_slice(dist);
        t
    }

    fn panasonic_tags(v: [i16; 16]) -> ffi::Lens {
        ffi::Lens {
            has_vignetting: 0,
            has_ca: 0,
            has_distortion: 0,
            vignetting: 0,
            ca: 0,
            distortion: 0,
            vignetting_count: 0,
            ca_count: 0,
            distortion_count: 0,
            vignetting_params: [0; 17],
            ca_params: [0; 33],
            distortion_params: [0; 17],
            has_panasonic: 1,
            panasonic: v,
        }
    }

    fn rx100() -> ffi::Lens {
        sony_tags([257, 1, 17], &RX100_VIG, &RX100_CA, &RX100_DIST)
    }

    fn a7() -> ffi::Lens {
        sony_tags([257, 1, 0], &A7_VIG, &A7_CA, &A7_DIST)
    }

    /// The red and blue displacement against green, in full-size pixels, at
    /// a full-size position: `(p - c) (f_plane(r / k) - f_green(r / k)) / k`.
    fn predicted_ca(
        c: &Corrections,
        k: f64,
        size: [f64; 2],
        at: [f64; 2],
        half: bool,
    ) -> [[f64; 2]; 2] {
        let center = size.map(|s| s / 2.);
        let m = center[0].hypot(center[1]);
        let d = [at[0] - center[0], at[1] - center[1]];
        let r = d[0].hypot(d[1]) / m / k;
        let [red, blue] = c.ca.as_ref().unwrap().clone().map(|curve| match curve {
            Curve::Sony(v) => sony_at(&v, r, half),
            Curve::Uniform(v) => radial(&v, r),
        });
        let green = c.distortion.as_ref().map_or(1., |g| g.at(r));
        [red, blue].map(|f| d.map(|v| v * (f - green) / k))
    }

    #[test]
    fn a7_ca_warp_moves_planes_as_the_knots_predict() {
        // Opcodes for the full-size active area, applied to a quarter-size
        // image: the geometry is relative, so the same Warp serves both.
        let (w, h, scale) = (6024usize, 4024usize, 4usize);
        let ops = opcodes(&a7(), false, w, h);
        let warp = warp_of(&ops).clone();
        let Plane::Radial(green) = &warp.planes[1] else {
            panic!("no radial table");
        };
        // A7 II has no distortion, so the green table is 1 / k.
        let k = 1. / green[0];
        let c = Corrections::of(&a7());
        let (qw, qh) = (w / scale, h / scale);
        // Bilinear sampling of a linear ramp gives the source coordinate.
        let mut moved = Vec::new();
        for axis in 0..2 {
            let mut image: Vec<f32> = (0..qw * qh)
                .flat_map(|i| [[(i % qw) as f32, (i / qw) as f32][axis]; 3])
                .collect();
            let mut mask = vec![0u8; qw * qh];
            Opcode::Warp(warp.clone()).apply(&mut image, &mut mask, qw, qh, 3, 1);
            moved.push(image);
        }
        for fx in [0.05, 0.95] {
            for fy in [0.05, 0.95] {
                let (x, y) = ((fx * qw as f64) as usize, (fy * qh as f64) as usize);
                let o = (y * qw + x) * 3;
                let at = [
                    (x as f64 + 0.5) * scale as f64,
                    (y as f64 + 0.5) * scale as f64,
                ];
                let want = predicted_ca(&c, k, [w as f64, h as f64], at, SONY_HALF_KNOT);
                for (plane, want) in [(0, want[0]), (2, want[1])] {
                    let got = [0, 1]
                        .map(|a| (moved[a][o + plane] - moved[a][o + 1]) as f64 * scale as f64);
                    for a in 0..2 {
                        assert!(
                            (got[a] - want[a]).abs() < 0.01,
                            "plane {plane} at {at:?}: got {got:?}, want {want:?}"
                        );
                    }
                }
            }
        }
    }

    fn values(c: &Option<Curve>) -> Vec<f64> {
        match c {
            Some(Curve::Sony(v) | Curve::Uniform(v)) => v.clone(),
            None => panic!("no curve"),
        }
    }

    fn kinds(ops: &[Opcode]) -> Vec<&'static str> {
        ops.iter()
            .map(|op| match op {
                Opcode::Gain(_) => "gain",
                Opcode::Warp(_) => "warp",
            })
            .collect()
    }

    fn warp_of(ops: &[Opcode]) -> &Warp {
        ops.iter()
            .find_map(|op| match op {
                Opcode::Warp(w) => Some(w),
                Opcode::Gain(_) => None,
            })
            .expect("a warp")
    }

    #[test]
    fn sony_knots_decode() {
        let c = Corrections::of(&rx100());
        let dist = values(&c.distortion);
        assert_eq!(dist.len(), 11);
        assert_eq!(dist[0], 1. + 1265. / 16384.);
        assert_eq!(dist[10], 1. - 1725. / 16384.);
        let [red, blue] = c.ca.clone().unwrap();
        let (red, blue) = (values(&Some(red)), values(&Some(blue)));
        assert_eq!(red.len(), 11);
        assert_eq!(red[2], 1. + 256. / 2097152.);
        assert_eq!(blue[0], 1.);
        assert_eq!(blue[1], 1. + 1408. / 2097152.);
        assert_eq!(blue[10], 1. + 128. / 2097152.);
        let vig = values(&c.vignetting);
        assert_eq!(vig.len(), 16);
        assert_eq!(vig[0], 1.);
        assert!((vig[15] - 2f64.powf(0.5 - 2f64.powf(4645. / 8192. - 1.))).abs() < 1e-15);
        // RX100: 16 vignetting knots and 11 distortion knots give both opcodes.
        assert_eq!(
            kinds(&opcodes(&rx100(), false, 5504, 3672)),
            ["gain", "warp"]
        );
    }

    #[test]
    fn camera_flags_select_corrections() {
        for off in [511, 256, 0] {
            let t = sony_tags([off, 1, 17], &RX100_VIG, &RX100_CA, &RX100_DIST);
            assert_eq!(kinds(&opcodes(&t, false, 5504, 3672)), ["warp"]);
        }
        let mut t = rx100();
        t.has_vignetting = 0;
        assert!(Corrections::of(&t).vignetting.is_none());
        // A7 II: distortion is off, CA and vignetting are on.
        let c = Corrections::of(&a7());
        assert!(c.distortion.is_none());
        assert!(c.ca.is_some() && c.vignetting.is_some());
        assert_eq!(kinds(&opcodes(&a7(), false, 6048, 4024)), ["gain", "warp"]);
        // No correction on a DNG.
        assert!(opcodes(&rx100(), true, 5504, 3672).is_empty());
        assert!(opcodes(&panasonic_tags(GX9_12MM), true, 5184, 3888).is_empty());
        // Panasonic flag off.
        let mut v = GX9_19MM;
        v[7] = 0;
        assert!(opcodes(&panasonic_tags(v), false, 5184, 3888).is_empty());
        assert_eq!(
            kinds(&opcodes(&panasonic_tags(GX9_19MM), false, 5184, 3888)),
            ["warp"]
        );
    }

    #[test]
    fn bad_counts_give_no_correction() {
        let header = |n: i16, rest: &[i16]| [&[n][..], rest].concat();
        let knots = [100i16; 16];
        for dist in [
            header(0, &knots),
            header(1, &knots),
            header(17, &knots),
            header(-4, &knots),
            header(11, &knots[..5]),
            vec![],
        ] {
            let t = sony_tags([0, 0, 17], &[], &[], &dist);
            assert!(opcodes(&t, false, 600, 400).is_empty(), "{dist:?}");
        }
        for ca in [
            header(21, &[100; 32]),
            header(2, &[100; 2]),
            header(22, &[100; 10]),
        ] {
            let t = sony_tags([0, 1, 0], &[], &ca, &[]);
            assert!(opcodes(&t, false, 600, 400).is_empty(), "{ca:?}");
        }
        let mut t = rx100();
        t.vignetting_count = 16;
        assert!(Corrections::of(&t).vignetting.is_none());
        // A count above the array length cannot read past it.
        t.vignetting_count = u32::MAX;
        assert!(Corrections::of(&t).vignetting.is_some());
        // Too small sizes.
        assert!(opcodes(&rx100(), false, 1, 400).is_empty());
    }

    #[test]
    fn nonpositive_sony_factors_give_no_correction() {
        for bad in [-16384, -20000] {
            let mut dist = RX100_DIST;
            dist[5] = bad;
            let t = sony_tags([0, 0, 17], &[], &[], &dist);
            assert!(Corrections::of(&t).distortion.is_none());
        }
    }

    #[test]
    fn ca_tables_differ_from_green() {
        let warp = warp_of(&opcodes(&rx100(), false, 5504, 3672)).clone();
        assert_eq!(warp.planes.len(), 3);
        assert_ne!(warp.planes[0], warp.planes[1]);
        assert_ne!(warp.planes[2], warp.planes[1]);
        assert_ne!(warp.planes[0], warp.planes[2]);
    }

    #[test]
    fn panasonic_inverse_round_trips() {
        let v = GX9_19MM.map(f64::from);
        let scale = 1. / (1. + v[5] / 32768.);
        let (a, b, c) = (v[8] / 32768., v[4] / 32768., v[11] / 32768.);
        let ru = |rd: f64| rd + scale * (a * rd.powi(3) + b * rd.powi(5) + c * rd.powi(7));
        let table = values(&panasonic(&panasonic_tags(GX9_19MM)));
        for (i, f) in table.iter().enumerate() {
            let r = i as f64 / (TABLE - 1) as f64;
            assert!((ru(r * f) - r).abs() < 1e-6, "r {r}");
        }
    }

    #[test]
    fn malformed_panasonic_gives_no_correction() {
        let with = |changes: &[(usize, i16)]| {
            let mut v = [0i16; 16];
            v[7] = 1;
            for (i, x) in changes {
                v[*i] = *x;
            }
            opcodes(&panasonic_tags(v), false, 600, 400)
        };
        // A zero denominator.
        assert!(with(&[(5, -32768), (8, 1000)]).is_empty());
        // Ru(Rd) falls on [0, 1.2].
        assert!(with(&[(8, -32768)]).is_empty());
        // Monotonic, but the fixed point iteration does not converge.
        assert!(with(&[(5, -32000), (8, 16384)]).is_empty());
        // Zero coefficients are an identity, not an error.
        assert_eq!(kinds(&with(&[])), ["warp"]);
    }

    #[test]
    fn fill_keeps_the_border_inside() {
        let cases = [
            (rx100(), 5504, 3672),
            (a7(), 6048, 4024),
            (panasonic_tags(GX9_12MM), 5184, 3888),
            (panasonic_tags(GX9_19MM), 5184, 3888),
        ];
        for (t, w, h) in cases {
            let warp = warp_of(&opcodes(&t, false, w, h)).clone();
            assert!(inside(&warp, w as f64, h as f64));
        }
    }

    #[test]
    fn no_fill_zoom_drops_only_distortion() {
        // A source factor near 2 needs a zoom above 1.5.
        let mut dist = [16000i16; 17];
        dist[0] = 11;
        let t = sony_tags([257, 1, 17], &RX100_VIG, &RX100_CA, &dist);
        let ops = opcodes(&t, false, 5504, 3672);
        assert_eq!(kinds(&ops), ["gain", "warp"]);
        let ca_only = opcodes(
            &sony_tags([257, 1, 0], &RX100_VIG, &RX100_CA, &[]),
            false,
            5504,
            3672,
        );
        assert_eq!(ops, ca_only);
    }

    #[test]
    fn gain_map_is_one_at_the_center_and_one_over_v_at_the_corner() {
        let v = Corrections::of(&rx100()).vignetting.unwrap();
        let corner = 1. / v.at(1.) as f32;
        assert!(corner > 1.1, "{corner}");
        let ops = opcodes(&rx100(), false, 641, 481);
        let Opcode::Gain(map) = &ops[0] else {
            panic!("no gain map");
        };
        for step in [1, 2] {
            let (w, h) = (641usize.div_ceil(step), 481usize.div_ceil(step));
            let mut image = vec![1f32; w * h * 3];
            map.apply(&mut image, w, h, 3, step);
            let center = &image[((h / 2) * w + w / 2) * 3..][..3];
            let first = &image[..3];
            let last = &image[(w * h - 1) * 3..];
            for g in center {
                assert!((g - 1.).abs() < 1e-3, "step {step} center {g}");
            }
            for g in first.iter().chain(last) {
                assert!(
                    (g / corner - 1.).abs() < 0.01,
                    "step {step} corner {g} {corner}"
                );
            }
        }
    }
}
