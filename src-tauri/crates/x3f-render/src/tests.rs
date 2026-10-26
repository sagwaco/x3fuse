use super::*;
/// Most GPU checks read 16-bit samples; this keeps them short.
impl std::ops::Deref for Pixels {
    type Target = [u16];
    fn deref(&self) -> &[u16] {
        match self {
            Pixels::Rgb16(data) => data,
            Pixels::Rgba8(_) => panic!("expected a 16-bit render"),
        }
    }
}
fn image(width: u32, height: u32) -> SceneLinearImage {
    SceneLinearImage {
        width,
        height,
        orientation: 1,
        data: (0..width * height)
            .flat_map(|i| {
                let x = (i % width) as f32 / width as f32;
                let y = (i / width) as f32 / height as f32;
                [x * x + 0.01, y * y + 0.01, 0.18]
            })
            .collect(),
        white_balance: x3f_core::WhiteBalanceCalibration {
            camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            xyz_to_camera: [
                3.24045, -1.53714, -0.49853, -0.96927, 1.87601, 0.04156, 0.05564, -0.20403, 1.05723,
            ],
            as_shot_neutral: [1., 1., 1.],
        },
        color_mode_calibration: None,
    }
}

#[test]
fn dng_method_serialization_preserves_legacy_and_rejects_unknown_methods() {
    let legacy: EditRecipe = serde_json::from_str(r#"{"version":1}"#).unwrap();
    assert_eq!(legacy.dng_demosaic, None);
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("dngDemosaic")
        .is_none());
    for name in [
        "amaze", "dcb", "ahd", "eahd", "hphd", "igv", "lmmse", "vng4", "mono", "fast",
    ] {
        let input = serde_json::json!({"dngDemosaic": name});
        let recipe: EditRecipe = serde_json::from_value(input).unwrap();
        assert_eq!(serde_json::to_value(recipe).unwrap()["dngDemosaic"], name);
    }
    assert!(serde_json::from_str::<EditRecipe>(r#"{"dngDemosaic":"future"}"#).is_err());
}

#[test]
#[ignore = "requires a supported GPU"]
fn mono_demosaic_render_keeps_gray_and_applies_warmth() {
    let cancel = AtomicBool::new(false);
    let renderer = Renderer::new().unwrap();
    let mut scene = image(8, 8);
    scene.data.fill(0.18);
    let source = PreparedImage::new(scene, &cancel)
        .unwrap()
        .with_dng_source(true);
    let recipe = EditRecipe {
        denoise: 0,
        film: None,
        dng_demosaic: Some(DngDemosaic::Mono),
        ..Default::default()
    };
    let gray = renderer
        .render_prepared(&source, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    for rgb in gray.data.as_chunks::<3>().0 {
        assert!(rgb[0] > 1000);
        assert_eq!(rgb[0], rgb[1]);
        assert_eq!(rgb[1], rgb[2]);
    }
    let warm = renderer
        .render_prepared(
            &source,
            &EditRecipe {
                warmth: 50.,
                ..recipe
            },
            RenderOptions::default(),
            &cancel,
        )
        .unwrap();
    assert!(warm.data.as_chunks::<3>().0.iter().all(|rgb| rgb[0] > rgb[2]));
}

#[test]
fn dng_recipes_reject_sensor_controls_and_allow_spectral_film_filters() {
    let base = EditRecipe {
        film: None,
        denoise: 0,
        ..Default::default()
    };
    base.validate_dng(false).unwrap();
    base.validate_dng(true).unwrap();
    for recipe in [
        EditRecipe {
            camera_profile: Some("Standard".into()),
            ..base.clone()
        },
        EditRecipe {
            fill_light: 1.,
            ..base.clone()
        },
        EditRecipe {
            denoise: 1,
            ..base.clone()
        },
        EditRecipe {
            raw_color: Some(RawColor {
                gains: [1.; 3],
                matrix: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            }),
            ..base.clone()
        },
        EditRecipe {
            monochrome: Some(MonochromeSettings::default()),
            ..base.clone()
        },
    ] {
        assert!(recipe.validate_dng(false).is_err());
    }
    let balanced = EditRecipe {
        temperature: Some(6500.),
        ..base.clone()
    };
    balanced.validate_dng(false).unwrap();
    assert!(balanced.validate_dng(true).is_err());
    let mono = EditRecipe {
        dng_demosaic: Some(DngDemosaic::Mono),
        ..base.clone()
    };
    mono.validate_dng(false).unwrap();
    for invalid in [
        EditRecipe {
            temperature: Some(5000.),
            ..mono.clone()
        },
        EditRecipe {
            tint: 5.,
            ..mono.clone()
        },
        EditRecipe {
            white_balance_gains: Some([1.; 3]),
            ..mono.clone()
        },
    ] {
        assert!(invalid.validate_dng(false).is_err());
    }
    for film in 0..film::profile::FILM_COUNT as u32 {
        let profile = film::profile::load(film as usize).unwrap();
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                film,
                ..Default::default()
            }),
            monochrome: Some(MonochromeSettings::default()),
            ..base.clone()
        };
        assert_eq!(recipe.validate_dng(false).is_ok(), profile.is_monochrome());
    }
}

#[test]
#[ignore = "requires a supported GPU"]
fn dng_neutral_render_uses_linear_scene_tone_and_keeps_highlight_edits() {
    let cancel = AtomicBool::new(false);
    let renderer = Renderer::new().unwrap();
    let mut scene = image(1, 1);
    scene.data = vec![0.18; 3];
    let source = PreparedImage::new(scene, &cancel)
        .unwrap()
        .with_dng_source(false);
    let recipe = EditRecipe {
        film: None,
        denoise: 0,
        ..Default::default()
    };
    let result = renderer
        .render_prepared(&source, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    let expected = ((1.055 * 0.18_f64.powf(1. / 2.4) - 0.055) * 65535.).round() as i32;
    assert!(
        result
            .data
            .iter()
            .all(|&v| (i32::from(v) - expected).abs() < 32),
        "{:?}",
        result.data
    );
    let mut scene = image(1, 1);
    scene.data = vec![2.; 3];
    let source = PreparedImage::new(scene, &cancel)
        .unwrap()
        .with_dng_source(false);
    let result = renderer
        .render_prepared(
            &source,
            &EditRecipe {
                exposure: -2.,
                ..recipe
            },
            RenderOptions::default(),
            &cancel,
        )
        .unwrap();
    assert!(
        result.data.iter().all(|&v| v > 45_000 && v < 50_000),
        "{:?}",
        result.data
    );
}
#[test]
fn recipes_validate_and_round_trip() {
    let recipe = EditRecipe::default();
    assert_eq!(recipe.film, Some(FilmSettings::default()));
    assert_eq!(recipe.monochrome, None);
    for json in [r#"{"version":1}"#, r#"{"monochrome":null}"#] {
        assert_eq!(
            serde_json::from_str::<EditRecipe>(json).unwrap().monochrome,
            None,
            "Old and explicitly color recipes must remain color"
        );
    }
    // Recipes saved before grain roughness keep spektrafilm's even grain.
    let film: FilmSettings = serde_json::from_str(r#"{"grainSize":2}"#).unwrap();
    assert_eq!(film.grain_roughness, 0.);
    for amount in [0., 1., 2., 8.] {
        let film = FilmSettings {
            grain_amount: amount,
            ..Default::default()
        };
        film.validate().unwrap();
        let saved: FilmSettings =
            serde_json::from_str(&serde_json::to_string(&film).unwrap()).unwrap();
        assert_eq!(saved.grain_amount, amount);
    }
    for amount in [-0.1, 8.1, f32::NAN, f32::INFINITY] {
        assert!(FilmSettings {
            grain_amount: amount,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    for roughness in [-0.1, 1.1] {
        let rough = FilmSettings {
            grain_roughness: roughness,
            ..Default::default()
        };
        assert!(rough.validate().is_err());
    }
    let tilted: EditRecipe = serde_json::from_str(r#"{"pitch":40,"yaw":-40}"#).unwrap();
    tilted.validate().unwrap();
    // The extended white balance range is valid with the switch on or off.
    for json in [
        r#"{"temperature":500,"tint":-2000}"#,
        r#"{"temperature":50000,"tint":2000}"#,
    ] {
        serde_json::from_str::<EditRecipe>(json)
            .unwrap()
            .validate()
            .unwrap();
    }
    for json in [
        r#"{"pitch":40.5}"#,
        r#"{"yaw":-41}"#,
        r#"{"temperature":499}"#,
        r#"{"temperature":50001}"#,
        r#"{"tint":2001}"#,
    ] {
        assert!(serde_json::from_str::<EditRecipe>(json)
            .unwrap()
            .validate()
            .is_err());
    }
    for filter in ["neutral", "red", "orange", "yellow", "green", "blue"] {
        let json = format!(r#"{{"monochrome":{{"filter":"{filter}"}}}}"#);
        let recipe: EditRecipe = serde_json::from_str(&json).unwrap();
        recipe.validate().unwrap();
        let encoded = serde_json::to_value(&recipe).unwrap();
        assert_eq!(encoded["monochrome"]["filter"], filter);
        assert_eq!(recipe, serde_json::from_value(encoded).unwrap());
    }
    for json in [
        r#"{"monochrome":{"filter":"infrared"}}"#,
        r#"{"monochrome":{"filter":null}}"#,
        r#"{"monochrome":{"filter":"red","strength":1}}"#,
    ] {
        assert!(serde_json::from_str::<EditRecipe>(json).is_err());
    }
    let legacy: EditRecipe = serde_json::from_str(r#"{"version":1,"film":null}"#).unwrap();
    assert_eq!(
        legacy.film, None,
        "Explicit film-off recipes must remain off"
    );
    assert_eq!(
        serde_json::from_str::<EditRecipe>(r#"{"version":1}"#)
            .unwrap()
            .film,
        recipe.film
    );
    recipe.validate().unwrap();
    let encoded = serde_json::to_string(&recipe).unwrap();
    assert_eq!(recipe, serde_json::from_str(&encoded).unwrap());
    let mut bad = recipe.clone();
    bad.exposure = f32::NAN;
    assert!(bad.validate().is_err());
    bad = recipe.clone();
    bad.version = 2;
    assert!(bad.validate().is_err());
    bad = recipe.clone();
    bad.curves.master[1].x = 0.;
    assert!(bad.validate().is_err());
    bad = recipe;
    bad.crop = Some(Crop {
        x: 0.8,
        width: 0.3,
        ..Default::default()
    });
    assert!(bad.validate().is_err());
}

#[test]
fn raw_color_recipes_validate_and_round_trip() {
    let encoded = serde_json::to_value(EditRecipe::default()).unwrap();
    assert!(encoded.get("rawColor").is_none());
    let json = r#"{"rawColor":{"gains":[0.5,1,2],"matrix":[1,0,0,0,1,0,0,0,1]}}"#;
    let recipe: EditRecipe = serde_json::from_str(json).unwrap();
    recipe.validate().unwrap();
    let encoded = serde_json::to_value(&recipe).unwrap();
    assert_eq!(encoded["rawColor"]["gains"][2], 2.);
    assert_eq!(recipe, serde_json::from_value(encoded).unwrap());
    for json in [
        r#"{"rawColor":{"gains":[1,1,1],"matrix":[1,0,0,0,1,0,0,0,1],"mix":1}}"#,
        r#"{"rawColor":{"gains":[1,1,1]}}"#,
        r#"{"rawColor":{"gains":[1,1,1],"matrix":[1,0,0,0,1,0,0,0]}}"#,
    ] {
        assert!(serde_json::from_str::<EditRecipe>(json).is_err());
    }
    let with = |gain: f32, entry: f32| {
        let mut raw = recipe.clone();
        let color = raw.raw_color.as_mut().unwrap();
        color.gains[0] = gain;
        color.matrix[4] = entry;
        raw
    };
    for (gain, entry) in [(1. / 64., 4.), (64., -4.)] {
        with(gain, entry).validate().unwrap();
    }
    for (gain, entry) in [
        (f32::NAN, 1.),
        (f32::INFINITY, 1.),
        (1., f32::NAN),
        (1., f32::NEG_INFINITY),
        (0., 1.),
        (65., 1.),
        (1., 4.5),
        (1., -4.5),
    ] {
        assert!(with(gain, entry).validate().is_err(), "{gain} {entry}");
    }
    let mut bad = recipe.clone();
    bad.camera_profile = Some("Standard".into());
    assert!(bad.validate().is_err());
    bad = recipe;
    bad.monochrome = Some(MonochromeSettings::default());
    assert!(bad.validate().is_err());
}

#[test]
fn monochrome_grading_defaults_round_trip_and_validate() {
    let mut recipe: EditRecipe = serde_json::from_str(r#"{"film":null}"#).unwrap();
    assert_eq!(recipe.warmth, 0.);
    assert_eq!(recipe.tone_mixer, [0.; 8]);
    let encoded = serde_json::to_value(&recipe).unwrap();
    assert!(encoded.get("warmth").is_none());
    assert!(encoded.get("toneMixer").is_none());
    recipe.warmth = -35.;
    recipe.tone_mixer = [10., -20., 30., -40., 50., -60., 70., -80.];
    recipe.validate().unwrap();
    assert_eq!(
        recipe,
        serde_json::from_value(serde_json::to_value(&recipe).unwrap()).unwrap()
    );
    for invalid in [-101., 101., f32::NAN, f32::INFINITY] {
        let mut bad = recipe.clone();
        bad.warmth = invalid;
        assert!(bad.validate().is_err());
        for band in 0..8 {
            let mut bad = recipe.clone();
            bad.tone_mixer[band] = invalid;
            assert!(bad.validate().is_err());
        }
    }
    assert!(serde_json::from_str::<EditRecipe>(r#"{"toneMixer":[0,0]}"#).is_err());
}

#[test]
fn silver_warmth_recalibrates_and_keys_the_scanner() {
    for stock in [2, 20, 21] {
        let settings = FilmSettings {
            film: stock,
            paper: if stock == 2 { 3 } else { 8 },
            negative: stock == 21,
            ..Default::default()
        };
        let lut = film::FilmLut::build(stock, None).unwrap();
        let neutral = film::FilmPair::build(&settings, &lut, 0.).unwrap();
        let warm = film::FilmPair::build(&settings, &lut, 100.).unwrap();
        assert!(warm.matches(&settings, 100.));
        if stock == 2 {
            assert!(neutral.matches(&settings, 100.));
            assert_eq!(neutral.fingerprint(), warm.fingerprint());
        } else {
            assert!(!neutral.matches(&settings, 100.));
            assert!(warm.silver_scale < neutral.silver_scale);
            assert_ne!(neutral.scan_remap, warm.scan_remap);
            assert_ne!(neutral.fingerprint(), warm.fingerprint());
        }
    }
}

#[test]
#[ignore = "requires hardware GPU"]
fn gpu_monochrome_grading() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    let luminance = |pixel: &[u16]| {
        pixel
            .iter()
            .zip([0.2126, 0.7152, 0.0722])
            .map(|(&v, weight)| {
                let encoded = f64::from(v) / 65535.;
                weight
                    * if encoded <= 0.04045 {
                        encoded / 12.92
                    } else {
                        ((encoded + 0.055) / 1.055).powf(2.4)
                    }
            })
            .sum::<f64>()
    };
    let mut source = image(9, 1);
    source.data = vec![
        0.18, 0.18, 0.18, // Neutral
        0.3, 0.03, 0.03, // Red
        0.3, 0.165, 0.03, // Orange
        0.3, 0.3, 0.03, // Yellow
        0.03, 0.3, 0.03, // Green
        0.03, 0.3, 0.3, // Aqua
        0.03, 0.03, 0.3, // Blue
        0.165, 0.03, 0.3, // Purple
        0.3, 0.03, 0.3, // Magenta
    ];
    source.data[..3].fill(camera::fallback_metered_gray() as f32);
    let render = |recipe: &EditRecipe, color_profile| {
        renderer
            .render(
                &source,
                recipe,
                RenderOptions {
                    color_profile,
                    ..Default::default()
                },
                &cancel,
            )
            .unwrap()
    };
    for recipe in [
        EditRecipe {
            film: None,
            camera_profile: Some("Monochrome".into()),
            ..Default::default()
        },
        EditRecipe {
            film: Some(FilmSettings {
                film: 20,
                paper: 8,
                grain: false,
                couplers: 0.,
                ..Default::default()
            }),
            ..Default::default()
        },
        EditRecipe {
            film: Some(FilmSettings {
                film: 21,
                paper: 8,
                negative: true,
                grain: false,
                couplers: 0.,
                ..Default::default()
            }),
            ..Default::default()
        },
    ] {
        let base = render(&recipe, ColorProfile::Srgb);
        assert!(base
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .all(|p| p[0] == p[1] && p[1] == p[2]));
        let mut hidden = recipe.clone();
        hidden.saturation = -80.;
        hidden.vibrance = 60.;
        hidden.hsl[0].luminance = 100.;
        hidden.hsl[1].saturation = -100.;
        hidden.wheels.midtones = Wheel {
            x: 0.7,
            luminance: 60.,
            ..Default::default()
        };
        assert_eq!(render(&hidden, ColorProfile::Srgb).data, base.data);
        for band in 0..8 {
            let mut mixed = recipe.clone();
            mixed.tone_mixer[band] = 70.;
            let raised = render(&mixed, ColorProfile::Srgb);
            mixed.tone_mixer[band] = -70.;
            let lowered = render(&mixed, ColorProfile::Srgb);
            assert_eq!(
                &raised.data[..3],
                &base.data[..3],
                "neutral changed for band {band}"
            );
            assert_eq!(&lowered.data[..3], &base.data[..3]);
            let target = (band + 1) * 3;
            assert!(
                raised.data[target] > base.data[target],
                "band {band} did not brighten"
            );
            assert!(
                lowered.data[target] < base.data[target],
                "band {band} did not darken"
            );
            let opposite = ((band + 4) % 8 + 1) * 3;
            assert_eq!(raised.data[opposite], base.data[opposite]);
        }
        for profile in [
            ColorProfile::Srgb,
            ColorProfile::AdobeRgb,
            ColorProfile::ProPhotoRgb,
        ] {
            for warmth in [-100., -1., 1., 100.] {
                let mut toned = recipe.clone();
                toned.warmth = warmth;
                let pixels = render(&toned, profile);
                let p = &pixels.data[..3];
                assert!(
                    if warmth > 0. {
                        p[0] > p[2]
                    } else {
                        p[0] < p[2]
                    },
                    "{warmth} {profile:?}: {p:?}"
                );
                if profile == ColorProfile::Srgb {
                    let ratio = luminance(p) / luminance(&base.data[..3]);
                    assert!(
                        (ratio - 1.).abs() < 0.02,
                        "Warmth shifted mid-gray: {warmth}, {ratio}"
                    );
                }
            }
        }
        let mut white_source = image(1, 1);
        white_source.data.fill(1000.);
        let white = renderer
            .render(&white_source, &recipe, RenderOptions::default(), &cancel)
            .unwrap();
        for warmth in [-100., 100.] {
            let warmed = renderer
                .render(
                    &white_source,
                    &EditRecipe {
                        warmth,
                        ..recipe.clone()
                    },
                    RenderOptions::default(),
                    &cancel,
                )
                .unwrap();
            let ratio = luminance(&warmed.data) / luminance(&white.data);
            // Scanner endpoints are solved before the paper exposure correction.
            assert!(
                (ratio - 1.).abs() < 0.02,
                "Warmth shifted paper white: film {:?}, warmth {warmth}, {:?} -> {:?}",
                recipe.film.as_ref().map(|f| f.film),
                &white.data[..3],
                &warmed.data[..3]
            );
        }
        let toned = EditRecipe {
            warmth: 65.,
            tone_mixer: [20.; 8],
            ..recipe
        };
        let export = render(&toned, ColorProfile::Srgb);
        let preview = renderer
            .render(
                &source,
                &toned,
                RenderOptions {
                    rgba8: true,
                    ..Default::default()
                },
                &cancel,
            )
            .unwrap();
        for (rgb, rgba) in export
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .zip(preview.rgba8().unwrap().as_chunks::<4>().0.iter())
        {
            for channel in 0..3 {
                assert_eq!(rgba[channel], ((u32::from(rgb[channel]) + 128) / 257) as u8);
            }
        }
    }
    let color = EditRecipe {
        film: None,
        ..Default::default()
    };
    let mut controls = color.clone();
    controls.warmth = 100.;
    controls.tone_mixer = [100.; 8];
    assert_eq!(
        render(&color, ColorProfile::Srgb).data,
        render(&controls, ColorProfile::Srgb).data
    );
    source.data.fill(1000.);
    for warmth in [-100., 100.] {
        let white = renderer
            .render(
                &source,
                &EditRecipe {
                    film: None,
                    camera_profile: Some("Monochrome".into()),
                    warmth,
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        assert!(
            white.data.iter().all(|&v| v >= 65534),
            "Warmth tinted paper white"
        );
    }
}

#[test]
fn native_film_parameters_preserve_legacy_recipes_and_validate() {
    let defaults = FilmSettings::default();
    assert!(defaults.grain && !defaults.halation);
    assert_eq!(defaults.grain_params, Some(GrainParams::default()));
    assert_eq!(defaults.halation_params, Some(HalationParams::default()));
    for json in [r#"{}"#, r#"{"grain":false,"halation":true,"grainSize":2}"#] {
        let legacy: FilmSettings = serde_json::from_str(json).unwrap();
        assert!(legacy.grain_params.is_none() && legacy.halation_params.is_none());
        let saved = serde_json::to_string(&legacy).unwrap();
        assert_eq!(legacy, serde_json::from_str(&saved).unwrap());
    }
    let native: FilmSettings = serde_json::from_str(
        r#"{"grain":false,"halation":false,"grainParams":{},"halationParams":{}}"#,
    )
    .unwrap();
    assert!(!native.grain && !native.halation);
    assert_eq!(native.grain_params, defaults.grain_params);
    assert_eq!(native.halation_params, defaults.halation_params);
    for (group, field, high) in [
        ("grainParams", "blur", 4.),
        ("grainParams", "multUsmAmount", 4.),
        ("halationParams", "scatterAmount", 1.),
        ("halationParams", "scatterSpatialScale", 4.),
        ("halationParams", "halationAmount", 4.),
        ("halationParams", "halationSpatialScale", 4.),
    ] {
        for (value, valid) in [(0., true), (high, true), (-0.1, false), (high + 0.1, false)] {
            let mut json = serde_json::to_value(&defaults).unwrap();
            json[group][field] = value.into();
            let film: FilmSettings = serde_json::from_value(json).unwrap();
            assert_eq!(film.validate().is_ok(), valid, "{field}: {value}");
        }
    }
    for value in [-1., 100.1, f32::NAN, f32::INFINITY] {
        assert!(GrainParams {
            rms_granularity: [value; 3],
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    for json in [
        r#"{"grainParams":{"microSublayers":2}}"#,
        r#"{"halationParams":{"boostEv":1}}"#,
    ] {
        assert!(serde_json::from_str::<FilmSettings>(json).is_err());
    }
    assert_eq!(
        defaults,
        serde_json::from_str(&serde_json::to_string(&defaults).unwrap()).unwrap()
    );
}

#[test]
fn native_stock_baselines_and_zero_effects_are_preserved() {
    for index in 0..film::profile::FILM_COUNT {
        let profile = film::profile::load(index).unwrap();
        let stock = film::grain::Preset::for_profile(&profile);
        let stock_defaults = GrainParams {
            rms_granularity: stock.rms.map(|v| v as f32),
            ..Default::default()
        };
        stock_defaults.validate().unwrap();
        HalationParams::default().validate().unwrap();
        let (sigma, strength) = film::halation_preset(index as u32);
        assert_eq!(
            sigma,
            [if profile.info.use_kind == "cine" {
                50.
            } else {
                65.
            }; 3]
        );
        assert_eq!(
            strength,
            if profile.info.antihalation == "weak" {
                [0.08, 0.02, 0.]
            } else {
                [0.015, 0.005, 0.]
            }
        );
        let settings = FilmSettings {
            film: index as u32,
            halation: true,
            grain_params: Some(stock_defaults),
            ..Default::default()
        };
        let grain = film::grain::Grain::build_with_params(&profile, settings.grain_params.as_ref())
            .unwrap();
        assert_eq!(grain.preset.floor, stock.floor);
        assert_eq!(grain.preset.uniformity, stock.uniformity);
        assert_eq!(grain.preset.scales, stock.scales);
        assert_eq!(
            grain.preset.rms,
            film::channels(stock.rms, profile.is_monochrome())
        );
        let mut table = Vec::new();
        grain.append_to(&mut table);
        assert!(
            table.iter().all(|v| v.is_finite()),
            "{} native grain table",
            profile.info.stock
        );
        let grain_spatial = grain.spatial_for(7000., &settings);
        assert!(grain_spatial
            .dye_clouds
            .iter()
            .flatten()
            .all(|v| v.is_finite()));
        let spatial = film::Spatial::new(&settings, 3500., profile.is_monochrome());
        assert_eq!(spatial.halation[0], [sigma[0] as f32 / 10.; 3]);
    }
    let settings = FilmSettings {
        halation: true,
        grain_params: Some(GrainParams {
            mult_usm_amount: 0.,
            ..Default::default()
        }),
        halation_params: Some(HalationParams {
            scatter_amount: 0.,
            halation_amount: 0.,
            ..Default::default()
        }),
        ..Default::default()
    };
    let grain = film::grain::Grain::build_with_params(
        &film::profile::load(2).unwrap(),
        settings.grain_params.as_ref(),
    )
    .unwrap();
    let spatial = film::Spatial::new(&settings, 3500., false);
    let mut chain = Chain::new([[0.; 4]; PARAMETER_SLOTS]);
    let raw = chain.alloc();
    assert_eq!(chain.halation(raw, &spatial), raw);
    assert!(chain.passes.is_empty());
    let (passes, _) = build_passes(
        [[0.; 4]; PARAMETER_SLOTS],
        Some((&settings, &spatial, &grain.spatial_for(3500., &settings))),
        false,
        0.,
    );
    assert!(passes
        .iter()
        .all(|p| !matches!(p.entry, "grain_usm" | "grain_ratio")));
}

#[test]
#[ignore = "requires hardware GPU"]
fn gpu_native_film_controls() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    let source = split_scene(1024, 24);
    let base = FilmSettings {
        halation: true,
        couplers: 0.,
        ..Default::default()
    };
    let render = |film: FilmSettings, tiling| {
        renderer
            .render_tiled(
                &source,
                &EditRecipe {
                    film: Some(film),
                    seed: 17,
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
                tiling,
            )
            .unwrap()
            .data
    };
    let reference = render(base.clone(), (1024, 0));
    let mut legacy_changes = base.clone();
    legacy_changes.grain_size = 4.;
    legacy_changes.grain_amount = 0.;
    legacy_changes.grain_roughness = 1.;
    legacy_changes.grain_saturation = 0.;
    legacy_changes.halation_strength = 0.;
    legacy_changes.halation_radius = 0.006;
    legacy_changes.halation_midtones = 1.;
    legacy_changes.scatter_size_rgb = [0.; 3];
    legacy_changes.scatter_strength_rgb = [0.; 3];
    legacy_changes.halation_size_rgb = [0.; 3];
    legacy_changes.halation_strength_rgb = [0.; 3];
    assert_eq!(
        reference,
        render(legacy_changes, (1024, 0)),
        "Native parameters must ignore legacy macros"
    );
    type FilmEdit = fn(&mut FilmSettings);
    let edits: [(&str, FilmEdit); 7] = [
        ("RMS", |f| {
            f.grain_params.as_mut().unwrap().rms_granularity = [16., 12., 8.]
        }),
        ("blur", |f| f.grain_params.as_mut().unwrap().blur = 0.),
        ("USM", |f| {
            f.grain_params.as_mut().unwrap().mult_usm_amount = 0.
        }),
        ("scatter amount", |f| {
            f.halation_params.as_mut().unwrap().scatter_amount = 0.
        }),
        ("scatter scale", |f| {
            f.halation_params.as_mut().unwrap().scatter_spatial_scale = 4.
        }),
        ("halation amount", |f| {
            f.halation_params.as_mut().unwrap().halation_amount = 4.
        }),
        ("halation scale", |f| {
            f.halation_params.as_mut().unwrap().halation_spatial_scale = 4.
        }),
    ];
    for (name, edit) in edits {
        let mut settings = base.clone();
        edit(&mut settings);
        assert_ne!(
            reference,
            render(settings, (1024, 0)),
            "{name} must change pixels with a warm cache"
        );
        assert_eq!(
            reference,
            render(base.clone(), (1024, 0)),
            "{name} must not leave stale tables"
        );
    }
    let disabled = FilmSettings {
        grain: false,
        halation: false,
        ..base.clone()
    };
    let clean = render(disabled.clone(), (1024, 0));
    let mut changed = disabled;
    for (_, edit) in edits {
        edit(&mut changed);
    }
    assert_eq!(
        clean,
        render(changed, (1024, 0)),
        "Disabled stages must be identity"
    );
    let strong = FilmSettings {
        grain_params: Some(GrainParams {
            rms_granularity: [14., 10., 6.],
            blur: 4.,
            mult_usm_amount: 4.,
            ..Default::default()
        }),
        halation_params: Some(HalationParams {
            scatter_amount: 0.5,
            scatter_spatial_scale: 4.,
            halation_amount: 4.,
            halation_spatial_scale: 4.,
        }),
        ..base.clone()
    };
    assert_eq!(
        render(strong.clone(), (1024, 0)),
        render(strong, (128, 0)),
        "Native stages must not seam tiles"
    );
    let bw = FilmSettings {
        film: 20,
        paper: 8,
        grain_params: Some(GrainParams {
            rms_granularity: [14., 1., 100.],
            ..Default::default()
        }),
        ..base.clone()
    };
    let mut equal = bw.clone();
    equal.grain_params.as_mut().unwrap().rms_granularity = [14.; 3];
    assert_eq!(
        render(bw, (1024, 0)),
        render(equal, (1024, 0)),
        "B&W grain uses the first emulsion channel"
    );
    let zero = FilmSettings {
        grain_params: Some(GrainParams {
            rms_granularity: [0., f32::MIN_POSITIVE, 100.],
            ..Default::default()
        }),
        ..base
    };
    assert!(!render(zero, (1024, 0)).is_empty());
}

#[test]
#[ignore = "requires hardware GPU"]
fn gpu_generic_effects() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    let render = |source: &SceneLinearImage, effects: Option<EffectsSettings>| {
        renderer
            .render_tiled(
                source,
                &EditRecipe {
                    film: None,
                    camera_profile: None,
                    fill_light: 1.,
                    effects,
                    seed: 17,
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
                (1024, 0),
            )
            .unwrap()
            .data
    };
    let means = |data: &[u16]| {
        let mut sums = [0f64; 3];
        for pixel in data.as_chunks::<3>().0.iter() {
            for (sum, &v) in sums.iter_mut().zip(pixel.iter()) {
                *sum += f64::from(v);
            }
        }
        sums.map(|s| s / (data.len() / 3) as f64)
    };
    let source = split_scene(1024, 24);
    let off = render(&source, None);
    let on = render(
        &source,
        Some(EffectsSettings {
            grain: true,
            halation: true,
            ..Default::default()
        }),
    );
    assert_eq!(on.len(), off.len());
    assert_ne!(*on, *off, "effects must change pixels");
    let (before, after) = (means(&off), means(&on));
    println!("mean before {before:?} after {after:?}");
    for c in 0..3 {
        assert!(
            (after[c] - before[c]).abs() <= 0.1 * before[c],
            "channel {c}: {} vs {}",
            after[c],
            before[c]
        );
    }
    let mut flat = image(256, 64);
    flat.data.fill(0.18);
    let grain = Some(EffectsSettings {
        grain: true,
        ..Default::default()
    });
    let grained = render(&flat, grain);
    let clean = render(&flat, None);
    let deviation = |data: &[u16]| {
        let mean = means(data)[1];
        let n = (data.len() / 3) as f64;
        (data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| (f64::from(p[1]) - mean).powi(2))
            .sum::<f64>()
            / n)
            .sqrt()
    };
    println!(
        "flat stddev grain {} clean {}",
        deviation(&grained),
        deviation(&clean)
    );
    assert!(deviation(&grained) > 0.);
    assert!(deviation(&grained) > deviation(&clean));
}

#[test]
#[ignore = "requires hardware GPU"]
fn gpu_color_wheels() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    // Dark, middle and bright neutral patches, side by side. The default tone
    // curve shows them at about 0.12, 0.5 and 0.88.
    let mut source = image(96, 32);
    for (i, pixel) in source.data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        pixel.fill([0.0167, 0.105, 0.45][i % 96 / 32]);
    }
    // A ramp from black to white, finer than 0.001 in display value.
    let mut ramp = image(1024, 2);
    for (i, pixel) in ramp.data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        pixel.fill(0.005 * 200f32.powf((i % 1024) as f32 / 1023.));
    }
    // Display RGB (0..1) for every pixel.
    let pixels = |source: &SceneLinearImage, recipe: &EditRecipe| -> Vec<[f32; 3]> {
        let data = renderer
            .render(source, recipe, RenderOptions::default(), &cancel)
            .unwrap()
            .data;
        data.as_chunks::<3>()
            .0
            .iter()
            .map(|p| p.map(|v| f32::from(v) / 65535.))
            .collect()
    };
    let color = |wheels| EditRecipe {
        film: None,
        wheels,
        ..Default::default()
    };
    // The display RGB at the center of each patch.
    let render = |wheels: ColorWheels| -> [[f32; 3]; 3] {
        let data = pixels(&source, &color(wheels));
        std::array::from_fn(|patch| data[16 * 96 + 16 + 32 * patch])
    };
    let luma = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let toward_red = |c: [f32; 3], b: [f32; 3]| c[0] > b[0] + 0.005 && c[2] < b[2] - 0.002;
    let red = Wheel {
        x: 1.,
        ..Default::default()
    };
    // 240°, blue.
    let blue = Wheel {
        x: -0.5,
        y: -0.866,
        ..Default::default()
    };
    let hard = ColorWheels {
        blending: 0.,
        ..Default::default()
    };
    let base = render(ColorWheels::default());
    let lumas = base.map(luma);
    assert!(
        lumas[0] < 0.25 && (0.4..0.6).contains(&lumas[1]) && lumas[2] > 0.8,
        "{lumas:?}"
    );
    // Blending and Balance without a wheel change nothing.
    assert_eq!(
        render(ColorWheels {
            balance: 70.,
            ..hard
        }),
        base
    );
    // With a hard split, a shadows tint moves only the dark patch toward red,
    // and a highlights tint only the bright patch toward blue.
    let shadows = render(ColorWheels {
        shadows: red,
        ..hard
    });
    assert!(toward_red(shadows[0], base[0]), "{shadows:?} {base:?}");
    assert_eq!(shadows[1..], base[1..]);
    let highlights = render(ColorWheels {
        highlights: blue,
        ..hard
    });
    assert!(highlights[2][2] > base[2][2] + 0.02 && highlights[2][0] < base[2][0] - 0.01);
    assert_eq!(highlights[..2], base[..2]);
    // Full blending lets the shadows tint reach the middle patch, less strongly.
    let wide = render(ColorWheels {
        shadows: red,
        blending: 100.,
        ..Default::default()
    });
    assert!(toward_red(wide[1], base[1]), "{wide:?} {base:?}");
    assert!(wide[1][0] - base[1][0] < wide[0][0] - base[0][0]);
    assert_eq!(wide[2], base[2]);
    // Balance moves the borders: -100 puts the middle patch in the shadows,
    // +100 puts it in the highlights.
    let low = render(ColorWheels {
        shadows: red,
        balance: -100.,
        ..hard
    });
    assert!(toward_red(low[1], base[1]), "{low:?} {base:?}");
    let high = render(ColorWheels {
        highlights: blue,
        balance: 100.,
        ..hard
    });
    assert!(high[1][2] > base[1][2] + 0.02, "{high:?} {base:?}");
    // Luminance brightens its zone.
    let brighter = render(ColorWheels {
        midtones: Wheel {
            luminance: 50.,
            ..Default::default()
        },
        ..Default::default()
    });
    assert!(luma(brighter[1]) > lumas[1] + 0.05, "{brighter:?} {base:?}");
    // Blending 0 is a hard split. On the ramp, each pixel gets all of the
    // zone's tint or none of it, also immediately next to the borders at
    // display luma 1/3 (shadows, red) and 2/3 (highlights, blue).
    let base_ramp = pixels(&ramp, &color(ColorWheels::default()));
    for (border, wheels, c) in [
        (
            1. / 3.,
            ColorWheels {
                shadows: red,
                ..hard
            },
            0,
        ),
        (
            2. / 3.,
            ColorWheels {
                highlights: blue,
                ..hard
            },
            2,
        ),
    ] {
        let tinted = pixels(&ramp, &color(wheels));
        let mut sides = [false; 2];
        for (b, t) in base_ramp.iter().zip(&tinted).take(1024) {
            let l = luma(*b);
            // 16-bit output cannot tell these from the border.
            if (l - border).abs() < 1e-4 {
                continue;
            }
            let near = (l - border).abs() < 0.003;
            sides[usize::from(l > border)] |= near;
            let inside = if c == 0 { l < border } else { l > border };
            if !inside {
                assert_eq!(t, b, "luma {l} is outside the zone of {border}");
            } else if t[c] < 0.999 {
                assert!((t[c] - b[c] - 0.1).abs() < 0.002, "luma {l}: {t:?} {b:?}");
            } else {
                assert!(t[c] > b[c]);
            }
        }
        assert_eq!(sides, [true, true], "no ramp pixels next to {border}");
    }
    // Monochrome bypasses hidden color wheels and keeps their saved values.
    let lift = Wheel {
        luminance: 40.,
        ..Default::default()
    };
    let tint = Wheel { x: 1., ..lift };
    let bw_film = FilmSettings {
        grain_params: None,
        halation_params: None,
        film: 20,
        paper: 8,
        couplers: 0.,
        grain: false,
        ..Default::default()
    };
    for recipe in [
        EditRecipe {
            film: None,
            monochrome: Some(MonochromeSettings::default()),
            ..Default::default()
        },
        EditRecipe {
            film: Some(bw_film),
            ..Default::default()
        },
    ] {
        let graded = |midtones| EditRecipe {
            wheels: ColorWheels {
                midtones,
                ..Default::default()
            },
            ..recipe.clone()
        };
        let lifted = pixels(&source, &graded(lift));
        assert_eq!(pixels(&source, &graded(tint)), lifted);
        assert_eq!(lifted, pixels(&source, &recipe));
    }
}

#[test]
#[ignore = "requires a hardware GPU; run with --ignored"]
fn gpu_grain_intensity_has_headroom() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    let mut image = image(256, 128);
    image.data.fill(0.184);
    let render = |amount| {
        renderer
            .render(
                &image,
                &EditRecipe {
                    film: Some(FilmSettings {
                        film: 15,
                        negative: true,
                        grain_amount: amount,
                        grain_params: None,
                        grain_size: 1.5,
                        halation: false,
                        couplers: 0.,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
            )
            .unwrap()
    };
    let clean = render(0.);
    let rms = |amount| {
        let grained = render(amount);
        (grained
            .data
            .iter()
            .zip(clean.data.iter())
            .map(|(a, b)| (f64::from(*a) - f64::from(*b)).powi(2))
            .sum::<f64>()
            / clean.data.len() as f64)
            .sqrt()
    };
    let (stock, preset, maximum) = (rms(1.), rms(2.), rms(8.));
    assert!(
        preset > stock * 1.5,
        "Preset grain {preset} must exceed stock {stock}"
    );
    assert!(
        maximum > preset * 2.,
        "Maximum grain {maximum} must exceed preset {preset}"
    );
}

fn layer_test_image() -> SceneLinearImage {
    let mut img = image(4, 1);
    // Unequal layer gains and a non-diagonal camera transform. A display-RGB
    // channel selector cannot reproduce the four known sensor-layer patches.
    img.white_balance.camera_to_rgb = [
        1.75,
        -0.25,
        -0.2,
        -0.25,
        1.3 / 1.2,
        -0.2,
        -0.125,
        -0.25,
        2.8,
    ];
    img.white_balance.as_shot_neutral = [0.8, 1.2, 0.5];
    img.data = vec![
        0.1, 0.1, 0.1, // normalized layers: .10, .10, .10
        0.147, 0.051, 0.012, // normalized layers: .12, .06, .03
        0.002, 0.034, 0.182, // normalized layers: .02, .04, .14
        0.07, 0.15, -0.005, // normalized layers: .08, .13, .03
    ];
    img
}

#[test]
fn monochrome_layer_calibration_preserves_neutrals_and_iso() {
    let mut cal = layer_test_image().white_balance;
    let mix = color::monochrome_mix(&cal, MonochromeFilter::Blue).unwrap();
    assert!((mix.iter().sum::<f32>() - 1.).abs() < 1e-6);
    let blue = mix[0] * 0.07 + mix[1] * 0.15 + mix[2] * -0.005;
    assert!((blue + 0.07).abs() < 1e-6);
    cal.camera_to_rgb = cal.camera_to_rgb.map(|v| v * 2.);
    let doubled_iso = color::monochrome_mix(&cal, MonochromeFilter::Blue).unwrap();
    let bright = doubled_iso[0] * 0.14 + doubled_iso[1] * 0.30 + doubled_iso[2] * -0.01;
    assert!((bright - 2. * blue).abs() < 1e-6);
    cal.camera_to_rgb = [-1., 0., 0., 0., 1., 0., 0., 0., 1.];
    assert!(color::monochrome_mix(&cal, MonochromeFilter::Blue).is_err());
    cal.camera_to_rgb = [0.; 9];
    assert!(color::monochrome_mix(&cal, MonochromeFilter::Neutral).is_err());
}
#[test]
fn as_shot_slider_values_reproduce_the_camera_balance() {
    let mut cal = image(1, 1).white_balance;
    // A warm, slightly green as-shot neutral, as the camera would record it.
    let warm = color::white_balance_matrix(&cal, Some(3800.), 12.).unwrap();
    cal.as_shot_neutral = [1. / warm[0], 1., 1. / warm[8]];
    let (k, t) = as_shot_white_balance(&cal);
    let m = color::white_balance_matrix(&cal, Some(k), t).unwrap();
    for (i, v) in m.iter().enumerate() {
        let identity = if i % 4 == 0 { 1. } else { 0. };
        assert!((v - identity).abs() < 0.01, "{k} K, tint {t}: {m:?}");
    }
}
#[test]
fn prepared_input_checks_entire_image_and_cancellation() {
    let cancel = AtomicBool::new(false);
    let prepared = PreparedImage::new(image(4, 3), &cancel).unwrap();
    assert_eq!((prepared.image().width, prepared.image().height), (4, 3));
    let mut invalid = image(256, 32);
    *invalid.data.last_mut().unwrap() = f32::INFINITY;
    assert!(matches!(
        PreparedImage::new(invalid, &cancel),
        Err(RenderError::Invalid(_))
    ));
    let mut invalid = image(4, 3);
    invalid.data.pop();
    assert!(matches!(
        PreparedImage::new(invalid, &cancel),
        Err(RenderError::Invalid(_))
    ));
    assert!(matches!(
        PreparedImage::new(image(4, 3), &AtomicBool::new(true)),
        Err(RenderError::Cancelled)
    ));
}
#[test]
fn geometry_obeys_exif_crop_rotation_and_native_regions() {
    let mut img = image(80, 40);
    img.orientation = 6;
    let mut recipe = EditRecipe::default();
    let geom = geometry::Geometry::new(&img, &recipe, RenderOptions::default()).unwrap();
    assert_eq!((geom.width, geom.height), (40, 80));
    let at = geom.source_position(&img, 0.25, 0.75);
    assert!((at.0 - 59.5).abs() < 1e-4 && (at.1 - 29.5).abs() < 1e-4);
    recipe.crop = Some(Crop {
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
    });
    recipe.rotation = 1;
    let geom = geometry::Geometry::new(
        &img,
        &recipe,
        RenderOptions {
            region: Some(Crop {
                x: 0.,
                y: 0.,
                width: 0.5,
                height: 0.5,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!((geom.width, geom.height), (20, 10));
}
#[test]
fn bundled_spektrafilm_assets_cover_every_stock() {
    let grain_defaults: std::collections::HashMap<String, [f64; 3]> =
        serde_json::from_str(include_str!("../../../../src/shared/film-grain.json")).unwrap();
    assert_eq!(grain_defaults.len(), film::profile::FILM_COUNT);
    let stocks: Vec<serde_json::Value> = serde_json::from_str(STOCKS_JSON).unwrap();
    assert_eq!(stocks.len(), film::profile::PROFILE_JSON.len());
    assert_eq!(
        STOCKS_JSON,
        include_str!("../../../../src/shared/film-stocks.json"),
        "The renderer and frontend stock lists must stay identical"
    );
    for (index, stock) in stocks.iter().enumerate() {
        let profile = film::profile::load(index).unwrap();
        assert_eq!(profile.info.stock, stock["key"].as_str().unwrap());
        assert_eq!(profile.info.use_kind, stock["use"].as_str().unwrap());
        assert_eq!(
            profile.info.antihalation,
            stock["antihalation"].as_str().unwrap()
        );
        assert_eq!(
            profile.is_positive(),
            stock["isPositive"].as_bool().unwrap()
        );
        assert_eq!(profile.data.log_exposure.len(), film::CURVE_SAMPLES);
        assert_eq!(profile.data.density_curves.len(), film::CURVE_SAMPLES);
        assert_eq!(profile.data.log_sensitivity.len(), 81);
        assert_eq!(profile.data.channel_density.len(), 81);
        assert_eq!(profile.data.base_density.len(), 81);
        // The shader interpolates on a uniform grid; a non-uniform axis would
        // silently shift every density lookup. The B&W profiles round the
        // axis to 6 decimals, which is 2e-5 of a step.
        let axis = &profile.data.log_exposure;
        let step = (axis[axis.len() - 1] - axis[0]) / (axis.len() - 1) as f64;
        for (i, x) in axis.iter().enumerate() {
            assert!(
                (x - (axis[0] + step * i as f64)).abs() < 1e-6,
                "{index} axis"
            );
        }
        let monochrome = stock["monochrome"].as_bool().unwrap_or(false);
        assert_eq!(profile.is_monochrome(), monochrome, "{index} channel model");
        if index < film::profile::FILM_COUNT {
            assert_eq!(
                grain_defaults[&profile.info.stock],
                film::grain::Preset::for_profile(&profile).rms,
                "{} grain RMS",
                profile.info.stock
            );
            assert!(matches!(
                profile.info.reference_illuminant.as_str(),
                "D50" | "D55" | "T"
            ));
            // spektrafilm skips the camera window for B&W profiles.
            assert_eq!(
                profile.data.hanatos2025_adaptation_window_params.len() >= 4,
                !monochrome
            );
        } else {
            profile.model_curves().unwrap();
        }
    }
    assert_eq!(
        film::spectra::spectra_table().unwrap().len(),
        film::spectra::LUT_SIZE * film::spectra::LUT_SIZE * 81
    );
}

#[test]
fn bw_profiles_load_as_three_identical_channels() {
    let at = |key: &str| {
        film::profile::PROFILE_JSON
            .iter()
            .position(|(k, _)| *k == key)
            .unwrap()
    };
    let doublex = film::profile::load(at("kodak_doublex")).unwrap();
    assert!(doublex.is_monochrome() && !doublex.is_positive());
    // Middle development time (6.5 min of 4, 5, 6.5, 9, 12): third column.
    assert_eq!(doublex.data.base_density[0], 0.209166);
    assert!(doublex.data.density_curves[128]
        .iter()
        .all(|v| (v - 1.0960335481154473).abs() < 1e-12));
    for row in &doublex.data.channel_density {
        assert_eq!(
            *row,
            [1. / 3.; 3],
            "the three channels add up to the silver"
        );
    }
    for row in doublex.sensitivity() {
        assert!(row[0] == row[1] && row[1] == row[2] && row[0] >= 0.);
    }
    // No measurement means no sensitivity, not 10^0.
    assert_eq!(doublex.sensitivity()[60], [0.; 3]);
    let model = &doublex.data.density_curves_model;
    assert!(model.centers.len() == 3 && model.centers[0] == model.centers[2]);
    doublex.model_curves().unwrap();
    let trix = film::profile::load(at("kodak_trix")).unwrap();
    assert!(trix.is_monochrome() && trix.is_positive());
    assert_eq!(trix.data.base_density[0], 0.215639);
    let print = film::profile::load(at("kodak_2302")).unwrap();
    assert!(print.is_monochrome());
    assert_eq!(at("kodak_2302"), film::profile::FILM_COUNT + 8);
    let curves = print.model_curves().unwrap();
    assert!(curves
        .iter()
        .all(|row| row[0] == row[1] && row[1] == row[2]));
}

#[test]
fn taking_filters_use_the_measured_curves() {
    use film::filter::transmittance;
    let at = |t: [f64; 81], wl: usize| t[(wl - 380) / 5];
    let red = transmittance(MonochromeFilter::Red).unwrap();
    assert!(at(red, 450) < 0.01 && at(red, 700) > 0.9);
    let yellow = transmittance(MonochromeFilter::Yellow).unwrap();
    assert!(at(yellow, 400) < 0.05 && at(yellow, 600) > 0.9);
    let green = transmittance(MonochromeFilter::Green).unwrap();
    assert!(at(green, 540) > at(green, 450) && at(green, 540) > at(green, 650));
    assert!(transmittance(MonochromeFilter::Orange).is_some());
    assert!(transmittance(MonochromeFilter::Neutral).is_none());
    assert!(transmittance(MonochromeFilter::Blue).is_none());
}

#[test]
fn taking_filters_rebuild_only_bw_luts() {
    let settings = |film| FilmSettings {
        film,
        ..Default::default()
    };
    let color = film::FilmLut::build(2, Some(MonochromeFilter::Red)).unwrap();
    assert!(!color.monochrome);
    assert!(color.matches(&settings(2), Some(MonochromeFilter::Yellow)));
    assert!(color.matches(&settings(2), None));
    assert_eq!(
        color.data,
        film::FilmLut::build(2, None).unwrap().data,
        "colour films ignore the filter"
    );
    let bw = film::FilmLut::build(20, Some(MonochromeFilter::Red)).unwrap();
    assert!(bw.monochrome);
    assert!(bw.matches(&settings(20), Some(MonochromeFilter::Red)));
    assert!(!bw.matches(&settings(20), Some(MonochromeFilter::Yellow)));
    assert!(!bw.matches(&settings(20), None));
    let plain = film::FilmLut::build(20, Some(MonochromeFilter::Blue)).unwrap();
    assert!(
        plain.matches(&settings(20), None),
        "no blue curve: same as no filter"
    );
    assert_ne!(bw.data, plain.data);
    // Metering through the filter: a neutral subject exposes the film the same.
    let (reference, white) = film::data::reference_illuminant("D55");
    assert_eq!(reference[0], film::data::ILLUMINANT_D55_F64[0]);
    let sum = white[0] + white[1] + white[2];
    let (tx, ty) = film::data::xy_to_tc(white[0] / sum, white[1] / sum);
    let neutral = |lut: &film::FilmLut| film::spectra::sample(&lut.data, tx, ty)[0];
    for filter in [MonochromeFilter::Red, MonochromeFilter::Green] {
        let lut = film::FilmLut::build(21, Some(filter)).unwrap();
        let plain = film::FilmLut::build(21, None).unwrap();
        assert!(
            (neutral(&lut) / neutral(&plain) - 1.).abs() < 1e-12,
            "{filter:?}"
        );
    }
    let pair = film::FilmPair::build(
        &FilmSettings {
            film: 20,
            paper: 8,
            couplers: 1.,
            ..Default::default()
        },
        &bw,
        0.,
    )
    .unwrap();
    assert!(pair.monochrome);
    for (i, row) in pair.dir_matrix.iter().enumerate() {
        for (j, v) in row.iter().enumerate() {
            assert_eq!(*v == 0., i != j, "one silver layer inhibits only itself");
        }
    }
}

#[test]
fn every_film_paper_pair_prepares_finite_tables() {
    let films = film::profile::FILM_COUNT as u32;
    let papers = film::profile::PROFILE_JSON.len() as u32 - films;
    for stock in 0..films {
        let lut = film::FilmLut::build(stock, Some(MonochromeFilter::Red)).unwrap();
        assert!(lut.data.iter().all(|v| v.is_finite()) && lut.data.iter().any(|&v| v > 0.));
        for paper in 0..papers {
            for (negative, ev_paper, gamma) in [(false, None, 1.), (true, Some(1.5), 0.5)] {
                let settings = FilmSettings {
                    film: stock,
                    paper,
                    negative,
                    ev_paper,
                    ev_film: -1.25,
                    gamma_film: gamma,
                    gamma_paper: gamma,
                    tune_m: 0.5,
                    tune_y: -0.25,
                    ..Default::default()
                };
                let pair = film::FilmPair::build(&settings, &lut, 0.).unwrap();
                assert!(pair.matches(&settings, 0.));
                assert!(
                    pair.spectral.iter().all(|v| v.is_finite()),
                    "stock {stock}, paper {paper}"
                );
                assert!(
                    pair.print_normalization.is_finite() && pair.print_normalization > 0.,
                    "stock {stock}, paper {paper}: print exposure {}",
                    pair.print_normalization
                );
                assert!(pair.scan_normalization > 0.);
            }
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// A setting that changes the prepared tables must change the cache key, or a
/// preview silently reuses whichever pair the renderer happened to build
/// first. One variant per `FilmSettings` field, so a newly added field that
/// `FilmPair::build` reads cannot slip past the key.
#[test]
fn prepared_pairs_are_keyed_on_every_setting_they_read() {
    let base = FilmSettings::default();
    let variant = |f: fn(&mut FilmSettings)| {
        let mut s = base.clone();
        f(&mut s);
        s
    };
    let cases = [
        ("film", variant(|s| s.film = 7)),
        ("paper", variant(|s| s.paper = 5)),
        ("negative", variant(|s| s.negative = true)),
        ("ev_film", variant(|s| s.ev_film = 1.25)),
        ("ev_paper", variant(|s| s.ev_paper = Some(-2.))),
        ("couplers", variant(|s| s.couplers = 1.)),
        ("couplers_radius", variant(|s| s.couplers_radius = 0.01)),
        ("grain", variant(|s| s.grain = false)),
        ("grain_size", variant(|s| s.grain_size = 2.)),
        ("grain_amount", variant(|s| s.grain_amount = 0.5)),
        ("grain_roughness", variant(|s| s.grain_roughness = 0.5)),
        ("grain_saturation", variant(|s| s.grain_saturation = 0.25)),
        ("grain_params", variant(|s| s.grain_params = None)),
        (
            "native_grain_rms",
            variant(|s| s.grain_params.as_mut().unwrap().rms_granularity = [10., 5., 2.]),
        ),
        (
            "native_grain_blur",
            variant(|s| s.grain_params.as_mut().unwrap().blur = 2.),
        ),
        (
            "native_grain_usm",
            variant(|s| s.grain_params.as_mut().unwrap().mult_usm_amount = 0.),
        ),
        ("halation_params", variant(|s| s.halation_params = None)),
        (
            "native_scatter_amount",
            variant(|s| s.halation_params.as_mut().unwrap().scatter_amount = 0.5),
        ),
        (
            "native_scatter_scale",
            variant(|s| s.halation_params.as_mut().unwrap().scatter_spatial_scale = 2.),
        ),
        (
            "native_halation_amount",
            variant(|s| s.halation_params.as_mut().unwrap().halation_amount = 0.5),
        ),
        (
            "native_halation_scale",
            variant(|s| s.halation_params.as_mut().unwrap().halation_spatial_scale = 2.),
        ),
        ("halation", variant(|s| s.halation = true)),
        ("halation_strength", variant(|s| s.halation_strength = 1.)),
        ("halation_radius", variant(|s| s.halation_radius = 0.004)),
        ("halation_midtones", variant(|s| s.halation_midtones = 0.75)),
        (
            "scatter_size_rgb",
            variant(|s| s.scatter_size_rgb = [20., 10., 5.]),
        ),
        (
            "scatter_strength_rgb",
            variant(|s| s.scatter_strength_rgb = [0.5, 0.25, 0.1]),
        ),
        (
            "halation_size_rgb",
            variant(|s| s.halation_size_rgb = [120., 80., 40.]),
        ),
        (
            "halation_strength_rgb",
            variant(|s| s.halation_strength_rgb = [0.1, 0.05, 0.01]),
        ),
        ("gamma_film", variant(|s| s.gamma_film = 1.6)),
        ("gamma_paper", variant(|s| s.gamma_paper = 1.6)),
        ("tune_m", variant(|s| s.tune_m = 0.5)),
        ("tune_y", variant(|s| s.tune_y = -0.5)),
    ];
    let luts: Vec<film::FilmLut> = (0..film::profile::FILM_COUNT as u32)
        .map(|f| film::FilmLut::build(f, None).unwrap())
        .collect();
    let prepare = |s: &FilmSettings| {
        film::FilmPair::build(s, &luts[s.film as usize], 0.)
            .unwrap()
            .fingerprint()
    };
    let reference = prepare(&base);
    for (name, settings) in &cases {
        settings.validate().unwrap();
        let prepared = prepare(settings);
        let cached = film::FilmPair::build(&base, &luts[base.film as usize], 0.)
            .unwrap()
            .matches(settings, 0.);
        if prepared != reference {
            assert!(
                !cached,
                "{name} changes the prepared tables but reuses the cached pair"
            );
        }
        if *name == "ev_film" {
            // Its absence from the key is only sound while it stays out of the
            // prepared tables; it must scale the scene in the shader instead.
            assert_eq!(
                prepared, reference,
                "ev_film now changes the prepared tables and must join the cache key"
            );
        }
    }
}

/// Each channel scatters and halates at its own size, and a B&W film keeps its
/// identical channels identical.
#[test]
fn halation_sigmas_follow_each_channel() {
    let film = FilmSettings {
        halation_params: None,
        halation: true,
        scatter_size_rgb: [40., 20., 10.],
        halation_size_rgb: [150., 100., 50.],
        ..Default::default()
    };
    film.validate().unwrap();
    let colour = film::Spatial::new(&film, 2048., false);
    let tail = colour.scatter_tail;
    assert!(tail[0] > tail[1] && tail[1] > tail[2], "{tail:?}");
    let grain = film::grain::Grain::build(&film::profile::load(film.film as usize).unwrap())
        .unwrap()
        .spatial(2048., film.grain_size);
    let (passes, _) = build_passes(
        [[0.; 4]; PARAMETER_SLOTS],
        Some((&film, &colour, &grain)),
        false,
        0.,
    );
    for sigma in [
        colour.scatter_core,
        tail.map(|s| s * film::couplers::EXPONENTIAL_MAX_SIGMA),
        colour.halation[0],
        colour.halation[2],
    ] {
        assert!(
            passes
                .iter()
                .any(|p| p.entry == "blur" && p.params[21][..3] == sigma),
            "no blur pass at {sigma:?}"
        );
    }
    let silver = film::Spatial::new(&film, 2048., true);
    for sigma in [silver.scatter_core, silver.scatter_tail, silver.halation[2]] {
        assert_eq!(sigma, [sigma[0]; 3]);
    }
}

/// The editor sets each per-channel setting by red, with green and blue at
/// their default ratio. Each slider's maximum (EditorControls.tsx) must stay
/// valid in every channel.
#[test]
fn editor_halation_maxima_validate() {
    let at_red = |defaults: [f32; 3], red: f32| defaults.map(|v| v / defaults[0] * red);
    let d = FilmSettings::default();
    FilmSettings {
        scatter_size_rgb: at_red(d.scatter_size_rgb, 50.),
        scatter_strength_rgb: at_red(d.scatter_strength_rgb, 1.),
        halation_size_rgb: at_red(d.halation_size_rgb, 150.),
        halation_strength_rgb: at_red(d.halation_strength_rgb, 0.2),
        ..d.clone()
    }
    .validate()
    .unwrap();
}

#[test]
fn spektrafilm_license_ships_unmodified() {
    // CC BY-SA 4.0 obligates shipping the licence file as published; the
    // resource sync copies these bytes verbatim into the bundle.
    let digest = sha256(include_bytes!("../licenses/SPEKTRAFILM_LICENSE.txt"));
    assert_eq!(
        digest, "76d629501783ae52e8d63aee1e054c1e1a9713b9fe7d36fb306e25b1d14b24e9",
        "licenses/SPEKTRAFILM_LICENSE.txt changed; it must stay byte-identical"
    );
    for (shader, expected) in [
        (
            include_bytes!("render.wgsl").as_slice(),
            "b009bcbc34437fdde278d3b6c09455bc8ce7a45d5be9bd4409b519827e73a458",
        ),
        (
            include_bytes!("gamut.wgsl").as_slice(),
            "28e03614fc6efe2895b5c5161f04ab62d045171f9324d342df77f167f88b4158",
        ),
        (
            include_bytes!("grain.wgsl").as_slice(),
            "573f9a270909e8bb1e6788d8abdc24278d643a0c03d51303234b0d7bc27de6aa",
        ),
    ] {
        assert_eq!(
            sha256(shader),
            expected,
            "Shader changed: update provenance and renderer version"
        );
    }
}

fn gpu_geometry_matches_cpu_sampling(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let compare = |prepared: &PreparedImage, recipe: &EditRecipe, options: RenderOptions| {
        let source = prepared.image();
        let geom = geometry::Geometry::new(source, recipe, options).unwrap();
        let pixels = geom
            .sample(
                source,
                geom.region_x as i32,
                geom.region_y as i32,
                geom.width,
                geom.height,
                &cancel,
            )
            .unwrap();
        let sampled = SceneLinearImage {
            data: pixels
                .into_iter()
                .flat_map(|[r, g, b, _]| [r, g, b])
                .collect(),
            width: geom.width,
            height: geom.height,
            orientation: 1,
            white_balance: source.white_balance,
            color_mode_calibration: None,
        };
        let expected = renderer
            .render(
                &sampled,
                &EditRecipe {
                    crop: None,
                    rotation: 0,
                    straighten: 0.,
                    pitch: 0.,
                    yaw: 0.,
                    ..recipe.clone()
                },
                RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        let actual = renderer
            .render_prepared(prepared, recipe, options, &cancel)
            .unwrap();
        assert_eq!((actual.width, actual.height), (geom.width, geom.height));
        assert_eq!(actual.data.len(), expected.data.len());
        let delta = actual
            .data
            .iter()
            .zip(expected.data.iter())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            delta <= 4,
            "GPU geometry: orientation {}, rotation {}, straighten {}, pitch {}, yaw {}, max u16 delta {delta}",
            source.orientation,
            recipe.rotation,
            recipe.straighten,
            recipe.pitch,
            recipe.yaw,
        );
    };
    let digital = EditRecipe {
        film: None,
        ..Default::default()
    };
    for orientation in 1..=8 {
        let mut source = image(47, 29);
        source.orientation = orientation;
        source.data.iter_mut().for_each(|v| *v = *v * 3. - 0.1);
        let prepared = PreparedImage::new(source, &cancel).unwrap();
        compare(&prepared, &digital, RenderOptions::default());
        for rotation in 0..4 {
            compare(
                &prepared,
                &EditRecipe {
                    rotation,
                    straighten: if rotation % 2 == 0 { -17. } else { 13. },
                    crop: Some(Crop {
                        x: 0.07,
                        y: 0.1,
                        width: 0.82,
                        height: 0.77,
                    }),
                    ..digital.clone()
                },
                RenderOptions {
                    max_dimension: Some(17),
                    region: Some(Crop {
                        x: 0.12,
                        y: 0.09,
                        width: 0.71,
                        height: 0.79,
                    }),
                    ..Default::default()
                },
            );
        }
        compare(
            &prepared,
            &EditRecipe {
                straighten: 9.,
                pitch: -14.,
                yaw: 11.,
                crop: Some(Crop {
                    x: 0.1,
                    y: 0.12,
                    width: 0.8,
                    height: 0.7,
                }),
                ..digital.clone()
            },
            RenderOptions {
                max_dimension: Some(23),
                ..Default::default()
            },
        );
        if orientation == 1 {
            // Subpixel crops sample beyond pixel centers at both sensor corners.
            for corner in [0., 0.999] {
                compare(
                    &prepared,
                    &EditRecipe {
                        crop: Some(Crop {
                            x: corner,
                            y: corner,
                            width: 0.001,
                            height: 0.001,
                        }),
                        ..digital.clone()
                    },
                    RenderOptions::default(),
                );
            }
        }
    }
}

/// `ev_film` must expose the film and let the print follow: more exposure is a
/// brighter print at every level, and less exposure a darker one. spektrafilm's
/// `print_exposure_compensation` default re-solves the enlarger at the
/// compensated exposure and cancels exactly that, leaving only a curve-position
/// shift that lifts shadows as exposure drops.
fn gpu_film_exposure_moves_print_brightness(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    // A wedge from deep shadow to clipped highlight, so shadows are checked too.
    let mut wedge = image(64, 8);
    wedge.data = (0..64 * 8)
        .flat_map(|i| [0.9f32.powi(63 - (i % 64)) * 2.; 3])
        .collect();
    let level = |ev: f32| -> Vec<f64> {
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                ev_film: ev,
                grain: false,
                ..Default::default()
            }),
            ..Default::default()
        };
        let rendered = renderer
            .render(&wedge, &recipe, RenderOptions::default(), &cancel)
            .unwrap();
        // One luminance per wedge step, averaged down the constant columns.
        (0..64)
            .map(|x| {
                (0..8)
                    .flat_map(|y| rendered.data[((y * 64 + x) * 3)..][..3].iter())
                    .map(|&v| v as f64)
                    .sum::<f64>()
                    / 24.
            })
            .collect()
    };
    let base = level(0.);
    for (ev, brighter) in [(1.5f32, true), (-1.5, false)] {
        let shifted = level(ev);
        let moved = shifted
            .iter()
            .zip(&base)
            .filter(|(a, b)| (*a - *b).abs() > 64.)
            .count();
        assert!(
            moved >= 48,
            "{ev} EV of film exposure barely moved the print: {moved}/64 steps changed"
        );
        for (step, (shifted, base)) in shifted.iter().zip(&base).enumerate() {
            assert_eq!(
                shifted > base,
                brighter && *base < 65000.,
                "{ev} EV at wedge step {step}: {shifted} vs {base}"
            );
        }
    }
}

fn gpu_preview_matches_tiled(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let prepared = PreparedImage::new(image(513, 259), &cancel).unwrap();
    let recipe = EditRecipe {
        film: Some(FilmSettings {
            halation: true,
            grain: true,
            ..Default::default()
        }),
        sharpen: 35.,
        fill_light: 1.5,
        seed: 17,
        ..Default::default()
    };
    let options = RenderOptions {
        max_dimension: Some(2048),
        ..Default::default()
    };
    let whole = renderer
        .render_prepared(&prepared, &recipe, options, &cancel)
        .unwrap();
    let cached_size = renderer.workspace.lock().unwrap().as_ref().unwrap().size;
    let tiled = renderer
        .render_tiled(prepared.image(), &recipe, options, &cancel, (128, 0))
        .unwrap();
    assert_eq!((whole.width, whole.height), (513, 259));
    assert_eq!(whole.data.len(), tiled.data.len());
    assert_eq!(
        renderer.workspace.lock().unwrap().as_ref().unwrap().size,
        cached_size,
        "Smaller tiles must reuse the larger preview workspace"
    );
    let delta = whole
        .data
        .iter()
        .zip(tiled.data.iter())
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(
        delta <= 3,
        "whole preview versus tiles: max u16 delta {delta}"
    );
}

/// A scene dark on the left half and bright on the right.
fn split_scene(width: u32, height: u32) -> SceneLinearImage {
    let mut scene = image(width, height);
    for (i, rgb) in scene.data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        rgb.fill(if i as u32 % width < width / 2 {
            0.01
        } else {
            0.5
        });
    }
    scene
}

#[test]
fn fill_light_map_follows_sigma_photo_pro() {
    let weights = [4096. * 0.25, 4096. * 0.65, 4096. * 0.1, 0.];
    // A flat scene is its own local mean. Its target is halfway to 18% of
    // 4096 counts, then half a natural stop up.
    let mut flat = image(64, 48);
    flat.data.fill(0.1);
    let map = fill::map(&fill::Grid::new(&flat), 64, 48, weights);
    let l = fill::log_luma(409.6);
    assert!((map[0][0] - (0.5 * (l + 737.28f32.ln()) + 0.5)).abs() < 1e-5);
    for &[b, r] in &map[1..] {
        assert!((b - l).abs() < 1e-4 && (r - 2.).abs() < 1e-4, "{b} {r}");
    }
    // The dark half moves up and the bright half down.
    let map = fill::map(&fill::Grid::new(&split_scene(64, 48)), 64, 48, weights);
    let x = |column: usize, value: f32| {
        let [b, r] = map[1 + 24 * 64 + column];
        let l = fill::log_luma(4096. * value);
        r * (l - b) - (l - map[0][0])
    };
    assert!(x(4, 0.01) > 0. && x(60, 0.5) < 0.);
    // SPP's gain curve: k = 1.33 s, slope k / (|k| + 1/16)^0.25 at zero.
    let (k, inverse) = fill::curve(1.);
    assert!((k - 1.33).abs() < 1e-6 && (k * inverse - 1.2244).abs() < 1e-3);
    assert!(EditRecipe {
        fill_light: 2.1,
        ..Default::default()
    }
    .validate()
    .is_err());
}

fn gpu_fill_light(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    // Wider than the 1024-cell grid, so three pixels share a cell.
    let (width, height) = (2050, 6);
    let prepared = PreparedImage::new(split_scene(width, height), &cancel).unwrap();
    let render = |prepared: &PreparedImage, fill_light, temperature| {
        let recipe = EditRecipe {
            film: None,
            fill_light,
            temperature,
            ..Default::default()
        };
        renderer
            .render_prepared(prepared, &recipe, RenderOptions::default(), &cancel)
            .unwrap()
    };
    let at = |image: &RenderedImage, x: u32| image.data[((3 * width + x) * 3) as usize];
    let plain = render(&prepared, 0., None);
    let lit = render(&prepared, 1., None);
    assert!(
        at(&lit, 8) > at(&plain, 8) + 1000,
        "Fill Light lifts the dark side"
    );
    assert!(
        at(&lit, width - 8) < at(&plain, width - 8),
        "and keeps the bright side down"
    );
    assert!(
        at(&render(&prepared, -1., None), 8) < at(&plain, 8),
        "negative values darken it"
    );
    assert_eq!(
        render(&prepared, 0., None).data,
        plain.data,
        "zero is the plain render"
    );
    // White balance changes rebuild the map; changing it back restores it.
    let warm = render(&prepared, 1., Some(4000.));
    let fresh = PreparedImage::new(split_scene(width, height), &cancel).unwrap();
    assert_eq!(warm.data, render(&fresh, 1., Some(4000.)).data);
    assert_ne!(warm.data, lit.data);
    assert_eq!(
        render(&prepared, 1., None).data,
        lit.data,
        "the map is rebuilt"
    );
    // A half-size preview samples halfway between two source columns. As SPP
    // resamples its map, the gain comes from the mean of the four texels'
    // map values, not from the mean colour.
    let mut checker = image(64, 8);
    for (i, rgb) in checker.data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        rgb.fill(if i.is_multiple_of(2) { 0.01 } else { 0.5 });
    }
    let recipe = EditRecipe {
        film: None,
        fill_light: 1.,
        ..Default::default()
    };
    let half = RenderOptions {
        max_dimension: Some(32),
        ..Default::default()
    };
    let weights = renderer
        .plan_source(&checker, &recipe, half, None, Look::plain())
        .unwrap()
        .fill
        .unwrap();
    let map = fill::map(&fill::Grid::new(&checker), 64, 8, weights);
    let x = |column: usize, row: usize| {
        let value = if column.is_multiple_of(2) { 0.01 } else { 0.5 };
        let [b, r] = map[1 + row * 64 + column];
        let l = fill::log_luma(value * (weights[0] + weights[1] + weights[2]) + weights[3]);
        r * (l - b) - (l - map[0][0])
    };
    let (k, inverse) = fill::curve(1.);
    let mean = (x(32, 4) + x(33, 4) + x(32, 5) + x(33, 5)) / 4.;
    let gain = (k * (mean * inverse).tanh()).exp();
    let mut patch = image(32, 4);
    patch.data.fill(0.255 * gain);
    let expected = renderer
        .render(
            &patch,
            &EditRecipe {
                fill_light: 0.,
                ..recipe.clone()
            },
            RenderOptions::default(),
            &cancel,
        )
        .unwrap();
    let actual = renderer.render(&checker, &recipe, half, &cancel).unwrap();
    let (actual, expected) = (
        actual.data[(2 * 32 + 16) * 3],
        expected.data[(2 * 32 + 16) * 3],
    );
    assert!(
        actual.abs_diff(expected) <= 16,
        "midpoint {actual}, interpolated map {expected}"
    );
}

#[test]
fn small_overshoot_extends_the_last_tile() {
    assert_eq!(spans(1025, 1024, 128), [(0, 1025)]);
    assert_eq!(spans(1152, 1024, 128), [(0, 1152)]);
    assert_eq!(spans(1153, 1024, 128), [(0, 1024), (1024, 129)]);
    assert_eq!(spans(1025, 1024, 0), [(0, 1024), (1024, 1)]);
    assert_eq!(
        spans(2600, 1024, 128),
        [(0, 1024), (1024, 1024), (2048, 552)]
    );
    assert_eq!(spans(300, 1024, 128), [(0, 300)]);
}

#[test]
fn tiling_prefers_extended_tiles_and_falls_back_under_the_buffer_limit() {
    let candidates = tiling_candidates(1025, 1024, Some(4096));
    assert_eq!(candidates, [(1024, 128), (1024, 0), (512, 0)]);
    assert_eq!(tiling_candidates(1365, 2048, Some(2048))[0], (2048, 0));
    let margin = 10;
    let padded = |w: u64, h: u64| (w + 2 * margin as u64) * (h + 2 * margin as u64) * 16;
    let columns = |limit| {
        choose_tiling(1025, 1024, margin, limit, &candidates).map(|(columns, _, _)| columns)
    };
    assert_eq!(columns(u64::MAX), Some(vec![(0, 1025)]));
    // One byte short of the extended tile: two plain 1024 columns.
    let extended = padded(1025, 1024);
    assert_eq!(columns(extended - 1), Some(vec![(0, 1024), (1024, 1)]));
    // Below a 1024 tile: 512 tiles.
    assert_eq!(
        columns(padded(1024, 1024) - 1),
        Some(vec![(0, 512), (512, 512), (1024, 1)])
    );
    assert_eq!(columns(padded(512, 512) - 1), None);
    // The working buffer covers every tile of every layout.
    for (width, height) in [(1025, 1024), (2600, 1701), (4096, 4096), (300, 7)] {
        for limit in [u64::MAX, padded(1100, 1100), padded(1024, 1024)] {
            let candidates = tiling_candidates(width, height, Some(4096));
            let Some((columns, rows, bytes)) =
                choose_tiling(width, height, margin, limit, &candidates)
            else {
                continue;
            };
            assert!(bytes <= limit);
            assert_eq!(columns.iter().map(|c| c.1).sum::<u32>(), width);
            assert_eq!(rows.iter().map(|r| r.1).sum::<u32>(), height);
            for &(_, w) in &columns {
                for &(_, h) in &rows {
                    assert!(padded(w as u64, h as u64) <= bytes);
                }
            }
        }
    }
}

#[test]
fn frames_carry_a_header_and_reject_flagged_pixels() {
    let frame = checked_frame(2, 1, &[1, 2, 3, 255, 4, 5, 6, 255]).unwrap();
    assert_eq!(&frame[..FRAME_HEADER], b"X3F8\x02\0\0\0\x01\0\0\0\0\0\0\0");
    let image = RenderedImage {
        width: 2,
        height: 1,
        data: Pixels::Rgba8(frame),
        color_profile: ColorProfile::Srgb,
        full_width: 2,
        full_height: 1,
        region: None,
    };
    assert_eq!(image.rgba8().unwrap(), [1, 2, 3, 255, 4, 5, 6, 255]);
    assert_eq!(image.rgb8(), [1, 2, 3, 4, 5, 6]);
    assert!(matches!(
        checked_frame(2, 1, &[1, 2, 3, 255, 4, 5, 6, 0]),
        Err(RenderError::Gpu(_))
    ));
}

/// `pack` flags NaN and infinity with alpha 0 and quantizes like the CPU.
/// The digital tone curve, Whites/Blacks levels under extreme contrast, and
/// wide-gamut exports, on neutral and out-of-sRGB patches.
fn gpu_tone_and_levels(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let mut patches = image(7, 1);
    patches.data = vec![
        0., 0., 0., 0.18, 0.18, 0.18, 1., 1., 1., 4., 4., 4., -0.2, 0.6, 0.02, -0.5, 1., 0.1, 2.,
        0.1, 0.01,
    ];
    let render = |recipe: EditRecipe, color_profile| {
        renderer
            .render(
                &patches,
                &EditRecipe {
                    film: None,
                    ..recipe
                },
                RenderOptions {
                    color_profile,
                    ..Default::default()
                },
                &cancel,
            )
            .unwrap()
            .data
            .iter()
            .map(|&v| v as f64 / 65535.)
            .collect::<Vec<_>>()
    };
    let encode = |c: f64| {
        if c <= 0.0031308 {
            12.92 * c
        } else {
            1.055 * c.powf(1. / 2.4) - 0.055
        }
    };
    let tone = |x: f64| x.powf(1.63) / (x.powf(1.63) + 0.093);
    let plain = render(EditRecipe::default(), ColorProfile::Srgb);
    assert!(plain[0] < 1e-4, "black stays black: {}", plain[0]);
    for (patch, x) in [(1, 0.18), (2, 1.), (3, 4.)] {
        assert!(
            (plain[patch * 3] - encode(tone(x))).abs() < 0.01,
            "scene {x} renders {} not {}",
            plain[patch * 3],
            encode(tone(x))
        );
    }
    let extreme = |whites, blacks| EditRecipe {
        contrast: 100.,
        whites,
        blacks,
        ..Default::default()
    };
    let floor = render(extreme(0., 100.), ColorProfile::Srgb);
    assert!(
        (floor[0] - 0.15).abs() < 0.002,
        "Blacks +100 must lift black to the floor under contrast: {}",
        floor[0]
    );
    let ceiling = render(extreme(-100., 0.), ColorProfile::Srgb);
    assert!(
        (ceiling[9] - 0.75).abs() < 0.002,
        "Whites -100 must lower white to the ceiling under contrast: {}",
        ceiling[9]
    );
    let crushed = render(
        EditRecipe {
            blacks: -100.,
            ..Default::default()
        },
        ColorProfile::Srgb,
    );
    let stretched = render(
        EditRecipe {
            whites: 100.,
            ..Default::default()
        },
        ColorProfile::Srgb,
    );
    assert!(crushed[3] < plain[3] && stretched[3] > plain[3]);
    assert!(
        stretched[6] > 0.999,
        "Whites +100 pulls sensor white to white"
    );
    // Out-of-sRGB greens fit Adobe RGB and ProPhoto; the tone curve must keep
    // their red channel instead of clipping it.
    let adobe = render(EditRecipe::default(), ColorProfile::AdobeRgb);
    assert!(adobe[12] > 0.01, "Adobe RGB red clipped: {}", adobe[12]);
    let prophoto = render(EditRecipe::default(), ColorProfile::ProPhotoRgb);
    for patch in [4, 5] {
        assert!(
            prophoto[patch * 3] > 0.01,
            "ProPhoto red clipped on patch {patch}: {}",
            prophoto[patch * 3]
        );
    }
    // A small Blacks or Whites move must not throw those colours away.
    let lifted = render(
        EditRecipe {
            blacks: 1.,
            ..Default::default()
        },
        ColorProfile::AdobeRgb,
    );
    assert!(
        (lifted[12] - adobe[12]).abs() < 0.01,
        "Blacks +1 moved Adobe red {} -> {}",
        adobe[12],
        lifted[12]
    );
    let lowered = render(
        EditRecipe {
            whites: -1.,
            ..Default::default()
        },
        ColorProfile::ProPhotoRgb,
    );
    assert!(
        (lowered[18] - prophoto[18]).abs() < 0.01,
        "Whites -1 moved ProPhoto red {} -> {}",
        prophoto[18],
        lowered[18]
    );
    // Sharpening comes before the levels, so its overshoot at an edge cannot
    // pass the floor or the ceiling, with or without film. They hold the
    // luminance; film dyes leave a slight tint around it.
    let mut step = image(16, 4);
    step.data = (0..16 * 4)
        .flat_map(|i| [if i % 16 < 8 { 0. } else { 4. }; 3])
        .collect();
    for film in [None, Some(FilmSettings::default())] {
        let edges = renderer
            .render(
                &step,
                &EditRecipe {
                    contrast: 100.,
                    whites: -100.,
                    blacks: 100.,
                    sharpen: 100.,
                    film: film.clone(),
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
            )
            .unwrap();
        let decode = |v: u16| {
            let v = v as f64 / 65535.;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        for pixel in edges.data.as_chunks::<3>().0 {
            let y = encode(
                0.2126 * decode(pixel[0]) + 0.7152 * decode(pixel[1]) + 0.0722 * decode(pixel[2]),
            );
            assert!(
                (0.148..=0.752).contains(&y),
                "film {}: {pixel:?} has luminance {y} outside the floor and ceiling",
                film.is_some()
            );
        }
    }
}

/// Film looks reach the scanner's white and black levels, and the camera's
/// metered gray prints as 18% gray: spektrafilm's scanner correction plus
/// the metering that stands in for its auto exposure.
fn gpu_film_scanner_levels(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let metered = camera::fallback_metered_gray() as f32;
    let mut patches = image(3, 1);
    patches.data = [0., metered, 64.].iter().flat_map(|&v| [v; 3]).collect();
    let encode = |c: f64| 1.055 * c.powf(1. / 2.4) - 0.055;
    let scan_white = ((0.98 + 0.055) / 1.055f64).powf(2.4);
    let compressed_white = film::gamut::compress_output_gamut([scan_white; 3], ColorProfile::Srgb)
        .map(encode)
        .iter()
        .sum::<f64>()
        / 3.;
    for (name, film) in [
        ("color print", FilmSettings::default()),
        (
            "slide",
            FilmSettings {
                film: 18,
                negative: true,
                ..Default::default()
            },
        ),
        (
            "B&W print",
            FilmSettings {
                film: 20,
                paper: 8,
                ..Default::default()
            },
        ),
        (
            "B&W slide",
            FilmSettings {
                film: 21,
                negative: true,
                ..Default::default()
            },
        ),
    ] {
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                grain: false,
                ..film
            }),
            ..Default::default()
        };
        let rendered = renderer
            .render(&patches, &recipe, RenderOptions::default(), &cancel)
            .unwrap();
        let mean = |i: usize| {
            rendered.data[i * 3..][..3]
                .iter()
                .map(|&v| v as f64)
                .sum::<f64>()
                / 3.
                / 65535.
        };
        let (black, gray, white) = (mean(0), mean(1), mean(2));
        assert!((black - 0.01).abs() < 0.008, "{name}: black {black}");
        assert!(
            (white - compressed_white).abs() < 0.01,
            "{name}: white {white}, expected {compressed_white}"
        );
        assert!(
            (gray - encode(0.184)).abs() < 0.03,
            "{name}: metered gray {gray}"
        );
    }
}

/// Large grain blurs over several pixels. Tiles must still match the whole
/// frame, which needs the grain blur in the tile overlap.
fn gpu_grain_blur_tiles(renderer: &Renderer) {
    let film = FilmSettings {
        grain_params: None,
        grain_size: 4.,
        grain_roughness: 1.,
        ..Default::default()
    };
    let spatial = film::Spatial::new(&film, 2048., false);
    let grain = film::grain::Grain::build(&film::profile::load(film.film as usize).unwrap())
        .unwrap()
        .spatial(2048., film.grain_size);
    assert!(grain.blur >= 1.);
    let (passes, _) = build_passes(
        [[0.; 4]; PARAMETER_SLOTS],
        Some((&film, &spatial, &grain)),
        false,
        0.,
    );
    assert!(passes
        .iter()
        .any(|p| p.entry == "blur" && p.params[21][0] == grain.blur));
    let cancel = AtomicBool::new(false);
    let img = image(2048, 40);
    let recipe = EditRecipe {
        film: Some(film),
        seed: 17,
        ..Default::default()
    };
    let whole = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (2048, 0))
        .unwrap();
    let tiles = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (128, 0))
        .unwrap();
    assert_eq!(whole.data, tiles.data, "grain blur must not seam tiles");
}

fn gpu_pack_flags_non_finite(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let source = renderer.upload(&image(1, 1), &cancel).unwrap();
    let tile = Tile {
        x: 0,
        y: 0,
        width: 4,
        height: 1,
        origin: [0, 0],
    };
    let plan = Plan {
        width: 4,
        height: 1,
        full_width: 4,
        full_height: 1,
        region: None,
        margin: 0,
        tiles: vec![tile],
        passes: Vec::new(),
        output: 0,
        buffer_bytes: 64,
        tables: None,
        curves: Vec::new(),
        fill: None,
    };
    let pixels: [[f32; 4]; 4] = [
        [0.5, 0.25, 1., 1.],
        [f32::NAN, 0., 0., 1.],
        [0., f32::INFINITY, 0., 1.],
        [2., -1., 0.0001, 1.],
    ];
    let mut cached = renderer.workspace.lock().unwrap();
    *cached = Some(renderer.new_workspace(64));
    let workspace = cached.as_mut().unwrap();
    // Working buffers take no queue writes; fill this one at creation.
    workspace.buffers[0] = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Non-finite pixels"),
        size: 64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: true,
    });
    workspace.buffers[0]
        .slice(..)
        .get_mapped_range_mut()
        .copy_from_slice(bytemuck::cast_slice(&pixels));
    workspace.buffers[0].unmap();
    renderer.frame_buffer(workspace, 16);
    let mut encoder = renderer.encode(&source, workspace, &plan, &tile, true);
    let (_, frame, readback, _) = workspace.frame.as_ref().unwrap();
    encoder.copy_buffer_to_buffer(frame, 0, readback, 0, 16);
    renderer.queue.submit(Some(encoder.finish()));
    let bytes = renderer
        .read(readback, 16, &cancel, |bytes| Ok(bytes.to_vec()))
        .unwrap();
    *cached = None;
    let expected = |v: f32| quantize8(quantize16(v));
    assert_eq!(
        bytes[..4],
        [expected(0.5), expected(0.25), expected(1.), 255]
    );
    assert_eq!(
        (bytes[7], bytes[11]),
        (0, 0),
        "non-finite pixels: {bytes:?}"
    );
    assert_eq!(bytes[12..], [255, 0, expected(0.0001), 255]);
    assert!(checked_frame(4, 1, &bytes).is_err());
}

/// Previews packed to RGBA8 on the GPU equal the 16-bit export path reduced
/// to 8 bits, and an extended last tile changes no pixel.
fn gpu_rgba8_and_tiling(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let img = image(513, 259);
    let recipe = EditRecipe {
        film: Some(FilmSettings {
            halation: true,
            grain: true,
            ..Default::default()
        }),
        sharpen: 35.,
        seed: 17,
        ..Default::default()
    };
    let rgba8 = RenderOptions {
        rgba8: true,
        ..Default::default()
    };
    // 513 = 4 x 128 + 1: plain tiling adds a column of 1-pixel tiles.
    let plain = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (128, 0))
        .unwrap();
    let extended = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (128, 16))
        .unwrap();
    assert!(
        plain.data == extended.data,
        "extended tiles must not move pixels"
    );
    for tiling in [(128, 0), (128, 16), (1024, 0)] {
        let packed = renderer
            .render_tiled(&img, &recipe, rgba8, &cancel, tiling)
            .unwrap();
        let bytes = packed.rgba8().unwrap();
        assert_eq!(bytes.len(), 513 * 259 * 4);
        assert!(bytes.as_chunks::<4>().0.iter().all(|p| p[3] == 255));
        assert!(
            packed.rgb8() == plain.rgb8(),
            "RGBA8 packing must match the 16-bit path, tiling {tiling:?}"
        );
        assert_eq!(packed.png().unwrap(), plain.png().unwrap());
    }
    let plan = renderer
        .plan_source(&img, &recipe, rgba8, None, Look::plain())
        .unwrap();
    assert_eq!(plan.tiles.len(), 1);
    assert_eq!(plan.passes.last().unwrap().entry, "output");
    assert!(plan.passes.iter().all(|pass| pass.params[0] == [0.; 4]));
    assert_eq!(
        plan.slot0(&plan.tiles[0])[..2],
        [
            (513 + 2 * plan.margin) as f32,
            (259 + 2 * plan.margin) as f32
        ]
    );
    let tables = plan.tables.clone().unwrap();
    let again = renderer
        .plan_source(&img, &recipe, rgba8, None, Look::plain())
        .unwrap();
    assert!(
        Arc::ptr_eq(&tables, again.tables.as_ref().unwrap()),
        "an unchanged film must keep its tables"
    );
    let prepared = PreparedImage::new(img, &cancel).unwrap();
    renderer
        .render_prepared(&prepared, &recipe, rgba8, &cancel)
        .unwrap();
    assert!(prepared.gpu.lock().unwrap().is_some());
}

fn gpu_bw_film(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    // Gray, red, blue, green and dark gray patches.
    let mut source = image(5, 1);
    source.data = vec![
        0.18, 0.18, 0.18, 0.4, 0.05, 0.05, 0.05, 0.08, 0.4, 0.05, 0.3, 0.05, 0.03, 0.03, 0.03,
    ];
    let render = |film: FilmSettings, filter| {
        let recipe = EditRecipe {
            film: Some(film),
            monochrome: Some(MonochromeSettings { filter }),
            ..Default::default()
        };
        let rendered = renderer
            .render(&source, &recipe, RenderOptions::default(), &cancel)
            .unwrap();
        rendered
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                assert!(
                    p[0] == p[1] && p[1] == p[2],
                    "B&W film must be neutral: {p:?}"
                );
                p[0] as f64
            })
            .collect::<Vec<_>>()
    };
    // No couplers or grain: their blurs would mix these one-pixel patches.
    let doublex = FilmSettings {
        grain_params: None,
        halation_params: None,
        film: 20,
        paper: 8,
        couplers: 0.,
        grain: false,
        ..Default::default()
    };
    let plain = render(doublex.clone(), MonochromeFilter::Neutral);
    let red = render(doublex.clone(), MonochromeFilter::Red);
    let green = render(doublex.clone(), MonochromeFilter::Green);
    // A red filter lightens red and darkens blue; a green one does the reverse
    // for green against red. Metering through the filter keeps gray close.
    assert!(
        red[1] - red[2] > plain[1] - plain[2] + 2000.,
        "{plain:?} {red:?}"
    );
    assert!(
        green[3] - green[1] > plain[3] - plain[1] + 2000.,
        "{plain:?} {green:?}"
    );
    assert!((red[0] - plain[0]).abs() < 1000., "{plain:?} {red:?}");
    assert!(plain[0] > plain[4] + 5000.);
    // Blue has no measured curve: it renders as no filter.
    assert_eq!(render(doublex.clone(), MonochromeFilter::Blue), plain);
    // One silver layer halates once: only the first channel's sizes and
    // strengths count. The output is neutralized anyway, so compare against
    // the same settings in every channel.
    let mut edge = image(2048, 2);
    for (i, v) in edge.data.iter_mut().enumerate() {
        *v = if (i / 3) % 2048 < 1024 { 4. } else { 0.02 };
    }
    let halated = |scatter: [f32; 3], size: [f32; 3], strength: [f32; 3]| {
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                halation: true,
                scatter_size_rgb: scatter,
                halation_size_rgb: size,
                halation_strength_rgb: strength,
                ..doublex.clone()
            }),
            monochrome: Some(MonochromeSettings::default()),
            ..Default::default()
        };
        renderer
            .render(&edge, &recipe, RenderOptions::default(), &cancel)
            .unwrap()
            .data
    };
    let uneven = halated([40., 20., 10.], [150., 100., 50.], [0.2, 0., 0.1]);
    assert_eq!(uneven, halated([40.; 3], [150.; 3], [0.2; 3]));
    assert_ne!(uneven, halated([40.; 3], [150.; 3], [0.; 3]));
    // One silver layer: every channel draws the same grains. The output is
    // neutralized anyway, so check the draw itself: identical channel noise
    // has no chroma for the grain saturation control to remove.
    let mut flat = image(2000, 2);
    flat.data.fill(0.18);
    let grain = |grain: bool, grain_saturation: f32| {
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                grain,
                grain_amount: 2.,
                grain_saturation,
                ..doublex.clone()
            }),
            monochrome: Some(MonochromeSettings::default()),
            ..Default::default()
        };
        renderer
            .render(&flat, &recipe, RenderOptions::default(), &cancel)
            .unwrap()
            .data
    };
    assert_ne!(
        grain(true, 1.),
        grain(false, 1.),
        "grain must be visible here"
    );
    assert_eq!(grain(true, 1.), grain(true, 0.));
    // Reversal Tri-X is viewed directly, so a brighter scene stays brighter.
    let trix = render(
        FilmSettings {
            film: 21,
            paper: 8,
            negative: true,
            couplers: 0.,
            grain: false,
            ..Default::default()
        },
        MonochromeFilter::Neutral,
    );
    assert!(trix[0] > trix[4] + 5000., "{trix:?}");
    // Without a print to normalize, gray still holds through the filter.
    let trix_red = render(
        FilmSettings {
            film: 21,
            paper: 8,
            negative: true,
            couplers: 0.,
            grain: false,
            ..Default::default()
        },
        MonochromeFilter::Red,
    );
    assert!(
        (trix_red[0] - trix[0]).abs() < 300.,
        "{trix:?} {trix_red:?}"
    );
}

fn gpu_monochrome(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let source = layer_test_image();
    let cases = [
        (MonochromeFilter::Neutral, [0.1, 0.07, 0.2 / 3., 0.08]),
        (MonochromeFilter::Red, [0.1, 0.18, 0., 0.03]),
        (MonochromeFilter::Orange, [0.1, 0.165, 0.005, 0.0425]),
        (MonochromeFilter::Yellow, [0.1, 0.15, 0.01, 0.055]),
        (MonochromeFilter::Green, [0.1, 0.045, 0., 0.205]),
        (MonochromeFilter::Blue, [0.1, 0., 0.24, -0.07]),
    ];
    for (filter, expected) in cases {
        for exposure in [0., -1.] {
            let recipe = EditRecipe {
                film: None,
                monochrome: Some(MonochromeSettings { filter }),
                exposure,
                ..Default::default()
            };
            let rendered = renderer
                .render(&source, &recipe, RenderOptions::default(), &cancel)
                .unwrap();
            for (pixel, value) in rendered.data.as_chunks::<3>().0.iter().zip(expected) {
                // The digital tone curve maps neutrals the same in any primaries.
                // The output clips a mix below zero to black.
                let scene: f64 = (value * 2f64.powf(exposure as f64)).max(0.);
                let linear = scene.powf(1.63) / (scene.powf(1.63) + 0.093);
                let encoded = if linear <= 0.0031308 {
                    12.92 * linear
                } else {
                    1.055 * linear.powf(1. / 2.4) - 0.055
                };
                let encoded = (encoded * 65535.).round() as u16;
                assert_eq!(pixel[0], pixel[1]);
                assert_eq!(pixel[1], pixel[2]);
                assert!(
                    pixel[0].abs_diff(encoded) <= 3,
                    "{filter:?}: {pixel:?} vs {encoded}"
                );
            }
        }
    }
    let legacy: EditRecipe = serde_json::from_str(r#"{"film":null}"#).unwrap();
    let explicit: EditRecipe = serde_json::from_str(r#"{"film":null,"monochrome":null}"#).unwrap();
    let color = renderer
        .render(&source, &legacy, RenderOptions::default(), &cancel)
        .unwrap();
    let disabled = renderer
        .render(&source, &explicit, RenderOptions::default(), &cancel)
        .unwrap();
    assert_eq!(color.data, disabled.data);
    assert!(color
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .any(|p| p[0] != p[1] && p[1] != p[2]));

    let mut img = image(96, 64);
    img.white_balance = source.white_balance;
    let mut recipe = EditRecipe {
        monochrome: Some(MonochromeSettings {
            filter: MonochromeFilter::Red,
        }),
        film: Some(FilmSettings {
            halation: true,
            grain_saturation: 1.,
            ..Default::default()
        }),
        sharpen: 35.,
        temperature: Some(4700.),
        tint: 15.,
        ..Default::default()
    };
    recipe.curves.red.insert(1, Point { x: 0.5, y: 0.8 });
    recipe.curves.blue.insert(1, Point { x: 0.5, y: 0.2 });
    for (filter, _) in cases {
        recipe.monochrome = Some(MonochromeSettings { filter });
        for color_profile in [
            ColorProfile::Srgb,
            ColorProfile::AdobeRgb,
            ColorProfile::ProPhotoRgb,
        ] {
            let rendered = renderer
                .render(
                    &img,
                    &recipe,
                    RenderOptions {
                        color_profile,
                        ..Default::default()
                    },
                    &cancel,
                )
                .unwrap();
            assert!(
                rendered
                    .data
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .all(|p| p[0] == p[1] && p[1] == p[2]),
                "Colored film/grain/curves tinted {filter:?} {color_profile:?}"
            );
            assert_ne!(rendered.data.iter().min(), rendered.data.iter().max());
        }
    }
    let full = renderer
        .render(&img, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    let tiled = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (24, 0))
        .unwrap();
    assert!(full
        .data
        .iter()
        .zip(tiled.data.iter())
        .all(|(a, b)| a.abs_diff(*b) <= 3));
    let region = renderer
        .render(
            &img,
            &recipe,
            RenderOptions {
                region: Some(Crop {
                    x: 0.25,
                    y: 0.25,
                    width: 0.5,
                    height: 0.5,
                }),
                ..Default::default()
            },
            &cancel,
        )
        .unwrap();
    let expected: Vec<u16> = (16..48)
        .flat_map(|row| full.data[(row * 96 + 24) * 3..(row * 96 + 72) * 3].to_vec())
        .collect();
    assert!(region
        .data
        .iter()
        .zip(&expected)
        .all(|(a, b)| a.abs_diff(*b) <= 3));
    let png = image::load_from_memory(&full.png().unwrap())
        .unwrap()
        .to_rgb8();
    assert!(png.pixels().all(|p| p[0] == p[1] && p[1] == p[2]));
    assert!(image::load_from_memory(&full.jpeg(95).unwrap()).is_ok());
}

fn gpu_raw_color(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let source = layer_test_image();
    let render = |image: &SceneLinearImage, recipe: &EditRecipe| {
        renderer
            .render(image, recipe, RenderOptions::default(), &cancel)
            .unwrap()
            .data
    };
    let plain = EditRecipe {
        film: None,
        ..Default::default()
    };
    // At the as-shot gains with no mix, the output is the normalized layers.
    // The same values as plain scene RGB must render the same pixels.
    let layers = [
        [0.1, 0.1, 0.1],
        [0.12, 0.06, 0.03],
        [0.02, 0.04, 0.14],
        [0.08, 0.13, 0.03],
    ];
    let gains = as_shot_channel_gains(&source.white_balance);
    for (matrix, order) in [
        ([1., 0., 0., 0., 1., 0., 0., 0., 1.], [0, 1, 2]),
        ([0., 0., 1., 0., 1., 0., 1., 0., 0.], [2, 1, 0]),
    ] {
        let raw = EditRecipe {
            raw_color: Some(RawColor { gains, matrix }),
            ..plain.clone()
        };
        let mut expected = image(4, 1);
        expected.data = layers.iter().flat_map(|l| order.map(|c| l[c])).collect();
        let (got, want) = (render(&source, &raw), render(&expected, &plain));
        assert!(
            got.iter()
                .zip(want.iter())
                .all(|(g, w)| g.abs_diff(*w) <= 2),
            "{matrix:?}: {:?} vs {:?}",
            &got[..],
            &want[..]
        );
        // Temperature and tint do not apply in raw mode.
        let warm = EditRecipe {
            temperature: Some(3000.),
            tint: 40.,
            ..raw.clone()
        };
        assert_eq!(render(&source, &warm), got);
    }
    // Equal rows render gray, and warmth tones them as on other monochrome looks.
    let row = [0.6, 0.3, 0.1];
    let mono = EditRecipe {
        raw_color: Some(RawColor {
            gains,
            matrix: [row, row, row].concat().try_into().unwrap(),
        }),
        ..plain.clone()
    };
    let gray = render(&source, &mono);
    assert!(
        gray.chunks(3).all(|p| p[0] == p[1] && p[1] == p[2]),
        "{gray:?}"
    );
    let warm = render(
        &source,
        &EditRecipe {
            warmth: 80.,
            ..mono
        },
    );
    assert!(warm[0] > warm[2], "{:?}", &warm[..3]);
}

#[test]
#[ignore = "requires hardware GPU; cargo test -p x3f-render gpu_pipeline -- --ignored --nocapture"]
fn gpu_pipeline() {
    let renderer = Renderer::new().unwrap();
    eprintln!("GPU: {}", renderer.adapter_name);
    gpu_geometry_matches_cpu_sampling(&renderer);
    gpu_preview_matches_tiled(&renderer);
    gpu_film_exposure_moves_print_brightness(&renderer);
    gpu_monochrome(&renderer);
    gpu_raw_color(&renderer);
    gpu_bw_film(&renderer);
    gpu_rgba8_and_tiling(&renderer);
    gpu_pack_flags_non_finite(&renderer);
    gpu_tone_and_levels(&renderer);
    gpu_grain_blur_tiles(&renderer);
    gpu_film_scanner_levels(&renderer);
    gpu_fill_light(&renderer);
    let img = image(96, 64);
    let cancel = AtomicBool::new(false);
    let recipe = EditRecipe {
        film: None,
        ..Default::default()
    };
    let base = renderer
        .render(&img, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    let prepared = PreparedImage::new(image(96, 64), &cancel).unwrap();
    let repeated = renderer
        .render_prepared(&prepared, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    assert_eq!(
        base.data, repeated.data,
        "Prepared rendering must preserve exact pixels"
    );
    let changed = renderer
        .render_prepared(
            &prepared,
            &EditRecipe {
                exposure: 1.25,
                ..recipe.clone()
            },
            RenderOptions::default(),
            &cancel,
        )
        .unwrap();
    assert_ne!(base.data, changed.data);
    let restored = renderer
        .render_prepared(&prepared, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    assert_eq!(
        base.data, restored.data,
        "Recipe changes must not alter RAW input"
    );
    cancel.store(true, Ordering::Relaxed);
    assert!(matches!(
        renderer.render_prepared(&prepared, &recipe, RenderOptions::default(), &cancel),
        Err(RenderError::Cancelled)
    ));
    cancel.store(false, Ordering::Relaxed);
    let resumed = renderer
        .render_prepared(&prepared, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    assert_eq!(
        base.data, resumed.data,
        "Cancellation must leave caches reusable"
    );
    // wgpu defers this callback to the next submit/poll. The warmed render reaches
    // tile submission before cancellation, exercising pending/mapped readback cleanup.
    let submitted_cancel = Arc::new(AtomicBool::new(false));
    let on_done = submitted_cancel.clone();
    renderer
        .queue
        .on_submitted_work_done(move || on_done.store(true, Ordering::Relaxed));
    assert!(!submitted_cancel.load(Ordering::Relaxed));
    assert!(matches!(
        renderer.render_prepared(
            &prepared,
            &recipe,
            RenderOptions::default(),
            &submitted_cancel
        ),
        Err(RenderError::Cancelled)
    ));
    assert!(renderer.workspace.lock().unwrap().is_none());
    submitted_cancel.store(false, Ordering::Relaxed);
    let recovered = renderer
        .render_prepared(
            &prepared,
            &recipe,
            RenderOptions::default(),
            &submitted_cancel,
        )
        .unwrap();
    assert_eq!(
        base.data, recovered.data,
        "Submitted cancellation must be recoverable"
    );
    assert_eq!(base.data.len(), 96 * 64 * 3);
    assert!(base.data.iter().any(|&v| v > 10000));
    let png = base.png().unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert!(image::load_from_memory(&png).is_ok());
    let jpg = base.jpeg(90).unwrap();
    assert_eq!(&jpg[..2], b"\xff\xd8");
    assert!(image::load_from_memory(&jpg).is_ok());
    let mut film = FilmSettings {
        halation_params: None,
        grain: false,
        halation: true,
        couplers_radius: 0.02,
        halation_radius: 0.006,
        ..Default::default()
    };
    for stock in [2, 6, 18] {
        film.film = stock;
        film.negative = stock == 18;
        let recipe = EditRecipe {
            film: Some(film.clone()),
            sharpen: 35.,
            ..Default::default()
        };
        let full = renderer
            .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (512, 0))
            .unwrap();
        let tiles = renderer
            .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (24, 0))
            .unwrap();
        let delta = full
            .data
            .iter()
            .zip(tiles.data.iter())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            delta <= 3,
            "tile seams: stock {stock}, max u16 delta {delta}"
        );
    }
    let recipe = EditRecipe {
        film: Some(FilmSettings {
            grain: true,
            halation: true,
            ..Default::default()
        }),
        seed: 17,
        ..Default::default()
    };
    let full = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (512, 0))
        .unwrap();
    let tiles = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, (24, 0))
        .unwrap();
    assert_eq!(
        full.data, tiles.data,
        "grain must be independent of tile layout"
    );
    // A renderer that has already prepared one film/paper pair must not serve
    // it to a different recipe: cache staleness reaches pixels, so previews
    // would silently depend on whatever was rendered before them.
    let coupled = |amount: f32| {
        renderer
            .render(
                &img,
                &EditRecipe {
                    film: Some(FilmSettings {
                        couplers: amount,
                        grain: false,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                RenderOptions::default(),
                &cancel,
            )
            .unwrap()
            .data
    };
    assert_ne!(
        coupled(0.25),
        coupled(1.),
        "dye coupling must survive a warm film cache"
    );
    let crop = Crop {
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
    };
    let region = renderer
        .render(
            &img,
            &recipe,
            RenderOptions {
                region: Some(crop),
                ..Default::default()
            },
            &cancel,
        )
        .unwrap();
    let crop_recipe = EditRecipe {
        crop: Some(crop),
        ..recipe.clone()
    };
    let cropped = renderer
        .render(&img, &crop_recipe, RenderOptions::default(), &cancel)
        .unwrap();
    let expected: Vec<u16> = (16..48)
        .flat_map(|row| full.data[(row * 96 + 24) * 3..(row * 96 + 72) * 3].to_vec())
        .collect();
    for result in [&region, &cropped] {
        let delta = result
            .data
            .iter()
            .zip(&expected)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            delta <= 3,
            "crop/region changed effect coordinates: {delta}"
        );
    }
    for profile in [ColorProfile::AdobeRgb, ColorProfile::ProPhotoRgb] {
        let converted = renderer
            .render(
                &img,
                &recipe,
                RenderOptions {
                    color_profile: profile,
                    ..Default::default()
                },
                &cancel,
            )
            .unwrap();
        assert_ne!(converted.data, full.data);
        assert!(converted.png().is_ok());
        assert!(converted.jpeg(90).is_ok());
    }
    let films = film::profile::FILM_COUNT as u32;
    for stock in 0..films {
        for paper in 0..film::profile::PROFILE_JSON.len() as u32 - films {
            let mut flat = image(2, 2);
            flat.data.fill(0.184);
            let recipe = EditRecipe {
                film: Some(FilmSettings {
                    film: stock,
                    paper,
                    negative: film::profile::load(stock as usize).unwrap().is_positive(),
                    couplers: 0.,
                    grain: false,
                    ..Default::default()
                }),
                ..Default::default()
            };
            let render = renderer
                .render(&flat, &recipe, RenderOptions::default(), &cancel)
                .unwrap();
            assert_eq!(render.data.len(), 12, "stock {stock},paper {paper}");
        }
    }
    cancel.store(true, Ordering::Relaxed);
    assert!(matches!(
        renderer.render(&img, &recipe, RenderOptions::default(), &cancel),
        Err(RenderError::Cancelled)
    ));
}

/// Calibration generated by the pinned experimental Python pipeline.
#[test]
fn spektrafilm_calibration_matches_reference() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/experimental_calibration.json")).unwrap();
    let reference = &fixture["calibration"];
    let lut = film::FilmLut::build(2, None).unwrap();
    for node in reference["lut_nodes"].as_array().unwrap() {
        let i = node["i"].as_u64().unwrap() as usize;
        let j = node["j"].as_u64().unwrap() as usize;
        for c in 0..3 {
            let want = node["rgb"][c].as_f64().unwrap();
            let got = lut.data[(i * film::spectra::LUT_SIZE + j) * 3 + c];
            assert!(
                (got - want).abs() < want.abs() * 1e-9,
                "LUT ({i},{j})/{c}: {got} vs {want}"
            );
        }
    }
    let neutral =
        film::enlarger::neutral_filters("kodak_portra_endura", "kodak_portra_400").unwrap();
    let expected: [f64; 3] = serde_json::from_value(reference["neutral_filters"].clone()).unwrap();
    assert_eq!(neutral, expected);
    let illuminant = film::enlarger::filtered_illuminant(neutral);
    for sample in reference["illuminant_samples"].as_array().unwrap() {
        let i = sample["index"].as_u64().unwrap() as usize;
        let want = sample["value"].as_f64().unwrap();
        assert!((illuminant[i] - want).abs() < want * 1e-9);
    }
    let pair = film::FilmPair::build(&FilmSettings::default(), &lut, 0.).unwrap();
    let expected = reference["print_exposure_factor"].as_f64().unwrap();
    assert!((pair.print_normalization as f64 - expected).abs() < 1e-6);
}

/// Deterministic patches generated by the pinned experimental Python pipeline.
#[test]
#[ignore = "requires hardware GPU"]
fn gpu_experimental_reference() {
    let renderer = Renderer::new().unwrap();
    let cancel = AtomicBool::new(false);
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/experimental_patches.json")).unwrap();
    let inputs: Vec<[f32; 3]> =
        serde_json::from_value(fixture["input_linear_srgb"].clone()).unwrap();
    let mut source = image(inputs.len() as u32, 1);
    source.data = inputs.iter().flatten().copied().collect();
    let stock = |key: &str| {
        film::profile::PROFILE_JSON
            .iter()
            .position(|(name, _)| *name == key)
            .unwrap() as u32
    };
    let mut worst = 0u16;
    for case in fixture["cases"].as_array().unwrap() {
        let film_index = stock(case["film"].as_str().unwrap());
        let output = match case["output_space"].as_str().unwrap() {
            "sRGB" => ColorProfile::Srgb,
            "Adobe RGB (1998)" => ColorProfile::AdobeRgb,
            "ProPhoto RGB" => ColorProfile::ProPhotoRgb,
            other => panic!("unknown reference output {other}"),
        };
        // X3Fuse keeps B&W exports neutral in every output profile.
        if film_index >= 20 && output != ColorProfile::Srgb {
            continue;
        }
        let recipe = EditRecipe {
            film: Some(FilmSettings {
                film: film_index,
                paper: stock(case["paper"].as_str().unwrap()) - film::profile::FILM_COUNT as u32,
                negative: case["direct"].as_bool().unwrap(),
                grain: false,
                halation: false,
                couplers: case["couplers"].as_f64().unwrap() as f32,
                couplers_radius: 0.,
                gamma_film: case["gamma_film"].as_f64().unwrap() as f32,
                gamma_paper: case["gamma_paper"].as_f64().unwrap() as f32,
                tune_m: case["tune_m"].as_f64().unwrap() as f32,
                tune_y: case["tune_y"].as_f64().unwrap() as f32,
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut uploaded = renderer.upload(&source, &cancel).unwrap();
        let rendered = renderer
            .render_source(
                &source,
                &mut uploaded,
                &recipe,
                RenderOptions {
                    color_profile: output,
                    ..Default::default()
                },
                &cancel,
                None,
                Look::spektrafilm(),
            )
            .unwrap();
        let reference: Vec<[f64; 3]> = serde_json::from_value(case["linear_rgb"].clone()).unwrap();
        let encode = |v: f64| {
            let v = v.max(0.);
            let value = match output {
                ColorProfile::Srgb => {
                    if v <= 0.0031308 {
                        12.92 * v
                    } else {
                        1.055 * v.powf(1. / 2.4) - 0.055
                    }
                }
                ColorProfile::AdobeRgb => v.powf(256. / 563.),
                ColorProfile::ProPhotoRgb => {
                    if v < 1. / 512. {
                        16. * v
                    } else {
                        v.powf(1. / 1.8)
                    }
                }
            };
            (value.clamp(0., 1.) * 65535.).round() as u16
        };
        let mut case_worst = 0;
        for (i, (&got, want)) in rendered
            .data
            .iter()
            .zip(reference.iter().flatten().map(|v| encode(*v)))
            .enumerate()
        {
            case_worst = case_worst.max(got.abs_diff(want));
            if got.abs_diff(want) > 40 {
                eprintln!(
                    "{} {} gamma={}/{} couplers={} trim={}/{} patch={} channel={}: {got} vs {want}",
                    case["film"],
                    case["output_space"],
                    case["gamma_film"],
                    case["gamma_paper"],
                    case["couplers"],
                    case["tune_m"],
                    case["tune_y"],
                    i / 3,
                    i % 3
                );
            }
        }
        worst = worst.max(case_worst);
        eprintln!(
            "{} {} gamma={}/{} couplers={} trim={}/{} max delta {case_worst}",
            case["film"],
            case["output_space"],
            case["gamma_film"],
            case["gamma_paper"],
            case["couplers"],
            case["tune_m"],
            case["tune_y"]
        );
    }
    eprintln!("Experimental parity: max u16 delta {worst}");
    assert!(worst <= 40);
}

#[test]
fn effects_without_film_add_halation_and_grain_between_start_and_finish() {
    let reference = EffectsSettings {
        grain: true,
        halation: true,
        ..Default::default()
    }
    .reference();
    let spatial = film::Spatial::new(&reference, 3500., false);
    let grain = film::grain::Grain::build_with_params(
        &film::profile::load(reference.film as usize).unwrap(),
        reference.grain_params.as_ref(),
    )
    .unwrap()
    .spatial_for(3500., &reference);
    assert!(grain.margin() > 0.);
    // `plan_source` reserves a coupler margin only while couplers are on.
    assert_eq!(reference.couplers, 0.);
    let names = |film, effects_only| {
        let (passes, _) = build_passes([[0.; 4]; PARAMETER_SLOTS], film, effects_only, 0.);
        passes.iter().map(|p| p.entry).collect::<Vec<_>>()
    };
    let with = names(Some((&reference, &spatial, &grain)), true);
    for entry in [
        "halation_finish",
        "grain_to_density",
        "grain_layer",
        "grain_from_density",
    ] {
        assert!(with.contains(&entry), "{entry}");
    }
    assert!(!with.contains(&"expose") && !with.contains(&"scan"));
    let position = |entry| with.iter().position(|e| *e == entry).unwrap();
    assert!(position("adjust") < position("halation_finish"));
    assert!(position("halation_finish") < position("grain_to_density"));
    assert!(position("grain_from_density") < position("finish"));
    let (passes, _) = build_passes(
        [[0.; 4]; PARAMETER_SLOTS],
        Some((&reference, &spatial, &grain)),
        true,
        1.,
    );
    assert!(passes.len() < MAX_DISPATCHES as usize);
    for pass in &passes {
        assert_ne!(pass.buffers[0], pass.buffers[2]);
        assert_ne!(pass.buffers[1], pass.buffers[2]);
    }
    assert_eq!(names(None, true), ["sample", "adjust", "finish", "output"]);
}

#[test]
fn effects_passes_keep_the_fill_light_gain_in_alpha() {
    // The camera look reads the gain from alpha in `finish`.
    let shaders = [include_str!("render.wgsl"), include_str!("grain.wgsl")].join("\n");
    for entry in [
        "blur",
        "scatter_mix",
        "combine",
        "halation_finish",
        "grain_to_density",
        "grain_from_density",
    ] {
        let body = shaders
            .split(&format!("fn {entry}("))
            .nth(1)
            .and_then(|rest| rest.split("@compute").next())
            .unwrap();
        assert!(
            body.contains("].w);") && !body.contains(",1);"),
            "{entry} must pass alpha through"
        );
    }
}

#[test]
fn white_balance_gain_recipes_round_trip_and_validate() {
    let legacy = EditRecipe::default();
    assert!(!serde_json::to_value(&legacy)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("whiteBalanceGains"));
    assert_eq!(
        serde_json::from_str::<EditRecipe>("{}")
            .unwrap()
            .white_balance_gains,
        None
    );
    let mut recipe = EditRecipe {
        white_balance_gains: Some([2., 1., 0.5]),
        ..legacy
    };
    recipe.validate().unwrap();
    let json = serde_json::to_string(&recipe).unwrap();
    assert!(json.contains("whiteBalanceGains"));
    assert_eq!(serde_json::from_str::<EditRecipe>(&json).unwrap(), recipe);
    for value in [0., -1., f32::NAN, f32::INFINITY, 65., 1. / 128.] {
        recipe.white_balance_gains = Some([value, 1., 1.]);
        assert!(recipe.validate().is_err());
    }
}
