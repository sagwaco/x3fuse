//! Sony ARW, Panasonic RW2 and DNG preview rules. Run with --ignored and the
//! sample variables of `_local/RAW_FORMATS_PLAN.md`. Each test uses temporary
//! input copies.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use x3fuse_app::{
    cache::{source_key, Memory, Store},
    conversion::validate_batch,
    editor::{Editor, RenderRequest},
    metadata::{basic_metadata, jpeg_size, upright_size, ExifTool},
    model::{BatchSettings, ConvertFile, OutputFormat, Rendering},
    preview::Previews,
    source::{Info, Kind},
    storage::Logs,
};

/// A copy of the sample in `variable`, in `directory`.
fn sample(variable: &str, directory: &Path) -> PathBuf {
    let input =
        PathBuf::from(std::env::var_os(variable).unwrap_or_else(|| panic!("Set {variable}")));
    assert!(input.is_absolute() && input.is_file(), "{variable}");
    let path = directory.join(input.file_name().unwrap());
    fs::copy(&input, &path).unwrap();
    path
}

fn exiftool(directory: &Path, logs: &Arc<Logs>, bundled: bool) -> Arc<ExifTool> {
    let root = if bundled {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool")
    } else {
        // Without ExifTool, only the caches can answer.
        directory.join("missing-exiftool")
    };
    Arc::new(ExifTool::new(root, directory.join("frames"), logs.clone()))
}

/// The upright width and height of a JPEG, with its own orientation.
fn upright(bytes: &[u8]) -> (u32, u32) {
    let (width, height) = upright_size(bytes, 1).expect("A JPEG");
    (width as u32, height as u32)
}

/// Waits for the background disk writes that follow a preview response.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("A cache-only request must not wait")
}

#[test]
#[ignore = "requires X3FUSE_TEST_ARW, X3FUSE_TEST_ARW_A7, X3FUSE_TEST_RW2 and X3FUSE_TEST_RW2_B"]
fn arw_and_rw2_import_as_bayer_libraw_sources() {
    let directory = tempfile::tempdir().unwrap();
    for variable in [
        "X3FUSE_TEST_ARW",
        "X3FUSE_TEST_ARW_A7",
        "X3FUSE_TEST_RW2",
        "X3FUSE_TEST_RW2_B",
    ] {
        let path = sample(variable, directory.path());
        assert_eq!(Kind::of(&path), Kind::Dng);
        let info = Info::read(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(info.kind, Kind::Dng, "{variable}");
        assert!(info.capabilities.bayer, "{variable}");
        assert!(info.capabilities.rendered_only && !info.capabilities.foveon);
        let raw = x3f_dng::inspect(&path, &AtomicBool::new(false)).unwrap();
        let swapped = (5..=8).contains(&raw.orientation);
        let upright = if swapped {
            [raw.height, raw.width]
        } else {
            [raw.width, raw.height]
        };
        assert_eq!(info.native_dimensions, Some(upright), "{variable}");
        // The A7 II is a portrait photo (orientation 8) of a landscape sensor.
        assert_eq!(swapped, variable == "X3FUSE_TEST_ARW_A7", "{variable}");
        if swapped {
            assert_eq!(info.orientation, Some(8));
            assert!(raw.width > raw.height && upright[1] > upright[0]);
        }
        let dto = basic_metadata(path.clone()).unwrap();
        assert!(dto.edit_error.is_none(), "{variable}: {:?}", dto.edit_error);
        assert_eq!(dto.source_kind, Kind::Dng);
        assert!(dto.capabilities.bayer);
        assert_eq!(dto.native_dimensions, Some(upright));
        eprintln!(
            "{variable}: native {upright:?}, orientation {:?}, crop {:?}",
            info.orientation, info.crop
        );
    }
}

#[tokio::test]
#[ignore = "requires the X3FUSE_TEST_* samples of the plan and bundled ExifTool"]
async fn embedded_preview_rules() {
    let directory = tempfile::tempdir().unwrap();
    let logs = Arc::new(Logs::new(directory.path().join("logs")));
    let exif = exiftool(directory.path(), &logs, true);
    exif.check().await.unwrap();
    let cache = directory.path().join("previews");
    let open = |bundled| {
        Previews::new(
            exiftool(directory.path(), &logs, bundled),
            Store::open(cache.clone(), vec![], true, 1 << 30, logs.clone()),
            Arc::new(Memory::new(1 << 30)),
        )
    };
    // (variable, 1:1 from the JPEG, thumbnail size, fit size), upright.
    let cases = [
        (
            "X3FUSE_TEST_DNG_FULL_PREVIEW",
            true,
            Some((1440, 960)),
            Some((7840, 5184)),
        ),
        ("X3FUSE_TEST_DNG_NO_PREVIEW", false, None, None),
        (
            "X3FUSE_TEST_ARW_A7",
            false,
            Some((1080, 1616)),
            Some((1080, 1616)),
        ),
        // A 4:3 shot: the 1440x1080 JPEG matches the 4:3 as-shot crop.
        (
            "X3FUSE_TEST_ARW",
            false,
            Some((1440, 1080)),
            Some((1440, 1080)),
        ),
        (
            "X3FUSE_TEST_RW2",
            false,
            Some((1920, 1440)),
            Some((1920, 1440)),
        ),
        (
            "X3FUSE_TEST_RW2_B",
            false,
            Some((1920, 1440)),
            Some((1920, 1440)),
        ),
    ];
    let paths: Vec<_> = cases
        .iter()
        .map(|(variable, ..)| sample(variable, directory.path()))
        .collect();
    let previews = open(true);
    let imported = previews.import(&paths).await;
    for ((variable, native, thumbnail, fit), path) in cases.iter().zip(&paths) {
        assert!(imported.contains_key(path), "{variable}");
        let info = Info::read(path, &AtomicBool::new(false)).unwrap();
        let expected = Some(*native);
        // 1: after import.
        assert_eq!(
            previews.has_embedded_full(path, false).await.unwrap(),
            expected,
            "{variable}"
        );
        let small = previews.get(path, false, false).await.unwrap().unwrap();
        let full = previews.get(path, true, false).await.unwrap().unwrap();
        // 2: after the full view warmed memory and disk.
        assert_eq!(
            previews.has_embedded_full(path, false).await.unwrap(),
            expected,
            "{variable}"
        );
        assert_eq!(
            within(previews.has_embedded_full(path, true))
                .await
                .unwrap(),
            expected
        );
        // The import thumbnail is the small preview.
        let [width, height] = info.native_dimensions.unwrap();
        let aspect = f64::from(width) / f64::from(height);
        match (thumbnail, fit) {
            (Some(thumbnail), Some(fit)) => {
                assert_eq!(upright(&small), *thumbnail, "{variable} thumbnail");
                assert_eq!(upright(&full), *fit, "{variable} fit");
            }
            _ => {
                // No embedded JPEG: every view is the rendered RAW preview.
                assert!(exif.preview(path, false).await.unwrap().is_none());
                assert!(exif.preview(path, true).await.unwrap().is_none());
                assert_eq!(full, small, "{variable}");
                let (w, h) = upright(&full);
                assert!(w.max(h) <= x3f_dng::PREVIEW_MAX_EDGE);
                assert!((f64::from(w) / f64::from(h) / aspect - 1.).abs() < 0.02);
            }
        }
        if variable == &"X3FUSE_TEST_ARW" {
            // The JPEG is unchanged: no crop and no re-encode.
            // The app's ExifTool runner selects the runtime of this platform.
            let raw = exif
                .run(vec!["-b".into(), "-PreviewImage".into(), path.into()], None)
                .await
                .unwrap();
            let scan = raw.windows(2).position(|w| w == [0xff, 0xda]).unwrap();
            assert!(full.ends_with(&raw[scan..]) && small.ends_with(&raw[scan..]));
        }
        eprintln!(
            "{variable}: native {width}x{height}, crop {:?}, thumbnail {:?} ({} bytes), fit {:?} ({} bytes), 1:1 from JPEG {native}",
            info.crop,
            upright(&small),
            small.len(),
            upright(&full),
            full.len()
        );
    }
    settle().await;
    // 3: a new instance on the same cache directory, with and without ExifTool.
    let reloaded = open(true);
    let cached = open(false);
    for ((variable, native, ..), path) in cases.iter().zip(&paths) {
        assert_eq!(
            within(cached.has_embedded_full(path, true)).await.unwrap(),
            Some(*native),
            "{variable}"
        );
        assert!(
            within(cached.get(path, true, true))
                .await
                .unwrap()
                .is_some(),
            "{variable}"
        );
        assert!(
            within(cached.get(path, false, true))
                .await
                .unwrap()
                .is_some(),
            "{variable}"
        );
        assert_eq!(
            reloaded.has_embedded_full(path, false).await.unwrap(),
            Some(*native),
            "{variable}"
        );
    }
    let leica = &paths[0];
    let full = reloaded.get(leica, true, false).await.unwrap().unwrap();
    assert_eq!(jpeg_size(&full), Some((7840, 5184)));
}

/// A JPEG of another aspect, with gray bands, must never show for a supported
/// RAW, even when an earlier run left it in memory and on disk.
#[tokio::test]
#[ignore = "requires X3FUSE_TEST_DNG_NO_PREVIEW and bundled ExifTool"]
async fn rejected_jpeg_never_leaks_from_the_caches() {
    let directory = tempfile::tempdir().unwrap();
    let path = sample("X3FUSE_TEST_DNG_NO_PREVIEW", directory.path());
    let info = Info::read(&path, &AtomicBool::new(false)).unwrap();
    let [width, height] = info.native_dimensions.unwrap();
    let aspect = f64::from(width) / f64::from(height);
    // A 4:3 JPEG for a 3:2 RAW; the bands outside 3:2 are mid gray.
    let rejected = x3f_render::RenderedImage {
        width: 800,
        height: 600,
        full_width: 800,
        full_height: 600,
        data: x3f_render::Pixels::Rgb16(vec![32768; 800 * 600 * 3]),
        color_profile: x3f_render::ColorProfile::Srgb,
        region: None,
    }
    .jpeg(90)
    .unwrap();
    assert!((800. / 600. / aspect - 1.).abs() > 0.02);
    let logs = Arc::new(Logs::new(directory.path().join("logs")));
    let cache = directory.path().join("previews");
    let key = source_key(&path).unwrap();
    let plant = |store: &Store, memory: &Memory| {
        for kind in ["jpg", "full.jpg"] {
            assert!(store.put(store.generation(), &format!("{key}.{kind}"), &rejected));
        }
        for variant in ["preview", "full"] {
            memory.put(
                format!("original:{key}:{variant}"),
                Arc::new(rejected.clone()),
            );
        }
    };
    let store = Store::open(cache.clone(), vec![], true, 1 << 30, logs.clone());
    let memory = Arc::new(Memory::new(1 << 30));
    plant(&store, &memory);
    // Cache-only: no ExifTool, no wait, and never the rejected JPEG.
    let cached = Previews::new(
        exiftool(directory.path(), &logs, false),
        store.clone(),
        memory.clone(),
    );
    for full in [false, true] {
        assert!(within(cached.get(&path, full, true))
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(
        within(cached.has_embedded_full(&path, true)).await.unwrap(),
        Some(false)
    );
    let check = |bytes: &[u8]| {
        assert_ne!(bytes, &rejected[..]);
        let (w, h) = upright(bytes);
        assert!(
            (f64::from(w) / f64::from(h) / aspect - 1.).abs() < 0.02,
            "{w}x{h}"
        );
    };
    let previews = Previews::new(exiftool(directory.path(), &logs, true), store, memory);
    let fit = previews.get(&path, true, false).await.unwrap().unwrap();
    check(&fit);
    check(&previews.get(&path, false, false).await.unwrap().unwrap());
    assert_eq!(
        previews.has_embedded_full(&path, false).await.unwrap(),
        Some(false)
    );
    settle().await;
    // A new instance on the same cache directory, with the entries planted again.
    let store = Store::open(cache, vec![], true, 1 << 30, logs.clone());
    let memory = Arc::new(Memory::new(1 << 30));
    plant(&store, &memory);
    let reloaded = Previews::new(exiftool(directory.path(), &logs, true), store, memory);
    assert_eq!(
        reloaded.has_embedded_full(&path, false).await.unwrap(),
        Some(false)
    );
    let again = reloaded.get(&path, true, false).await.unwrap().unwrap();
    check(&again);
    assert_eq!(upright(&again), upright(&fit));
}

/// The fit view of a supported RAW never falls back to a small accepted JPEG,
/// even with the "no full JPEG" marker on disk: it renders the RAW.
#[tokio::test]
#[ignore = "requires X3FUSE_TEST_DNG_NO_PREVIEW and bundled ExifTool"]
async fn fit_view_never_uses_a_small_jpeg() {
    let directory = tempfile::tempdir().unwrap();
    let path = sample("X3FUSE_TEST_DNG_NO_PREVIEW", directory.path());
    let info = Info::read(&path, &AtomicBool::new(false)).unwrap();
    let [width, height] = info.native_dimensions.unwrap();
    // An accepted 3:2 thumbnail, below the 1024-pixel fit minimum.
    let small = x3f_render::RenderedImage {
        width: 480,
        height: 320,
        full_width: 480,
        full_height: 320,
        data: x3f_render::Pixels::Rgb16(vec![32768; 480 * 320 * 3]),
        color_profile: x3f_render::ColorProfile::Srgb,
        region: None,
    }
    .jpeg(90)
    .unwrap();
    assert!((480. / 320. / (f64::from(width) / f64::from(height)) - 1.).abs() < 0.02);
    let logs = Arc::new(Logs::new(directory.path().join("logs")));
    let store = Store::open(
        directory.path().join("previews"),
        vec![],
        true,
        1 << 30,
        logs.clone(),
    );
    let memory = Arc::new(Memory::new(1 << 30));
    let key = source_key(&path).unwrap();
    assert!(store.put(store.generation(), &format!("{key}.jpg"), &small));
    assert!(store.put(store.generation(), &format!("{key}.full.jpg"), &[]));
    memory.put(format!("original:{key}:preview"), Arc::new(small.clone()));
    // The small preview is the thumbnail. The fit view has no cache hit.
    let cached = Previews::new(
        exiftool(directory.path(), &logs, false),
        store.clone(),
        memory.clone(),
    );
    assert_eq!(
        *within(cached.get(&path, false, true))
            .await
            .unwrap()
            .unwrap(),
        small
    );
    assert!(within(cached.get(&path, true, true))
        .await
        .unwrap()
        .is_none());
    let previews = Previews::new(
        exiftool(directory.path(), &logs, true),
        store.clone(),
        memory,
    );
    let fit = previews.get(&path, true, false).await.unwrap().unwrap();
    let (w, h) = upright(&fit);
    assert!(w.max(h) >= 1024, "{w}x{h}");
    assert_eq!(
        previews.has_embedded_full(&path, false).await.unwrap(),
        Some(false)
    );
    // The rendered fit view is the full entry now, also for a new instance.
    let reloaded = Previews::new(
        exiftool(directory.path(), &logs, false),
        store,
        Arc::new(Memory::new(1 << 30)),
    );
    assert_eq!(
        *within(reloaded.get(&path, true, true))
            .await
            .unwrap()
            .unwrap(),
        *fit
    );
    assert_eq!(
        within(reloaded.has_embedded_full(&path, true))
            .await
            .unwrap(),
        Some(false)
    );
}

#[test]
#[ignore = "requires X3FUSE_TEST_ARW, X3FUSE_TEST_RW2 and a supported GPU"]
fn edited_export_of_arw_and_rw2() {
    let directory = tempfile::tempdir().unwrap();
    for variable in ["X3FUSE_TEST_ARW", "X3FUSE_TEST_RW2"] {
        let path = sample(variable, directory.path());
        let fingerprint = Sha256::digest(fs::read(&path).unwrap());
        let dto = basic_metadata(path.clone()).unwrap();
        assert!(dto.edit_error.is_none(), "{variable}: {:?}", dto.edit_error);
        let editor = Editor::new(directory.path().join("edits"));
        let session = editor.open(path.clone()).unwrap();
        assert_eq!(session.source_kind, Kind::Dng);
        let mut recipe = session.recipe.clone();
        recipe.exposure = 0.5;
        let frame = serde_json::to_value(
            editor
                .render(RenderRequest {
                    session_id: session.session_id.clone(),
                    recipe: recipe.clone(),
                    revision: 1,
                    max_edge: 512,
                    region: None,
                    interactive: false,
                })
                .unwrap(),
        )
        .unwrap();
        assert!(frame["width"].as_u64().unwrap() > 0);
        let file = ConvertFile {
            id: variable.into(),
            path: path.clone(),
            recipe: Some(recipe.clone()),
            source_revision: Some(session.source_revision.clone()),
            ..Default::default()
        };
        // Original DNG and Embedded JPG export are refused, as for DNG input.
        for format in [OutputFormat::Dng, OutputFormat::Jpeg] {
            let settings = BatchSettings {
                output_format: format,
                ..Default::default()
            };
            assert!(
                validate_batch(std::slice::from_ref(&file), &settings).is_err(),
                "{format:?}"
            );
        }
        let settings = BatchSettings {
            output_format: OutputFormat::RenderedJpeg,
            rendering: Rendering::Rendered,
            ..Default::default()
        };
        assert!(validate_batch(std::slice::from_ref(&file), &settings)
            .unwrap()
            .is_empty());
        let output = settings.output_path(&path).unwrap();
        editor
            .export(
                &path,
                Some(&session.source_revision),
                &recipe,
                &settings,
                &output,
                &AtomicBool::new(false),
            )
            .unwrap();
        let bytes = fs::read(&output).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9]));
        // The export is upright, at the as-shot crop of the native size.
        let info = Info::read(&path, &AtomicBool::new(false)).unwrap();
        let [width, height] = info.native_dimensions.unwrap();
        let [_, _, cw, ch] = info.crop.unwrap_or([0., 0., 1., 1.]);
        let (w, h) = upright(&bytes);
        let expected = f64::from(width) * f64::from(cw) / (f64::from(height) * f64::from(ch));
        assert!(
            (f64::from(w) / f64::from(h) / expected - 1.).abs() < 0.01,
            "{variable}: {w}x{h}"
        );
        eprintln!("{variable}: edited JPEG {w}x{h}, {} bytes", bytes.len());
        editor.close(&session.session_id).unwrap();
        assert_eq!(Sha256::digest(fs::read(&path).unwrap()), fingerprint);
    }
}
