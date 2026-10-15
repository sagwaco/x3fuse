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
    let cases: [(&str, FilmSettings); 24] = [
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

/// Each channel scatters and halates at its own size, and a B&W film keeps its
/// identical channels identical.
#[test]
fn halation_sigmas_follow_each_channel() {
    let film = FilmSettings {
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
            "4b10d0ce5169a218f156d6da4485e0ff138a6b72be1bfdc8d05eec24209c46ef",
        ),
        (
            include_bytes!("gamut.wgsl").as_slice(),
            "28e03614fc6efe2895b5c5161f04ab62d045171f9324d342df77f167f88b4158",
        ),
        (
            include_bytes!("grain.wgsl").as_slice(),
            "e333d122de0ccded56e2cc330b5c846128cf4f3292f15059b2d725db6beede9d",
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

#[test]
#[ignore = "requires hardware GPU; cargo test -p x3f-render gpu_pipeline -- --ignored --nocapture"]
fn gpu_pipeline() {
    let renderer = Renderer::new().unwrap();
    eprintln!("GPU: {}", renderer.adapter_name);
    gpu_geometry_matches_cpu_sampling(&renderer);
    gpu_preview_matches_tiled(&renderer);
    gpu_film_exposure_moves_print_brightness(&renderer);
    gpu_monochrome(&renderer);
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
    let pair = film::FilmPair::build(&FilmSettings::default(), &lut).unwrap();
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
