//! Opt in with X3FUSE_TEST_X3I and --ignored.
//! Requires a supported hardware GPU and prepared ExifTool resources.
//! The test uses a temporary copy of the X3I file.
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use x3fuse_app::{
    editor::{Editor, RenderRequest},
    metadata::ExifTool,
    storage::Logs,
};

#[test]
#[ignore = "Requires an X3I fixture, hardware GPU and prepared ExifTool resources"]
fn x3i_reads_metadata_and_opens_quickly_after_the_first_merge() {
    let original = PathBuf::from(std::env::var_os("X3FUSE_TEST_X3I").expect("Set X3FUSE_TEST_X3I"));
    assert!(original.is_absolute() && original.is_file());
    let temporary = tempfile::tempdir().unwrap();
    // A renamed container is still an X3I.
    let input = temporary.path().join("写真 sfd.X3F");
    std::fs::copy(&original, &input).unwrap();
    let edits = temporary.path().join("edits");
    let exif = ExifTool::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool"),
        edits.join("x3i-v1"),
        Arc::new(Logs::new(temporary.path().join("logs"))),
    );
    let runtime = tauri::async_runtime::handle();
    let mut metadata = runtime.block_on(exif.display(std::slice::from_ref(&input)));
    let metadata = metadata.remove(&input).expect("X3I metadata");
    assert!(metadata.preview.is_some());
    assert!(metadata.exif.iter().any(|pair| pair.label == "Camera"));
    assert!(runtime
        .block_on(exif.preview(&input, true))
        .unwrap()
        .is_some());

    let render_recipe = |editor: &Editor,
                         session: &x3fuse_app::editor::EditorSession,
                         recipe: x3f_render::EditRecipe| {
        editor.render(RenderRequest {
            session_id: session.session_id.clone(),
            recipe,
            revision: 1,
            max_edge: 512,
            region: None,
            interactive: false,
        })
    };
    let render = |editor: &Editor, session: &x3fuse_app::editor::EditorSession| {
        render_recipe(editor, session, session.recipe.clone())
    };
    let editor = Arc::new(Editor::new(edits.clone()));
    let session = editor.open(input.clone()).unwrap();
    let status = session.x3i.clone().expect("X3I status");
    assert!(status.frames > 1 && !status.processed && status.progress.is_none());
    // The editor does not merge on its own.
    let merge_recipe = x3f_render::EditRecipe {
        x3i_source: x3f_core::X3iSource::Merge,
        ..session.recipe.clone()
    };
    let started = Instant::now();
    assert!(render_recipe(&editor, &session, merge_recipe.clone()).is_err());
    assert!(started.elapsed() < Duration::from_secs(5));

    let status = || editor.x3i_status(&input, &session.recipe).unwrap().unwrap();
    // A photo opens with its middle exposure, which renders without a merge.
    assert_eq!(
        session.recipe.x3i_source,
        x3f_core::X3iSource::MiddleExposure
    );
    let started = Instant::now();
    let preview = serde_json::to_value(render(&editor, &session).unwrap()).unwrap();
    assert!(preview["sourceWidth"].as_u64().unwrap() > 512);
    let single = started.elapsed();
    eprintln!("Middle exposure: {single:?}");
    assert!(!status().processed);
    // Starts a merge and waits until it reports progress.
    let merge = || {
        let (editor, input, recipe) = (editor.clone(), input.clone(), session.recipe.clone());
        let merge = std::thread::spawn(move || editor.x3i_process(&input, &recipe));
        while status().progress.is_none() {
            assert!(!merge.is_finished());
            std::thread::sleep(Duration::from_millis(20));
        }
        merge
    };
    // A cancelled merge leaves no error and no cached scene.
    let cancelled = merge();
    while status().progress.is_some_and(|progress| progress < 0.2) {
        std::thread::sleep(Duration::from_millis(100));
    }
    editor.x3i_cancel(&input).unwrap();
    assert!(cancelled.join().unwrap().is_err());
    let after = status();
    assert!(!after.processed && after.progress.is_none() && after.error.is_none());

    let started = Instant::now();
    let merged = merge();
    let mut last = 0.;
    while let Some(progress) = status().progress {
        assert!(progress >= last);
        last = progress;
        std::thread::sleep(Duration::from_millis(250));
    }
    merged.join().unwrap().unwrap();
    let first = started.elapsed();
    let after = status();
    assert!(after.processed && after.error.is_none());
    eprintln!("Merge: {first:?}, last progress {last}");
    assert!(last > 0.8, "progress ended at {last}");

    let started = Instant::now();
    let editor = Editor::new(edits.clone());
    let session = editor.open(input.clone()).unwrap();
    assert!(session.x3i.as_ref().unwrap().processed);
    let merge_recipe = x3f_render::EditRecipe {
        x3i_source: x3f_core::X3iSource::Merge,
        ..session.recipe.clone()
    };
    let preview =
        serde_json::to_value(render_recipe(&editor, &session, merge_recipe).unwrap()).unwrap();
    assert!(preview["sourceWidth"].as_u64().unwrap() > 512);
    let second = started.elapsed();
    eprintln!(
        "Cached open: {second:?}, profile {}",
        session.as_shot_camera_profile
    );
    assert!(second * 4 < first, "merge {first:?}, cached {second:?}");
    assert!(
        single * 2 < first,
        "merge {first:?}, middle exposure {single:?}"
    );
}
