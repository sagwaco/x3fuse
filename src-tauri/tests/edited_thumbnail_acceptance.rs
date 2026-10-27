//! Opt-in checks for saved edited thumbnails; originals and sidecars are only read.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use x3fuse_app::editor::{Editor, RenderRequest};

fn fixture(key: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(key).unwrap_or_else(|| panic!("Set {key}")));
    assert!(
        path.is_absolute() && path.is_file(),
        "Invalid {key}: {path:?}"
    );
    path
}

#[test]
#[ignore = "Requires X3FUSE_TEST_EDITED_A/B RAWs with adjacent saved edits and a hardware GPU"]
fn saved_thumbnails_reuse_pixels_across_requests_and_restarts() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("edits");
    let sidecar = |path: &Path| {
        let mut name = path.as_os_str().to_owned();
        name.push(".x3fuse.json");
        PathBuf::from(name)
    };
    for (index, variable) in ["X3FUSE_TEST_EDITED_A", "X3FUSE_TEST_EDITED_B"]
        .iter()
        .enumerate()
    {
        let original = fixture(variable);
        let input = temporary.path().join(format!("edited-{index}.X3F"));
        fs::copy(&original, &input).unwrap();
        fs::copy(sidecar(&original), sidecar(&input)).unwrap();
        let editor = Arc::new(Editor::new(directory.clone()));
        let start = Instant::now();
        let record = editor.load(&input).unwrap().unwrap();
        eprintln!("{} edit load: {:?}", original.display(), start.elapsed());
        // The import command publishes fingerprints once per metadata batch.
        editor.edits.flush_fingerprints();
        let uri = format!("{}?v=thumbnail", record.preview_url.unwrap());
        // Browsing snapshots must work even when an editor revision was cancelled.
        editor.cancel_preview();
        let start = Instant::now();
        let (a, b) = std::thread::scope(|scope| {
            let first = scope.spawn(|| editor.image_uri(&uri).unwrap());
            let second = scope.spawn(|| editor.image_uri(&uri).unwrap());
            (first.join().unwrap(), second.join().unwrap())
        });
        eprintln!(
            "{} cold thumbnail: {:?}, {} bytes",
            original.display(),
            start.elapsed(),
            a.len()
        );
        assert!(
            Arc::ptr_eq(&a, &b),
            "Concurrent requests must reuse the completed image"
        );
        assert!(a.starts_with(b"\x89PNG\r\n\x1a\n"));
        let width = u32::from_be_bytes(a[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(a[20..24].try_into().unwrap());
        assert_eq!(width.max(height), 640);
        // The app persists after each response; the final preview and its
        // thumbnail go to disk here.
        editor.persist_previews();
        drop(editor);

        let start = Instant::now();
        let reopened = Editor::new(directory.clone());
        let record = reopened.load(&input).unwrap().unwrap();
        eprintln!(
            "{} edit load after restart (including fingerprint cache): {:?}",
            original.display(),
            start.elapsed()
        );
        let uri = format!("{}?v=thumbnail", record.preview_url.unwrap());
        reopened
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let start = Instant::now();
        let body = reopened.respond(&format!("{uri}&cacheOnly=1"));
        eprintln!(
            "{} cache-only thumbnail after restart: {:?}",
            original.display(),
            start.elapsed()
        );
        assert_eq!(
            body.status, 200,
            "A persisted thumbnail is a cache-only hit"
        );
        assert_eq!(body.bytes, *a);
        let large = reopened.respond(&format!(
            "{}?cacheOnly=1",
            uri.trim_end_matches("?v=thumbnail")
        ));
        assert_eq!(large.status, 200, "The final large preview is on disk");
        let start = Instant::now();
        let cached = reopened.image_uri(&uri).unwrap();
        eprintln!(
            "{} thumbnail after restart: {:?}",
            original.display(),
            start.elapsed()
        );
        assert_eq!(
            *a, *cached,
            "Persisted thumbnail must preserve the exact edited pixels"
        );
        let renders = reopened
            .store
            .stats
            .renders
            .load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(renders, 0, "Cache hits after a restart need no render");
    }
}

#[test]
#[ignore = "Requires X3FUSE_TEST_EDITED_A/B RAWs with saved denoise edits and a hardware GPU"]
fn first_raw_frame_applies_nlm_and_a_bm3d_first_frame_is_progressive() {
    let temporary = tempfile::tempdir().unwrap();
    for (index, variable) in ["X3FUSE_TEST_EDITED_A", "X3FUSE_TEST_EDITED_B"]
        .iter()
        .enumerate()
    {
        let original = fixture(variable);
        let input = temporary.path().join(format!("progressive-{index}.X3F"));
        fs::copy(&original, &input).unwrap();
        fs::copy(
            format!("{}.x3fuse.json", original.display()),
            format!("{}.x3fuse.json", input.display()),
        )
        .unwrap();
        let editor = Editor::new(temporary.path().join(format!("cache-{index}")));
        let session = editor.open(input.clone()).unwrap();
        assert!(session.recipe.denoise > 0);
        let render = |revision, interactive, edge| {
            let start = Instant::now();
            let result = editor
                .render(RenderRequest {
                    session_id: session.session_id.clone(),
                    recipe: session.recipe.clone(),
                    revision,
                    max_edge: edge,
                    region: None,
                    interactive,
                })
                .unwrap();
            eprintln!(
                "{} interactive={interactive}, edge={edge}: {:?}",
                original.display(),
                start.elapsed()
            );
            serde_json::to_value(result).unwrap()
        };
        assert_eq!(
            session.recipe.denoise_options.algorithm,
            x3f_core::DenoiseAlgorithm::Nlm
        );
        let first = render(1, true, 1024);
        assert_eq!(
            first["draft"], false,
            "The first frame must apply NLM in its only RAW preparation"
        );
        let first_pixels = editor.image_uri(first["url"].as_str().unwrap()).unwrap();
        let refined = render(3, false, 2048);
        assert_eq!(refined["draft"], false);
        let warm = render(4, true, 1024);
        assert_eq!(
            warm["draft"], false,
            "Interactive frames must reuse completed denoising"
        );
        assert_eq!(first["url"], warm["url"]);
        let saved = editor.load(&input).unwrap().unwrap();
        assert_eq!(saved.recipe, session.recipe);
        assert_eq!(saved.preview_url.as_deref(), refined["url"].as_str());
        let medium = editor
            .image_uri(saved.preview_url.as_deref().unwrap())
            .unwrap();
        let reopened = Editor::new(temporary.path().join(format!("cache-{index}")));
        let reloaded = reopened.load(&input).unwrap().unwrap();
        reopened
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let start = Instant::now();
        let cached = reopened
            .image_uri(reloaded.preview_url.as_deref().unwrap())
            .unwrap();
        eprintln!(
            "{} medium after restart: {:?}",
            original.display(),
            start.elapsed()
        );
        assert_eq!(
            *medium, *cached,
            "Exact medium pixels must survive restart without RAW work"
        );
        // The exact refinement persisted the saved thumbnail.
        editor
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(editor
            .image_uri(&format!("{}?v=thumbnail", saved.preview_url.unwrap()))
            .is_ok());

        // A warm-up prepares the saved denoise, so the first frame needs no RAW work.
        let warmed = Editor::new(temporary.path().join(format!("warm-{index}")));
        warmed.warm(input.clone()).unwrap();
        let session = warmed.open(input.clone()).unwrap();
        let start = Instant::now();
        let frame = warmed
            .render(RenderRequest {
                session_id: session.session_id.clone(),
                recipe: session.recipe.clone(),
                revision: 1,
                max_edge: 1024,
                region: None,
                interactive: true,
            })
            .unwrap();
        let elapsed = start.elapsed();
        let frame = serde_json::to_value(frame).unwrap();
        assert_eq!(frame["draft"], false);
        assert_eq!(frame["url"], first["url"]);
        assert_eq!(
            *warmed.image_uri(frame["url"].as_str().unwrap()).unwrap(),
            *first_pixels
        );
        assert!(
            elapsed < Duration::from_millis(500),
            "The first frame after a warm-up took {elapsed:?}"
        );

        // BM3D can take seconds, so its first frame is a draft without denoising.
        let progressive = Editor::new(temporary.path().join(format!("bm3d-{index}")));
        let session = progressive.open(input.clone()).unwrap();
        let mut bm3d = session.recipe.clone();
        bm3d.denoise_options.algorithm = x3f_core::DenoiseAlgorithm::Bm3d;
        let request = |recipe, revision, interactive| RenderRequest {
            session_id: session.session_id.clone(),
            recipe,
            revision,
            max_edge: 1024,
            region: None,
            interactive,
        };
        let draft = progressive.render(request(bm3d.clone(), 1, true)).unwrap();
        let draft = serde_json::to_value(draft).unwrap();
        assert_eq!(draft["draft"], true);
        let pixels = |preview: &serde_json::Value| {
            progressive
                .image_uri(preview["url"].as_str().unwrap())
                .unwrap()
        };
        let draft_pixels = pixels(&draft);
        // An exact render of an explicitly undenoised recipe must match draft pixels.
        let mut undenoised = bm3d;
        undenoised.denoise = 0;
        let reference = progressive.render(request(undenoised, 2, false)).unwrap();
        let reference = serde_json::to_value(reference).unwrap();
        assert_eq!(reference["draft"], false);
        assert_eq!(draft["url"], reference["url"]);
        assert_eq!(*draft_pixels, *pixels(&reference));
        progressive
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            progressive
                .image_uri(&format!("{}?v=thumbnail", draft["url"].as_str().unwrap()))
                .is_err(),
            "Draft pixels must never persist a thumbnail"
        );
    }
}
