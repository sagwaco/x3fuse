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
