//! Measure patches in the unrotated active area and render a calibration preview.
//! raw_patches input.X3F output.png [patches.json] [recipe.json]
//! Patch coordinates are normalized. Starts round down; ends round up.
//! The output must be a new file. Omitted patches produce an empty patch list.
//! Summary JSON goes to stdout. Diagnostics go to stderr.
//! Raw-color statistics include the exposure anchor, before recipe exposure.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Write, path::PathBuf, sync::atomic::AtomicBool};
use x3f_core::{prepare_scene_linear, SceneLinearImage, SceneLinearOptions};
use x3f_render::{
    as_shot_channel_gains, read_camera_profiles, EditRecipe, PreparedImage, RawColor,
    RenderOptions, Renderer,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    name: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Patch {
    fn bounds(&self, width: u32, height: u32) -> Result<[usize; 4], String> {
        let [x, y, w, h] = [self.x, self.y, self.width, self.height];
        if self.name.trim().is_empty()
            || [x, y, w, h].iter().any(|v| !v.is_finite())
            || x < 0.
            || y < 0.
            || w <= 0.
            || h <= 0.
            || x + w > 1.
            || y + h > 1.
            || x + w <= x
            || y + h <= y
        {
            return Err(format!("Invalid normalized patch {:?}", self.name));
        }
        let bounds = [
            (x * f64::from(width)).floor() as usize,
            (y * f64::from(height)).floor() as usize,
            ((x + w) * f64::from(width)).ceil() as usize,
            ((y + h) * f64::from(height)).ceil() as usize,
        ];
        if bounds[0] >= bounds[2] || bounds[1] >= bounds[3] {
            return Err(format!("Empty patch {:?}", self.name));
        }
        Ok(bounds)
    }
}

fn inverse(m: [f64; 9]) -> Result<[f64; 9], &'static str> {
    let invalid = "Non-finite or singular camera calibration";
    if m.iter().any(|v| !v.is_finite()) {
        return Err(invalid);
    }
    let d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if !d.is_finite() || d.abs() < 1e-14 {
        return Err(invalid);
    }
    let result = [
        (m[4] * m[8] - m[5] * m[7]) / d,
        (m[2] * m[7] - m[1] * m[8]) / d,
        (m[1] * m[5] - m[2] * m[4]) / d,
        (m[5] * m[6] - m[3] * m[8]) / d,
        (m[0] * m[8] - m[2] * m[6]) / d,
        (m[2] * m[3] - m[0] * m[5]) / d,
        (m[3] * m[7] - m[4] * m[6]) / d,
        (m[1] * m[6] - m[0] * m[7]) / d,
        (m[0] * m[4] - m[1] * m[3]) / d,
    ];
    if result.iter().any(|v| !v.is_finite()) {
        return Err(invalid);
    }
    Ok(result)
}

fn vector(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| (0..3).map(|c| m[r * 3 + c] * v[c]).sum())
}

fn count_signs(counts: &mut [u64; 2], rgb: [f64; 3]) {
    counts[0] += u64::from(rgb.iter().any(|v| *v < 0.));
    counts[1] += u64::from(0.95047 * rgb[0] + rgb[1] + 1.08883 * rgb[2] <= 0.);
}

fn patch_means(
    image: &SceneLinearImage,
    patch: &Patch,
    rgb_to_camera: [f64; 9],
    raw_color: Option<&RawColor>,
) -> Result<Value, String> {
    let [x0, y0, x1, y1] = patch.bounds(image.width, image.height)?;
    let count = (x1 - x0) as u64 * (y1 - y0) as u64;
    let mut sum = [0.; 3];
    let mut min_layers = [f64::INFINITY; 3];
    let mut max_layers = [f64::NEG_INFINITY; 3];
    let (mut raw_sum, mut raw_signed, mut source_signed) = ([0.; 3], [0; 2], [0; 2]);
    let cal = &image.white_balance;
    let neutral_rgb = vector(cal.camera_to_rgb, cal.as_shot_neutral);
    let anchor = (0.2126 * neutral_rgb[0] + 0.7152 * neutral_rgb[1] + 0.0722 * neutral_rgb[2])
        / cal.as_shot_neutral[1];
    if raw_color.is_some() && (!anchor.is_finite() || anchor <= 0.) {
        return Err("Invalid raw color exposure anchor".into());
    }
    let raw_mix = raw_color.map(|raw| {
        std::array::from_fn(|i| {
            f64::from(raw.matrix[i]) * f64::from(raw.gains[i % 3]) / f64::from(raw.gains[1])
                * anchor
        })
    });
    for y in y0..y1 {
        let start = (y * image.width as usize + x0) * 3;
        let end = (y * image.width as usize + x1) * 3;
        for pixel in image.data[start..end].as_chunks::<3>().0 {
            let rgb = pixel.map(f64::from);
            let bmt = vector(rgb_to_camera, rgb);
            if bmt.iter().any(|v| !v.is_finite()) {
                return Err(format!("Non-finite layers for patch {:?}", patch.name));
            }
            count_signs(&mut source_signed, rgb);
            for c in 0..3 {
                sum[c] += rgb[c];
                min_layers[c] = min_layers[c].min(bmt[c]);
                max_layers[c] = max_layers[c].max(bmt[c]);
            }
            if let Some(mix) = raw_mix {
                let output = vector(mix, bmt);
                if output.iter().any(|v| !v.is_finite()) {
                    return Err(format!("Non-finite raw output for patch {:?}", patch.name));
                }
                count_signs(&mut raw_signed, output);
                for c in 0..3 {
                    raw_sum[c] += output[c];
                }
            }
        }
    }
    let mean = sum.map(|v| v / count as f64);
    // The inverse is linear, so apply it after the f64 mean.
    let layers = vector(rgb_to_camera, mean);
    let raw_mean = raw_sum.map(|v| v / count as f64);
    if mean
        .iter()
        .chain(&layers)
        .chain(&min_layers)
        .chain(&max_layers)
        .chain(&raw_mean)
        .any(|v| !v.is_finite())
    {
        return Err(format!("Non-finite mean for patch {:?}", patch.name));
    }
    Ok(json!({
        "name": patch.name,
        "meanLayers": layers,
        "minLayers": min_layers,
        "maxLayers": max_layers,
        "meanSceneRGB": mean,
        "count": count,
        "negativeSceneRGBCount": source_signed[0],
        "nonPositiveSceneXYZSumCount": source_signed[1],
        "rawColor": raw_color.map(|_| json!({
            "exposureAnchor": anchor,
            "meanRGB": raw_mean,
            "negativeCount": raw_signed[0],
            "negativeFraction": raw_signed[0] as f64 / count as f64,
            "nonPositiveXYZSumCount": raw_signed[1],
            "nonPositiveXYZSumFraction": raw_signed[1] as f64 / count as f64,
        })),
    }))
}

fn parse_recipe(value: Value) -> Result<EditRecipe, serde_json::Error> {
    serde_json::from_value(value.get("recipe").cloned().unwrap_or(value))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(2..=4).contains(&args.len()) {
        return Err("usage: raw_patches input.X3F output.png [patches.json] [recipe.json]".into());
    }
    let input = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    if !output
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        return Err("Output extension must be png".into());
    }
    if output.try_exists()? {
        return Err("Output must be a new file".into());
    }
    let patches: Vec<Patch> = if let Some(path) = args.get(2) {
        serde_json::from_slice(&std::fs::read(path)?)?
    } else {
        Vec::new()
    };
    let mut recipe = if let Some(path) = args.get(3) {
        parse_recipe(serde_json::from_slice(&std::fs::read(path)?)?)?
    } else {
        EditRecipe {
            denoise: 0,
            film: None,
            camera_profile: None,
            ..Default::default()
        }
    };
    recipe.validate()?;
    let cancel = AtomicBool::new(false);
    let image = prepare_scene_linear(
        &input,
        &SceneLinearOptions {
            denoise_intensity: recipe.denoise,
            denoise_options: recipe.denoise_options,
            x3i_source: recipe.x3i_source,
            ..Default::default()
        },
        &cancel,
        |stage| eprintln!("{stage:?}"),
    )?;
    let calibration = image.white_balance;
    let rgb_to_camera = inverse(calibration.camera_to_rgb)?;
    if calibration
        .as_shot_neutral
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.)
        || calibration.xyz_to_camera.iter().any(|v| !v.is_finite())
    {
        return Err("Invalid camera calibration".into());
    }
    let gains = as_shot_channel_gains(&calibration);
    if args.get(3).is_none() {
        recipe.raw_color = Some(RawColor {
            gains,
            matrix: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
        });
    }
    recipe.validate()?;
    let profiles = read_camera_profiles(&input, &cancel)?;
    let image = PreparedImage::new(image, &cancel)?.with_camera_profiles(profiles);
    let patches = patches
        .iter()
        .map(|patch| {
            patch_means(
                image.image(),
                patch,
                rgb_to_camera,
                recipe.raw_color.as_ref(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut summary = json!({
        "input": input.to_string_lossy(),
        "width": image.image().width,
        "height": image.image().height,
        "orientation": image.image().orientation,
        "asShotGains": gains,
        "recipe": recipe,
        "calibration": {
            "camera_to_rgb": calibration.camera_to_rgb,
            "as_shot_neutral": calibration.as_shot_neutral,
        },
        "patches": patches,
    });
    summary["recipe"]["rawColor"] = json!(recipe.raw_color);
    let renderer = Renderer::new()?;
    eprintln!("GPU: {}", renderer.adapter_name);
    let result = renderer.render_prepared(
        &image,
        &recipe,
        RenderOptions {
            max_dimension: Some(1024),
            ..Default::default()
        },
        &cancel,
    )?;
    let png = result.png()?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?
        .write_all(&png)?;
    eprintln!("Rendered {}x{}", result.width, result.height);
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, &summary)?;
    writeln!(stdout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_round_trip_and_invalid_calibration() {
        let m = [2., -1., 0.5, 1., 3., -2., -1., 0.5, 4.];
        let inv = inverse(m).unwrap();
        for r in 0..3 {
            for c in 0..3 {
                let product: f64 = (0..3).map(|k| inv[r * 3 + k] * m[k * 3 + c]).sum();
                assert!((product - f64::from(r == c)).abs() < 1e-12);
            }
        }
        assert!(inverse([1.; 9]).is_err());
        for invalid in [f64::NAN, f64::INFINITY] {
            let mut m = m;
            m[4] = invalid;
            assert!(inverse(m).is_err());
        }
    }

    #[test]
    fn patches_validate_bounds_and_keep_signed_values() {
        let mut patch = Patch {
            name: "signed".into(),
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
        };
        let identity = [1., 0., 0., 0., 1., 0., 0., 0., 1.];
        let image = SceneLinearImage {
            data: vec![-1., 2., 3., 3., 4., -5.],
            width: 2,
            height: 1,
            orientation: 6,
            white_balance: x3f_core::WhiteBalanceCalibration {
                camera_to_rgb: identity,
                xyz_to_camera: identity,
                as_shot_neutral: [1.; 3],
            },
            color_mode_calibration: None,
        };
        let raw = RawColor {
            gains: [2., 2., 4.],
            matrix: [1., 0., 0., 0., 1., 0., 0., -1., 1.],
        };
        let means = patch_means(
            &image,
            &patch,
            [2., 0., 0., 0., 3., 0., 0., 0., 4.],
            Some(&raw),
        )
        .unwrap();
        assert_eq!(means["count"], 2);
        assert_eq!(means["meanSceneRGB"], json!([1., 3., -1.]));
        assert_eq!(means["meanLayers"], json!([2., 9., -4.]));
        assert_eq!(means["minLayers"], json!([-2., 6., -20.]));
        assert_eq!(means["maxLayers"], json!([6., 12., 12.]));
        assert_eq!(means["negativeSceneRGBCount"], 2);
        assert_eq!(means["nonPositiveSceneXYZSumCount"], 0);
        assert_eq!(means["rawColor"]["meanRGB"], json!([2., 9., -17.]));
        assert_eq!(means["rawColor"]["exposureAnchor"], 1.);
        assert_eq!(means["rawColor"]["negativeCount"], 2);
        assert_eq!(means["rawColor"]["negativeFraction"], 1.);
        assert_eq!(means["rawColor"]["nonPositiveXYZSumCount"], 1);
        assert_eq!(means["rawColor"]["nonPositiveXYZSumFraction"], 0.5);
        let mut signs = [0, 0];
        count_signs(&mut signs, [0.; 3]);
        assert_eq!(signs, [0, 1]);
        patch.width = 0.5;
        assert_eq!(patch.bounds(2, 1).unwrap(), [0, 0, 1, 1]);
        assert!(patch.bounds(0, 1).is_err());
        for invalid in [0., -1., 1.1, f64::NAN, f64::INFINITY] {
            patch.width = invalid;
            assert!(patch.bounds(2, 1).is_err());
        }
        patch.width = 0.5;
        patch.x = 0.75;
        assert!(patch.bounds(2, 1).is_err());
    }

    #[test]
    fn direct_and_sidecar_recipes_match() {
        let direct = json!({"denoise": 0, "film": null, "cameraProfile": "FCBlue"});
        let sidecar = json!({"version": 1, "source": {}, "recipe": direct});
        assert_eq!(
            parse_recipe(direct).unwrap(),
            parse_recipe(sidecar).unwrap()
        );
        assert!(parse_recipe(json!({"recipe": null})).is_err());
    }
}
