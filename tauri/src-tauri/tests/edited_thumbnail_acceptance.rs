//! Opt-in checks for saved edited thumbnails; originals and sidecars are only read.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
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
        drop(editor);

        let reopened = Editor::new(directory.clone());
        let record = reopened.load(&input).unwrap().unwrap();
        let uri = format!("{}?v=thumbnail", record.preview_url.unwrap());
        reopened
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
    }
}

#[test]
#[ignore = "Requires X3FUSE_TEST_EDITED_A/B RAWs with saved denoise edits and a hardware GPU"]
fn first_raw_frame_is_progressive_and_refinement_restores_saved_denoise() {
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
        let first = render(1, true, 1024);
        assert_eq!(first["draft"], true);
        let draft_pixels = editor.image_uri(first["url"].as_str().unwrap()).unwrap();
        // An exact render of an explicitly undenoised recipe must match draft pixels.
        let mut undenoised = session.recipe.clone();
        undenoised.denoise = 0;
        let reference = editor
            .render(RenderRequest {
                session_id: session.session_id.clone(),
                recipe: undenoised,
                revision: 2,
                max_edge: 1024,
                region: None,
                interactive: false,
            })
            .unwrap();
        let reference = serde_json::to_value(reference).unwrap();
        assert_eq!(reference["draft"], false);
        assert_eq!(first["url"], reference["url"]);
        assert_eq!(
            *draft_pixels,
            *editor
                .image_uri(reference["url"].as_str().unwrap())
                .unwrap()
        );

        let refined = render(3, false, 2048);
        assert_eq!(refined["draft"], false);
        let warm = render(4, true, 1024);
        assert_eq!(
            warm["draft"], false,
            "Interactive frames must reuse completed denoising"
        );
        assert_ne!(
            first["url"], warm["url"],
            "Draft pixels must never occupy an exact asset URL"
        );
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
        // Only the exact refinement should have persisted the saved thumbnail.
        editor
            .paused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(editor
            .image_uri(&format!("{}?v=thumbnail", saved.preview_url.unwrap()))
            .is_ok());
        assert!(editor
            .image_uri(&format!("{}?v=thumbnail", first["url"].as_str().unwrap()))
            .is_err());
    }
}
