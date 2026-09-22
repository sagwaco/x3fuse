use crate::{geometry, Curves, EditRecipe, MonochromeFilter, Point, RenderError, RenderOptions};
use x3f_core::{SceneLinearImage, WhiteBalanceCalibration};

fn inverse(m: [f64; 9]) -> Result<[f64; 9], RenderError> {
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
    let weights = match filter {
        MonochromeFilter::Neutral => [1. / 3.; 3],
        MonochromeFilter::Red => [1., 0., 0.],
        MonochromeFilter::Orange => [0.75, 0.25, 0.],
        MonochromeFilter::Yellow => [0.5, 0.5, 0.],
        MonochromeFilter::Green => [0., 1., 0.],
        MonochromeFilter::Blue => [0., 0., 1.],
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
fn neutral(cal: &WhiteBalanceCalibration, k: f64, t: f64) -> [f64; 3] {
    let n = vector(cal.xyz_to_camera, white_xyz(k, t));
    let g = n[1].max(1e-8);
    n.map(|v| (v / g).max(1e-6))
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
    if rgb.iter().any(|&v| v <= 1e-5) || rgb.iter().copied().fold(0., f64::max) > 16. {
        return Err(
            "Choose a neutral midtone, away from clipped highlights or deep shadows".into(),
        );
    }
    let inv = inverse(image.white_balance.camera_to_rgb).map_err(|e| e.to_string())?;
    // M already contains the as-shot sensor gains. Its inverse returns the
    // original camera neutral directly; multiplying by as-shot neutral again
    // would apply the camera calibration twice.
    let target = vector(inv, rgb);
    let target = target.map(|v| v / target[1]);
    if target.iter().any(|&v| !v.is_finite() || v <= 0.) {
        return Err("This point cannot define a camera neutral".into());
    }
    let error = |k: f64, t: f64| {
        let n = neutral(&image.white_balance, k, t);
        (n[0] / target[0]).ln().powi(2) + (n[2] / target[2]).ln().powi(2)
    };
    let mut best = (6500., 0., f64::INFINITY);
    for k in (2000..=12000).step_by(100) {
        for t in (-100..=100).step_by(5) {
            let e = error(k as f64, t as f64);
            if e < best.2 {
                best = (k as f64, t as f64, e);
            }
        }
    }
    let (bk, bt) = (best.0, best.1);
    for dk in -100..=100 {
        for dt in -5..=5 {
            let k = (bk + dk as f64).clamp(2000., 12000.);
            let t = (bt + dt as f64).clamp(-100., 100.);
            let e = error(k, t);
            if e < best.2 {
                best = (k, t, e);
            }
        }
    }
    Ok((best.0 as f32, best.1 as f32))
}
fn eval(points: &[Point], x: f32) -> f32 {
    let next = points
        .partition_point(|p| p.x < x)
        .clamp(1, points.len() - 1);
    let a = points[next - 1];
    let b = points[next];
    a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
}
pub(crate) fn curve_table(c: &Curves) -> Vec<[f32; 4]> {
    (0..1024)
        .map(|i| {
            let x = i as f32 / 1023.;
            [
                eval(&c.red, x),
                eval(&c.green, x),
                eval(&c.blue, x),
                eval(&c.master, x),
            ]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
