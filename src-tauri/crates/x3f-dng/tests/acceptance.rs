//! Real DNG files. Set X3FUSE_TEST_DNG to absolute paths, separated by the
//! platform path separator, then run with `--ignored --nocapture`.

use std::{path::PathBuf, sync::atomic::AtomicBool};

fn inputs() -> Vec<PathBuf> {
    let paths = std::env::var_os("X3FUSE_TEST_DNG").expect("X3FUSE_TEST_DNG is not set");
    std::env::split_paths(&paths).collect()
}

#[test]
#[ignore = "needs X3FUSE_TEST_DNG"]
fn real_dngs_inspect_prepare_and_preview() {
    let cancel = AtomicBool::new(false);
    for path in inputs() {
        let info = x3f_dng::inspect(&path, &cancel).unwrap();
        let start = std::time::Instant::now();
        let scene = x3f_dng::prepare(&path, &cancel).unwrap();
        let elapsed = start.elapsed();
        assert_eq!((scene.width, scene.height), (info.width, info.height));
        assert_eq!(scene.orientation, info.orientation);
        assert_eq!(
            scene.data.len(),
            scene.width as usize * scene.height as usize * 3
        );
        assert!(scene.data.iter().all(|v| v.is_finite()));
        let mut sorted: Vec<f32> = scene.data.iter().step_by(31).copied().collect();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f64| sorted[((sorted.len() - 1) as f64 * q) as usize];
        let mean = scene.data.iter().map(|v| f64::from(*v)).sum::<f64>() / scene.data.len() as f64;
        if info.monochrome {
            assert!(scene
                .data
                .as_chunks::<3>()
                .0
                .iter()
                .all(|p| p[0] == p[1] && p[1] == p[2]));
        }
        let jpeg = x3f_dng::preview(&path, &cancel).unwrap();
        let preview = image::load_from_memory(&jpeg).unwrap();
        assert_eq!(preview.color(), image::ColorType::Rgb8);
        assert!(preview.width().max(preview.height()) <= x3f_dng::PREVIEW_MAX_EDGE);
        let (pw, ph) = (preview.width() as f32, preview.height() as f32);
        let ratio = (pw / ph) / (info.width as f32 / info.height as f32);
        assert!((ratio - 1.).abs() < 0.01, "preview aspect {ratio}");
        println!(
            "{}: {info:?} prepare {elapsed:.2?} mean {mean:.4} p1 {:.4} p50 {:.4} p99 {:.4} max {:.4} wb {:?} preview {pw}x{ph}",
            path.display(),
            at(0.01),
            at(0.5),
            at(0.99),
            sorted[sorted.len() - 1],
            scene.white_balance.as_shot_neutral,
        );
    }
}

#[test]
#[ignore = "needs X3FUSE_TEST_DNG"]
fn cancellation_stops_prepare() {
    let cancel = AtomicBool::new(true);
    for path in inputs() {
        assert_eq!(x3f_dng::prepare(&path, &cancel).unwrap_err(), "Cancelled");
    }
}

#[test]
#[ignore = "needs X3FUSE_TEST_DNG_LEICA_M10_R pointing to L1003289.DNG"]
fn leica_m10_r_clipped_walls_render_white() {
    let path = PathBuf::from(std::env::var_os("X3FUSE_TEST_DNG_LEICA_M10_R").expect(
        "Set X3FUSE_TEST_DNG_LEICA_M10_R to the Leica M10-R L1003289.DNG regression sample",
    ));
    let cancel = AtomicBool::new(false);
    let scene = x3f_dng::prepare(&path, &cancel).unwrap();
    assert_eq!((scene.width, scene.height), (7872, 5208));
    let preview = image::load_from_memory(&x3f_dng::preview(&path, &cancel).unwrap())
        .unwrap()
        .into_rgb8();
    for (x, y) in [(2000, 1200), (2500, 1200), (3000, 1300)] {
        let i = ((y * scene.width + x) * 3) as usize;
        let rgb = &scene.data[i..i + 3];
        assert!(rgb.iter().all(|v| *v > 1.), "wall ({x}, {y}): {rgb:?}");
        let low = rgb.iter().copied().fold(f32::INFINITY, f32::min);
        let high = rgb.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        assert!(high / low < 1.25, "wall ({x}, {y}): {rgb:?}");
        let pixel = preview.get_pixel(
            x * preview.width() / scene.width,
            y * preview.height() / scene.height,
        );
        assert!(
            pixel.0.iter().all(|v| *v >= 250),
            "preview wall ({x}, {y}): {pixel:?}"
        );
    }
}

const METHODS: [x3f_dng::DemosaicMethod; 10] = {
    use x3f_dng::DemosaicMethod::*;
    [Amaze, Dcb, Ahd, Eahd, Hphd, Igv, Lmmse, Vng4, Mono, Fast]
};

#[test]
#[ignore = "needs X3FUSE_TEST_DNG"]
fn real_bayer_dngs_prepare_with_every_method() {
    let cancel = AtomicBool::new(false);
    for path in inputs() {
        let info = x3f_dng::inspect(&path, &cancel).unwrap();
        if !info.bayer {
            for method in METHODS {
                assert!(x3f_dng::prepare_with_method(&path, Some(method), &cancel).is_err());
            }
            println!("{}: not Bayer, every method refused", path.display());
            continue;
        }
        let start = std::time::Instant::now();
        let legacy = x3f_dng::prepare(&path, &cancel).unwrap();
        let full = start.elapsed();
        println!(
            "{}: {}x{} LibRaw {full:.2?}",
            path.display(),
            info.width,
            info.height
        );
        for at in [0.25, 0.5] {
            let stop = AtomicBool::new(false);
            let start = std::time::Instant::now();
            let result = std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(full.mul_f64(at));
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                x3f_dng::prepare(&path, &stop)
            });
            assert_eq!(result.unwrap_err(), "Cancelled");
            let latency = start.elapsed().saturating_sub(full.mul_f64(at));
            println!("  LibRaw cancel at {at}: latency {latency:.2?}");
        }
        for method in METHODS {
            let start = std::time::Instant::now();
            let scene = x3f_dng::prepare_with_method(&path, Some(method), &cancel).unwrap();
            let full = start.elapsed();
            assert_eq!((scene.width, scene.height), (legacy.width, legacy.height));
            assert!(scene.data.iter().all(|v| v.is_finite()));
            // Mean difference from the LibRaw route, per channel.
            let mean = |data: &[f32], c: usize| {
                data.iter()
                    .skip(c)
                    .step_by(3)
                    .map(|v| f64::from(*v))
                    .sum::<f64>()
                    / (data.len() / 3) as f64
            };
            let means: Vec<String> = (0..3)
                .map(|c| format!("{:.4}/{:.4}", mean(&scene.data, c), mean(&legacy.data, c)))
                .collect();
            // Cancel after half of the full time; report how long the rest took.
            let stop = AtomicBool::new(false);
            let start = std::time::Instant::now();
            let result = std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(full / 2);
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                x3f_dng::prepare_with_method(&path, Some(method), &stop)
            });
            let latency = start.elapsed().saturating_sub(full / 2);
            assert_eq!(result.unwrap_err(), "Cancelled");
            println!("  {method:?}: {full:.2?}, cancel latency {latency:.2?}, mean native/LibRaw {means:?}");
        }
    }
}
