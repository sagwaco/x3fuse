use super::*;
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
    }
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
    assert!((blue - 0.03).abs() < 1e-6);
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
    let stocks: Vec<serde_json::Value> = serde_json::from_str(STOCKS_JSON).unwrap();
    assert_eq!(stocks.len(), 28);
    assert_eq!(
        STOCKS_JSON,
        include_str!("../../../../src/shared/film-stocks.json"),
        "The renderer and frontend stock lists must stay identical"
    );
    for (index, stock) in stocks.iter().enumerate() {
        let profile = film::profile::load(index).unwrap();
        assert_eq!(profile.info.stock, stock["key"].as_str().unwrap());
        assert_eq!(profile.is_positive(), stock["isPositive"].as_bool().unwrap());
        assert_eq!(profile.data.log_exposure.len(), film::CURVE_SAMPLES);
        assert_eq!(profile.data.density_curves.len(), film::CURVE_SAMPLES);
        assert_eq!(profile.data.log_sensitivity.len(), 81);
        assert_eq!(profile.data.channel_density.len(), 81);
        assert_eq!(profile.data.base_density.len(), 81);
        // The shader interpolates on a uniform grid; a non-uniform axis would
        // silently shift every density lookup.
        let axis = &profile.data.log_exposure;
        let step = (axis[axis.len() - 1] - axis[0]) / (axis.len() - 1) as f64;
        for (i, x) in axis.iter().enumerate() {
            assert!((x - (axis[0] + step * i as f64)).abs() < 1e-9, "{index} axis");
        }
        if index < 20 {
            assert_eq!(
                film::data::reference_illuminant(&profile.info.reference_illuminant).0[0],
                film::data::ILLUMINANT_D55_F64[0],
                "film {index} must resolve to the D55 reference illuminant"
            );
            assert!(profile.data.hanatos2025_adaptation_window_params.len() >= 4);
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
fn every_film_paper_pair_prepares_finite_tables() {
    for stock in 0..20u32 {
        let lut = film::FilmLut::build(stock).unwrap();
        assert!(lut.data.iter().all(|v| v.is_finite()) && lut.data.iter().any(|&v| v > 0.));
        for paper in 0..8u32 {
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
                let pair = film::FilmPair::build(&settings, &lut).unwrap();
                assert!(pair.matches(&settings));
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
    let cases: [(&str, FilmSettings); 19] = [
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
        ("grain_saturation", variant(|s| s.grain_saturation = 0.25)),
        ("halation", variant(|s| s.halation = true)),
        ("halation_strength", variant(|s| s.halation_strength = 1.)),
        ("halation_radius", variant(|s| s.halation_radius = 0.004)),
        ("halation_midtones", variant(|s| s.halation_midtones = 0.75)),
        ("gamma_film", variant(|s| s.gamma_film = 1.6)),
        ("gamma_paper", variant(|s| s.gamma_paper = 1.6)),
        ("tune_m", variant(|s| s.tune_m = 0.5)),
        ("tune_y", variant(|s| s.tune_y = -0.5)),
    ];
    let luts: Vec<film::FilmLut> = (0..20).map(|f| film::FilmLut::build(f).unwrap()).collect();
    let prepare = |s: &FilmSettings| {
        film::FilmPair::build(s, &luts[s.film as usize])
            .unwrap()
            .fingerprint()
    };
    let reference = prepare(&base);
    for (name, settings) in &cases {
        settings.validate().unwrap();
        let prepared = prepare(settings);
        let cached = film::FilmPair::build(&base, &luts[base.film as usize])
            .unwrap()
            .matches(settings);
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

#[test]
fn spektrafilm_license_ships_unmodified() {
    // CC BY-SA 4.0 obligates shipping the licence file as published; the
    // resource sync copies these bytes verbatim into the bundle.
    let digest = sha256(include_bytes!("../licenses/SPEKTRAFILM_LICENSE.txt"));
    assert_eq!(
        digest, "76d629501783ae52e8d63aee1e054c1e1a9713b9fe7d36fb306e25b1d14b24e9",
        "licenses/SPEKTRAFILM_LICENSE.txt changed; it must stay byte-identical"
    );
    let shader = sha256(include_bytes!("render.wgsl"));
    assert_eq!(
        shader, "b2a80a72c5085b70b1a5b023ec3aa13873821e7e74e6bac815a86de74287a838",
        "render.wgsl changed; update assets/PROVENANCE.md and this hash, and          bump RENDER_VERSION if rendered pixels moved"
    );
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
        };
        let expected = renderer
            .render(
                &sampled,
                &EditRecipe {
                    crop: None,
                    rotation: 0,
                    straighten: 0.,
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
            .zip(&expected.data)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            delta <= 4,
            "GPU geometry: orientation {}, rotation {}, straighten {}, max u16 delta {delta}",
            source.orientation,
            recipe.rotation,
            recipe.straighten,
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
        .render_tiled(prepared.image(), &recipe, options, &cancel, 128)
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
        .zip(&tiled.data)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(
        delta <= 3,
        "whole preview versus tiles: max u16 delta {delta}"
    );
}

fn gpu_monochrome(renderer: &Renderer) {
    let cancel = AtomicBool::new(false);
    let source = layer_test_image();
    let cases = [
        (MonochromeFilter::Neutral, [0.1, 0.07, 0.2 / 3., 0.08]),
        (MonochromeFilter::Red, [0.1, 0.12, 0.02, 0.08]),
        (MonochromeFilter::Orange, [0.1, 0.105, 0.025, 0.0925]),
        (MonochromeFilter::Yellow, [0.1, 0.09, 0.03, 0.105]),
        (MonochromeFilter::Green, [0.1, 0.06, 0.04, 0.13]),
        (MonochromeFilter::Blue, [0.1, 0.03, 0.14, 0.03]),
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
                let linear: f64 = value * 2f64.powf(exposure as f64);
                let encoded = ((1.055 * linear.powf(1. / 2.4) - 0.055) * 65535.).round() as u16;
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
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, 24)
        .unwrap();
    assert!(full
        .data
        .iter()
        .zip(&tiled.data)
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

/// External parity guard against the real spektrafilm-rs binary, for when the
/// shader stages are edited. Opt in by building the oracle once:
///
/// ```sh
/// cd /path/to/spektrafilm-rs && cargo build --release -p spektrafilm-cli
/// SPEKTRAFILM_CLI=.../target/release/spektrafilm SPEKTRAFILM_DATA=.../data \
///   cargo test -p x3f-render spektrafilm_parity -- --ignored --nocapture
/// ```
///
/// Covers the bare chain: front pass, film develop, DIR matrix, print and
/// scan. Spatial stages are disabled on both sides because this crate skips
/// sub-pixel blurs that spektrafilm still convolves.
#[test]
#[ignore = "needs a spektrafilm-rs build; set SPEKTRAFILM_CLI and SPEKTRAFILM_DATA"]
fn spektrafilm_parity() {
    let (Ok(cli), Ok(data)) = (
        std::env::var("SPEKTRAFILM_CLI"),
        std::env::var("SPEKTRAFILM_DATA"),
    ) else {
        panic!("set SPEKTRAFILM_CLI and SPEKTRAFILM_DATA to run the parity oracle");
    };
    let dir = std::env::temp_dir().join("x3f-render-spektrafilm-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let (input, output, raw, config) = (
        dir.join("in.tiff"),
        dir.join("out.tiff"),
        dir.join("raw.bin"),
        dir.join("params.json"),
    );

    // Quantize to 16 bits first: the oracle only sees the TIFF.
    const N: u32 = 64;
    let quantized: Vec<u16> = (0..N * N)
        .flat_map(|i| {
            let (x, y) = ((i % N) as f32 / (N - 1) as f32, (i / N) as f32 / (N - 1) as f32);
            [x, y, 0.5 * (x + y)].map(|v| (v * 1.6 * 65535.).min(65535.).round() as u16)
        })
        .collect();
    let cancel = AtomicBool::new(false);
    x3f_core::output::tiff::write_rgb16(&quantized, N, N, &input, false, None, &cancel).unwrap();
    std::fs::write(
        &config,
        r#"{"camera":{"auto_exposure":false},
            "io":{"input_color_space":"sRGB","input_cctf_decoding":false,
                  "output_color_space":"sRGB","output_cctf_encoding":false,
                  "output_gamut_compress":{"algorithm":"off"}},
            "film_render":{"grain":{"active":false},"halation":{"active":false},
                           "glare":{"active":false},
                           "dir_couplers":{"amount":0.25,"diffusion_size_um":0.0,
                                           "diffusion_tail_weight":0.0}},
            "print_render":{"glare":{"active":false}},
            "scanner":{"unsharp_mask":[0.0,0.0]}}"#,
    )
    .unwrap();
    let status = std::process::Command::new(&cli)
        .args(["process"])
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .args(["--film", "kodak_portra_400", "--paper", "kodak_portra_endura"])
        .arg("--data-dir")
        .arg(&data)
        .arg("--params")
        .arg(&config)
        .arg("--raw-out")
        .arg(&raw)
        .status()
        .unwrap();
    assert!(status.success(), "spektrafilm CLI failed");
    let bytes = std::fs::read(&raw).unwrap();
    let reference: Vec<f64> = bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect();
    assert_eq!(reference.len(), quantized.len());

    let renderer = Renderer::new().unwrap();
    let source = SceneLinearImage {
        width: N,
        height: N,
        orientation: 1,
        data: quantized.iter().map(|&v| v as f32 / 65535.).collect(),
        white_balance: image(1, 1).white_balance,
    };
    let recipe = EditRecipe {
        film: Some(FilmSettings {
            grain: false,
            ..Default::default()
        }),
        ..Default::default()
    };
    let rendered = renderer
        .render(&source, &recipe, RenderOptions::default(), &cancel)
        .unwrap();
    let mut worst = 0u16;
    for (got, want) in rendered.data.iter().zip(&reference) {
        let want = want.clamp(0., 1.);
        let encoded = ((if want <= 0.0031308 {
            12.92 * want
        } else {
            1.055 * want.powf(1. / 2.4) - 0.055
        }) * 65535.)
            .round() as u16;
        worst = worst.max(got.abs_diff(encoded));
    }
    eprintln!("spektrafilm CLI parity: max u16 delta {worst} of 65535");
    assert!(worst <= 514, "max u16 delta {worst} exceeds 2/255");
    let _ = std::fs::remove_dir_all(&dir);
}

// Opt-in because headless CI may not expose a GPU. A requested GPU check MUST fail
// on unavailable hardware; it never silently exercises a CPU fallback.
#[test]
#[ignore = "requires hardware GPU; cargo test -p x3f-render gpu_pipeline -- --ignored --nocapture"]
fn gpu_pipeline() {
    let renderer = Renderer::new().unwrap();
    eprintln!("GPU: {}", renderer.adapter_name);
    gpu_geometry_matches_cpu_sampling(&renderer);
    gpu_preview_matches_tiled(&renderer);
    gpu_film_exposure_moves_print_brightness(&renderer);
    gpu_monochrome(&renderer);
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
            .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, 512)
            .unwrap();
        let tiles = renderer
            .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, 24)
            .unwrap();
        let delta = full
            .data
            .iter()
            .zip(&tiles.data)
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
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, 512)
        .unwrap();
    let tiles = renderer
        .render_tiled(&img, &recipe, RenderOptions::default(), &cancel, 24)
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
    for stock in 0..20 {
        for paper in 0..8 {
            let mut flat = image(2, 2);
            flat.data.fill(0.184);
            let recipe = EditRecipe {
                film: Some(FilmSettings {
                    film: stock,
                    paper,
                    negative: (15..=18).contains(&stock),
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
    // Reference values from spektrafilm-rs v0.1.2 (9dd59b0) on its CPU backend
    // with every stage this crate does not implement switched off: grain,
    // halation, glare, unsharp mask and output gamut compression off, auto
    // exposure off, linear sRGB in and out, DIR couplers at the recipe default.
    // Regeneration is documented in assets/PROVENANCE.md.
    let mut flat = image(8, 8);
    let neutral = FilmSettings {
        grain: false,
        ..Default::default()
    };
    let cases: [(FilmSettings, [f32; 3], [f64; 3]); 6] = [
        (
            neutral.clone(),
            [0.184; 3],
            [0.175920382142, 0.178913980722, 0.187772050500],
        ),
        (
            neutral.clone(),
            [0., 0., 0.],
            [0.003905232530, 0.004238163121, 0.005496182479],
        ),
        (
            neutral.clone(),
            [0.45, 0.28, 0.21],
            [0.409098744392, 0.289901643991, 0.239676132798],
        ),
        (
            neutral.clone(),
            [2., 2., 2.],
            [0.779674291611, 0.781614482403, 0.773847043514],
        ),
        (
            // Slide film scanned directly, skipping the paper entirely.
            FilmSettings {
                film: 18,
                negative: true,
                ..neutral.clone()
            },
            [0.184; 3],
            [0.188368186355, 0.181645467877, 0.183615848422],
        ),
        (
            // Enlarger trim: +10 magenta, -5 yellow filter units.
            FilmSettings {
                tune_m: 0.5,
                tune_y: -0.25,
                ..neutral.clone()
            },
            [0.184; 3],
            [0.172593876719, 0.223124980927, 0.139309808612],
        ),
    ];
    let mut worst = 0u16;
    for (settings, input, expected) in cases {
        flat.data = input.repeat(64);
        let recipe = EditRecipe {
            film: Some(settings.clone()),
            ..Default::default()
        };
        let rendered = renderer
            .render(&flat, &recipe, RenderOptions::default(), &cancel)
            .unwrap();
        let expected = expected.map(|v: f64| {
            ((if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            }) * 65535.)
                .round() as u16
        });
        for (value, reference) in rendered
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| p.iter().zip(expected))
        {
            worst = worst.max(value.abs_diff(reference));
            assert!(
                value.abs_diff(reference) <= 32,
                "spektrafilm patch {input:?} film {} paper {}: {value} vs {reference}",
                settings.film,
                settings.paper
            );
        }
    }
    eprintln!("spektrafilm parity: max u16 delta {worst} of 65535");
    cancel.store(true, Ordering::Relaxed);
    assert!(matches!(
        renderer.render(&img, &recipe, RenderOptions::default(), &cancel),
        Err(RenderError::Cancelled)
    ));
}

/// Values printed by spektrafilm-rs v0.1.2 (`9dd59b0`) for Portra 400 on
/// Portra Endura with `auto_exposure = false` and linear sRGB input, via
/// `Pipeline::{tc_lut, print_illuminant_slice, print_exposure_factor}`.
#[test]
fn spektrafilm_calibration_matches_reference() {
    let lut = film::FilmLut::build(2).unwrap();
    for (i, j, want) in [
        (0usize, 0usize, [8.037559559490e0, 3.838885502449e-1, 4.583906389200e0]),
        (37, 91, [6.727003906276e0, 3.026833599327e-1, 2.571768047361e0]),
        (95, 95, [1.409664979721e0, 2.087212094499e0, 1.883525499154e0]),
        (191, 191, [5.184326951427e-1, 6.284266336399e0, 9.586498740657e-2]),
        (10, 180, [9.282101411120e0, 2.261275489813e-1, 2.512172937174e0]),
    ] {
        let at = (i * film::spectra::LUT_SIZE + j) * 3;
        for (c, want) in want.iter().enumerate() {
            let got = lut.data[at + c];
            assert!(
                (got - want).abs() <= want.abs() * 1e-9,
                "tc lut ({i},{j}) channel {c}: {got:e} vs {want:e}"
            );
        }
    }
    let film = film::profile::load(2).unwrap();
    let paper = film::profile::load(23).unwrap();
    let neutral = film::enlarger::neutral_filters(&paper.info.stock, &film.info.stock).unwrap();
    assert_eq!(neutral, [0.0, 51.56801468495496, 52.53400422349596]);
    let illuminant = film::enlarger::filtered_illuminant(neutral);
    for (i, want) in [
        (0usize, 8.088674859767e-2),
        (20, 2.472911877067e-1),
        (40, 4.505604283922e-1),
        (60, 1.301948239188e0),
        (80, 4.145529258993e-1),
    ] {
        assert!(
            (illuminant[i] - want).abs() <= want * 1e-9,
            "enlarger illuminant {i}: {:e} vs {want:e}",
            illuminant[i]
        );
    }
    let settings = FilmSettings {
        film: 2,
        paper: 3,
        ..Default::default()
    };
    let pair = film::FilmPair::build(&settings, &lut).unwrap();
    let want = 8.357499185829e-1f64;
    let got = pair.print_normalization as f64;
    assert!(
        (got - want).abs() <= want * 1e-4,
        "print exposure factor: {got:e} vs {want:e}"
    );
}
