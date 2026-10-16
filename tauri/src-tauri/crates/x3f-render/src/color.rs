use crate::{geometry, Curves, EditRecipe, MonochromeFilter, Point, RenderError, RenderOptions};
use x3f_core::{SceneLinearImage, WhiteBalanceCalibration};

pub(crate) fn inverse(m: [f64; 9]) -> Result<[f64; 9], RenderError> {
    let d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if !d.is_finite() || d.abs() < 1e-14 {
        return Err(RenderError::Invalid(
            "Invalid camera white-balance calibration".into(),
        ));
    }
    Ok([
        (m[4] * m[8] - m[5] * m[7]) / d,
        (m[2] * m[7] - m[1] * m[8]) / d,
        (m[1] * m[5] - m[2] * m[4]) / d,
        (m[5] * m[6] - m[3] * m[8]) / d,
        (m[0] * m[8] - m[2] * m[6]) / d,
        (m[2] * m[3] - m[0] * m[5]) / d,
        (m[3] * m[7] - m[4] * m[6]) / d,
        (m[1] * m[6] - m[0] * m[7]) / d,
        (m[0] * m[4] - m[1] * m[3]) / d,
    ])
}
pub(crate) fn multiply(a: [f64; 9], b: [f64; 9]) -> [f64; 9] {
    std::array::from_fn(|i| (0..3).map(|k| a[i / 3 * 3 + k] * b[k * 3 + i % 3]).sum())
}
fn vector(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])
}
/// Collapse inverse camera calibration and a neutral-normalized BMT mix into
/// one scene-RGB dot product. B/M/T are the corrected sensor layers, not display
/// R/G/B channels; white balance and exposure may precede this linear operation.
pub(crate) fn monochrome_mix(
    cal: &WhiteBalanceCalibration,
    filter: MonochromeFilter,
) -> Result<[f32; 3], RenderError> {
    // The grayscale mixes of the x3f-core DNG Monochrome camera profiles. The
    // layers overlap in spectrum, so a filter subtracts its neighbor layers.
    // The DNG has no orange profile; orange is halfway from yellow to red.
    // Saturated colors can go below zero, and the output clips them to black.
    let weights = match filter {
        MonochromeFilter::Neutral => [1. / 3.; 3],
        MonochromeFilter::Red => [2., -1., 0.],
        MonochromeFilter::Orange => [1.75, -0.75, 0.],
        MonochromeFilter::Yellow => [1.5, -0.5, 0.],
        MonochromeFilter::Green => [-0.5, 2., -0.5],
        MonochromeFilter::Blue => [0., -1., 2.],
    };
    let inv = inverse(cal.camera_to_rgb)?;
    let neutral = vector(inv, [1.; 3]);
    if neutral.iter().any(|v| !v.is_finite() || *v <= 1e-12) {
        return Err(RenderError::Invalid(
            "Invalid camera neutral for sensor-layer monochrome".into(),
        ));
    }
    let mix = std::array::from_fn(|c| {
        (0..3)
            .map(|layer| weights[layer] / neutral[layer] * inv[layer * 3 + c])
            .sum::<f64>() as f32
    });
    if mix.iter().any(|v| !v.is_finite()) {
        return Err(RenderError::Invalid(
            "Invalid sensor-layer monochrome calibration".into(),
        ));
    }
    Ok(mix)
}
fn white_xyz(k: f64, tint: f64) -> [f64; 3] {
    // Planckian chromaticity with a signed 1960-uv offset for green/magenta.
    let x = if k <= 4000. {
        -0.2661239e9 / k.powi(3) - 0.2343580e6 / k.powi(2) + 0.8776956e3 / k + 0.179910
    } else {
        -3.0258469e9 / k.powi(3) + 2.1070379e6 / k.powi(2) + 0.2226347e3 / k + 0.240390
    };
    let y = if k <= 2222. {
        -1.1063814 * x.powi(3) - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
    } else if k <= 4000. {
        -0.9549476 * x.powi(3) - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
    } else {
        3.0817580 * x.powi(3) - 5.87338670 * x * x + 3.75112997 * x - 0.37001483
    };
    let denom = -2. * x + 12. * y + 3.;
    let u = 4. * x / denom;
    let v = 6. * y / denom + tint * 0.0001;
    let den = 2. * u - 8. * v + 4.;
    let x = 3. * u / den;
    let y = 2. * v / den;
    [x / y, 1., (1. - x - y) / y]
}
/// The normal slider range, in mired and tint.
const MIRED: [f64; 2] = [1e6 / 12000., 1e6 / 2000.];
const TINT: f64 = 100.;
/// The extended slider range: temperature in kelvin, and tint.
pub(crate) const EXTENDED_TEMPERATURE: [f32; 2] = [500., 50000.];
pub(crate) const EXTENDED_TINT: f32 = 2000.;
fn planck(cal: &WhiteBalanceCalibration, k: f64, t: f64) -> [f64; 3] {
    let n = vector(cal.xyz_to_camera, white_xyz(k, t));
    let g = n[1].max(1e-8);
    n.map(|v| (v / g).max(1e-6))
}
/// The camera neutral for slider values. Past the normal range, the log
/// neutral continues in a straight line in mired and tint from the edge.
/// No light source has the neutral of an infrared or full-spectrum photo,
/// but this line reaches it. Each line has one slope: temperature the slope
/// at zero tint, and tint the slope at 5000 K. Then the two directions stay
/// apart, and each neutral has only one pair of slider values.
fn neutral(cal: &WhiteBalanceCalibration, k: f64, t: f64) -> [f64; 3] {
    let m = 1e6 / k;
    let (mc, tc) = (m.clamp(MIRED[0], MIRED[1]), t.clamp(-TINT, TINT));
    if (m, t) == (mc, tc) {
        return planck(cal, k, t);
    }
    let log = |m: f64, t: f64| planck(cal, 1e6 / m, t).map(f64::ln);
    let mut n = log(mc, tc);
    // The slope over one step inward from the edge.
    if m != mc {
        let step = (m - mc).signum();
        let (outer, inner) = (log(mc, 0.), log(mc - step, 0.));
        for c in 0..3 {
            n[c] += (m - mc) * step * (outer[c] - inner[c]);
        }
    }
    if t != tc {
        let step = (t - tc).signum();
        let (outer, inner) = (log(200., tc), log(200., tc - step));
        for c in 0..3 {
            n[c] += (t - tc) * step * (outer[c] - inner[c]);
        }
    }
    n.map(f64::exp)
}
pub(crate) fn white_balance_matrix(
    cal: &WhiteBalanceCalibration,
    temperature: Option<f32>,
    tint: f32,
) -> Result<[f64; 9], RenderError> {
    if temperature.is_none() && tint == 0. {
        return Ok([1., 0., 0., 0., 1., 0., 0., 0., 1.]);
    }
    let target = if let Some(k) = temperature {
        neutral(cal, k as f64, tint as f64)
    } else {
        let mut n = cal.as_shot_neutral;
        n[1] *= 2f64.powf(tint as f64 / 200.);
        n
    };
    let inv = inverse(cal.camera_to_rgb)?;
    let gains = std::array::from_fn::<_, 3, _>(|i| cal.as_shot_neutral[i] / target[i]);
    if gains[1].abs() < 1e-12 {
        return Err(RenderError::Invalid(
            "Invalid white balance green gain".into(),
        ));
    }
    let mut out = [0.; 9];
    for row in 0..3 {
        for col in 0..3 {
            for i in 0..3 {
                out[row * 3 + col] +=
                    cal.camera_to_rgb[row * 3 + i] * (gains[i] / gains[1]) * inv[i * 3 + col];
            }
        }
    }
    if out.iter().any(|v| !v.is_finite()) {
        return Err(RenderError::Invalid("White balance is not finite".into()));
    }
    Ok(out)
}
/// Pick a neutral patch in normalized coordinates of the current edited output.
pub fn pick_white_balance(
    image: &SceneLinearImage,
    recipe: &EditRecipe,
    x: f32,
    y: f32,
) -> Result<(f32, f32), String> {
    recipe.validate()?;
    if !x.is_finite()
        || !y.is_finite()
        || !(0.0..=1.0).contains(&x)
        || !(0.0..=1.0).contains(&y)
        || image.width == 0
        || image.height == 0
    {
        return Err("Invalid neutral point".into());
    }
    let g = geometry::Geometry::new(image, recipe, RenderOptions::default())
        .map_err(|e| e.to_string())?;
    let (sx, sy) = g.source_position(image, x, y);
    let mut rgb = [0f64; 3];
    for j in -2..=2 {
        for i in -2..=2 {
            let sample = geometry::sample(image, sx + i as f32, sy + j as f32);
            for c in 0..3 {
                rgb[c] += sample[c] as f64 / 25.;
            }
        }
    }
    if rgb.iter().any(|v| !v.is_finite() || v.abs() > 16.) {
        return Err(
            "Choose a neutral midtone, away from clipped highlights or deep shadows".into(),
        );
    }
    let inv = inverse(image.white_balance.camera_to_rgb).map_err(|e| e.to_string())?;
    // Full spectrum can produce negative visible RGB with valid positive sensor values.
    // M already contains the as-shot sensor gains. Its inverse returns the
    // original camera neutral directly; multiplying by as-shot neutral again
    // would apply the camera calibration twice.
    let target = vector(inv, rgb);
    if target.iter().any(|&v| !v.is_finite() || v <= 1e-5) {
        return Err("This point cannot define a camera neutral".into());
    }
    Ok(fit_neutral(
        &image.white_balance,
        target.map(|v| v / target[1]),
    ))
}
/// The temperature and tint the sliders show for the camera's own white balance.
pub fn as_shot_white_balance(cal: &WhiteBalanceCalibration) -> (f32, f32) {
    let n = cal.as_shot_neutral;
    fit_neutral(cal, [n[0] / n[1], 1., n[2] / n[1]])
}
/// Search the extended slider range for the values whose camera neutral
/// matches `target`: a coarse grid in log kelvin and tint, then finer grids
/// until a step is below one kelvin and one tint unit.
fn fit_neutral(cal: &WhiteBalanceCalibration, target: [f64; 3]) -> (f32, f32) {
    let error = |lk: f64, t: f64| {
        let n = neutral(cal, lk.exp(), t);
        (n[0] / target[0]).ln().powi(2) + (n[2] / target[2]).ln().powi(2)
    };
    let [lo, hi] = EXTENDED_TEMPERATURE.map(|k| f64::from(k).ln());
    let edge = f64::from(EXTENDED_TINT);
    let mut best = (6500f64.ln(), 0., f64::INFINITY);
    for i in 0..=92 {
        let lk = lo + (hi - lo) * i as f64 / 92.;
        for j in -40..=40 {
            let t = edge * j as f64 / 40.;
            let e = error(lk, t);
            if e < best.2 {
                best = (lk, t, e);
            }
        }
    }
    // Grids around the best point. A grid moves with the best point along a
    // valley, then the next grid is a fifth of the size.
    let (mut dk, mut dt) = ((hi - lo) / 92., edge / 40.);
    while dk * hi.exp() > 1. || dt > 1. {
        let (k0, t0, e0) = best;
        for i in -5..=5 {
            for j in -5..=5 {
                let lk = (k0 + dk * f64::from(i) / 5.).clamp(lo, hi);
                let t = (t0 + dt * f64::from(j) / 5.).clamp(-edge, edge);
                let e = error(lk, t);
                if e < best.2 {
                    best = (lk, t, e);
                }
            }
        }
        if best.2 == e0 {
            (dk, dt) = (dk / 5., dt / 5.);
        }
    }
    (best.0.exp().round() as f32, best.1.round() as f32)
}
fn curve_slopes(points: &[Point]) -> Vec<f64> {
    // Use f64 because valid f32 points can have very small x intervals.
    let segments: Vec<_> = points
        .windows(2)
        .map(|p| {
            let width = f64::from(p[1].x) - f64::from(p[0].x);
            (width, (f64::from(p[1].y) - f64::from(p[0].y)) / width)
        })
        .collect();
    let mut slopes = vec![segments[0].1; points.len()];
    if points.len() == 2 {
        return slopes;
    }
    let endpoint = |(h0, d0): (f64, f64), (h1, d1): (f64, f64)| {
        let slope = ((2. * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if slope * d0 <= 0. {
            0.
        } else {
            slope.signum() * slope.abs().min(3. * d0.abs())
        }
    };
    slopes[0] = endpoint(segments[0], segments[1]);
    slopes[points.len() - 1] = endpoint(segments[segments.len() - 1], segments[segments.len() - 2]);
    for i in 1..points.len() - 1 {
        let (h0, d0) = segments[i - 1];
        let (h1, d1) = segments[i];
        let w1 = 2. * h1 + h0;
        let w2 = h1 + 2. * h0;
        // The weighted harmonic mean prevents overshoot between unequal intervals.
        slopes[i] = if d0 * d1 <= 0. {
            0.
        } else {
            (w1 + w2) / (w1 / d0 + w2 / d1)
        };
    }
    slopes
}

fn eval(points: &[Point], slopes: &[f64], x: f32) -> f32 {
    let next = points
        .partition_point(|p| p.x < x)
        .clamp(1, points.len() - 1);
    let a = points[next - 1];
    let b = points[next];
    let width = f64::from(b.x) - f64::from(a.x);
    let t = ((f64::from(x) - f64::from(a.x)) / width).clamp(0., 1.);
    let u = 1. - t;
    let c1 = f64::from(a.y) + width * slopes[next - 1] / 3.;
    let c2 = f64::from(b.y) - width * slopes[next] / 3.;
    (u * u * u * f64::from(a.y)
        + 3. * u * u * t * c1
        + 3. * u * t * t * c2
        + t * t * t * f64::from(b.y))
    .clamp(f64::from(a.y.min(b.y)), f64::from(a.y.max(b.y))) as f32
}
pub(crate) fn curve_table(c: &Curves) -> Vec<[f32; 4]> {
    let channels = [&c.red[..], &c.green[..], &c.blue[..], &c.master[..]];
    let slopes = channels.map(curve_slopes);
    (0..1024)
        .map(|i| {
            let x = i as f32 / 1023.;
            std::array::from_fn(|channel| eval(channels[channel], &slopes[channel], x))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curves_keep_identity_and_two_point_lines() {
        let table = curve_table(&Curves::default());
        for (i, row) in table.iter().enumerate() {
            assert_eq!(*row, [i as f32 / 1023.; 4]);
        }
        let points = [Point { x: 0., y: 0.9 }, Point { x: 1., y: 0.1 }];
        let slopes = curve_slopes(&points);
        for i in 0..=100 {
            let x = i as f32 / 100.;
            assert!((eval(&points, &slopes, x) - (0.9 - 0.8 * x)).abs() < 1e-7);
        }
    }

    #[test]
    fn curves_match_frontend_values_and_have_continuous_slopes() {
        let points = [
            Point { x: 0., y: 0. },
            Point { x: 0.125, y: 0.375 },
            Point { x: 0.625, y: 0.75 },
            Point { x: 1., y: 1. },
        ];
        let slopes = curve_slopes(&points);
        assert!((eval(&points, &slopes, 0.0625) - 0.22009943).abs() < 1e-7);
        for p in &points {
            assert_eq!(eval(&points, &slopes, p.x), p.y);
        }
        for p in &points[1..points.len() - 1] {
            let h = 1e-4;
            let left = (p.y - eval(&points, &slopes, p.x - h)) / h;
            let right = (eval(&points, &slopes, p.x + h) - p.y) / h;
            assert!((left - right).abs() < 0.005);
        }
    }

    #[test]
    fn curves_preserve_segment_bounds_and_stay_finite() {
        for values in [
            [(0., 1.), (0.125, 0.75), (0.625, 0.5), (1., 0.)],
            [(0., 0.), (0.25, 1.), (0.75, 0.), (1., 1.)],
            [(0., 0.2), (0.125, 0.2), (0.625, 0.8), (1., 0.8)],
            [(0., 0.), (f32::from_bits(1), 1.), (0.5, 0.), (1., 1.)],
        ] {
            let points = values.map(|(x, y)| Point { x, y });
            let slopes = curve_slopes(&points);
            for p in &points {
                assert_eq!(eval(&points, &slopes, p.x), p.y);
            }
            for pair in points.windows(2) {
                let a = pair[0];
                let b = pair[1];
                let mut previous = a.y;
                for i in 0..=100 {
                    let x = a.x + (b.x - a.x) * (i as f32 / 100.);
                    let y = eval(&points, &slopes, x);
                    assert!(y.is_finite() && (a.y.min(b.y)..=a.y.max(b.y)).contains(&y));
                    assert!((y - previous) * (b.y - a.y).signum() >= 0.);
                    previous = y;
                }
            }
        }
    }

    #[test]
    fn extended_range_reaches_full_spectrum_neutrals_and_joins_the_normal_range() {
        // A full-spectrum DP2 Merrill. The target is the camera neutral of
        // the mean of its scene, which no Planckian light reaches.
        let cal = WhiteBalanceCalibration {
            camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            xyz_to_camera: [
                0.8949, -0.2988, -0.1924, 0.7444, 0.2723, -0.1365, 0.3678, 0.8089, 0.3128,
            ],
            as_shot_neutral: [0.6198, 1., 1.1862],
        };
        let close = |a: [f64; 3], b: [f64; 3], tolerance: f64| {
            (0..3).all(|c| (a[c] / b[c]).ln().abs() < tolerance)
        };
        // The line continues from each edge without a step.
        for (k, t) in [
            (2000., 0.),
            (12000., 0.),
            (5000., 100.),
            (5000., -100.),
            (2000., -100.),
        ] {
            let outside = neutral(&cal, k * if k < 5000. { 0.999 } else { 1.001 }, t * 1.01);
            assert!(close(neutral(&cal, k, t), outside, 1e-3), "{k} K, tint {t}");
        }
        let target = [0.937, 1., 0.999];
        let (k, t) = fit_neutral(&cal, target);
        assert!(k < 2000. && t < -100., "{k} K, tint {t}");
        assert!(
            close(neutral(&cal, k.into(), t.into()), target, 2e-3),
            "{k} K, tint {t}"
        );
        // Values inside the normal range keep the Planckian model.
        assert_eq!(neutral(&cal, 5000., 20.), planck(&cal, 5000., 20.));
        // Each neutral in the extended range has one pair of slider values.
        for k in [500., 800., 1500., 2850., 6500., 11000., 20000., 50000.] {
            for t in [-2000., -1380., -500., -100., 0., 60., 300., 1000., 2000.] {
                let (fk, ft) = fit_neutral(&cal, neutral(&cal, k, t));
                let mired = 1e6 / f64::from(fk) - 1e6 / k;
                assert!(
                    mired.abs() < 0.5 && (f64::from(ft) - t).abs() <= 1.,
                    "{k} K, tint {t}: fit {fk} K, tint {ft}"
                );
            }
        }
    }
    #[test]
    fn picker_recovers_camera_neutral_without_double_white_balance() {
        let calibration = WhiteBalanceCalibration {
            camera_to_rgb: [1.25, 0., 0., 0., 1., 0., 0., 0., 1. / 0.6],
            xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            as_shot_neutral: [0.8, 1., 0.6],
        };
        let n = neutral(&calibration, 5000., 12.);
        let scene = vector(calibration.camera_to_rgb, n).map(|v| (v * 0.18) as f32);
        let image = SceneLinearImage {
            data: scene.repeat(25),
            width: 5,
            height: 5,
            orientation: 1,
            white_balance: calibration,
            color_mode_calibration: None,
        };
        let (k, t) = pick_white_balance(&image, &EditRecipe::default(), 0.5, 0.5).unwrap();
        assert!(
            (k - 5000.).abs() <= 1. && (t - 12.).abs() <= 1.,
            "{k}K tint {t}"
        );
        let m = white_balance_matrix(&calibration, Some(k), t).unwrap();
        let output = vector(m, scene.map(f64::from));
        assert!((output[0] - output[1]).abs() < 1e-4 && (output[2] - output[1]).abs() < 1e-4);
    }

    #[test]
    fn picker_accepts_signed_rgb_but_requires_valid_sensor_values() {
        let calibration = WhiteBalanceCalibration {
            camera_to_rgb: [1.25, 0., 0., 0., 1., 0., -2., 0., 13. / 3.],
            xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            as_shot_neutral: [0.8, 1., 0.6],
        };
        let sensor = neutral(&calibration, 2335., 115.).map(|v| v * 0.18);
        let rgb = vector(calibration.camera_to_rgb, sensor).map(|v| v as f32);
        assert!(rgb[2] < 0.);
        let mut image = SceneLinearImage {
            data: rgb.repeat(25),
            width: 5,
            height: 5,
            orientation: 1,
            white_balance: calibration,
            color_mode_calibration: None,
        };
        let (k, t) = pick_white_balance(&image, &EditRecipe::default(), 0.5, 0.5).unwrap();
        assert!((k - 2335.).abs() <= 1. && (t - 115.).abs() <= 1.);
        let output = vector(
            white_balance_matrix(&calibration, Some(k), t).unwrap(),
            rgb.map(f64::from),
        );
        assert!((output[0] - output[1]).abs() < 1e-4 && (output[2] - output[1]).abs() < 1e-4);
        for invalid in [
            [0.; 3],
            [1e-8; 3],
            [-0.1, 0.2, 0.3],
            [100.; 3],
            [f32::NAN; 3],
            [f32::INFINITY; 3],
        ] {
            image.data = invalid.repeat(25);
            assert!(pick_white_balance(&image, &EditRecipe::default(), 0.5, 0.5).is_err());
        }
    }
}
