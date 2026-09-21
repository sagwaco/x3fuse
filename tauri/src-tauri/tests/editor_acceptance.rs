//! Opt in with X3FUSE_TEST_MERRILL / X3FUSE_TEST_QUATTRO and --ignored.
//! Requires a supported hardware GPU and prepared ExifTool resources.
//! Every operation that can write uses a temporary copy of the corpus file.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};
use x3f_render::{Crop, EditRecipe, MonochromeFilter, MonochromeSettings};
use x3fuse_app::{
    conversion::publish,
    editor::{protocol_id, Editor, EditorSession, RenderRequest},
    metadata::ExifTool,
    model::{BatchSettings, ColorProfile, OutputFormat, Rendering},
    storage::Logs,
};

fn fixture(key: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(key).unwrap_or_else(|| panic!("Set {key}")));
    assert!(
        path.is_absolute() && path.is_file(),
        "Invalid {key}: {path:?}"
    );
    path
}

fn fingerprint(path: &Path) -> String {
    let mut digest = Sha256::new();
    let mut file = fs::File::open(path).unwrap();
    let mut bytes = [0; 65536];
    loop {
        let count = file.read(&mut bytes).unwrap();
        if count == 0 {
            return format!("{:x}", digest.finalize());
        }
        digest.update(&bytes[..count]);
    }
}

fn render(
    editor: &Editor,
    session: &EditorSession,
    recipe: &x3f_render::EditRecipe,
    revision: u64,
) -> (Value, Arc<Vec<u8>>) {
    let started = Instant::now();
    let result = editor
        .render(RenderRequest {
            session_id: session.session_id.clone(),
            recipe: recipe.clone(),
            revision,
            max_edge: 512,
            region: None,
            interactive: false,
        })
        .unwrap();
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["sessionId"], session.session_id);
    assert_eq!(result["revision"], revision);
    let id = protocol_id(result["url"].as_str().unwrap()).unwrap();
    let bytes = editor.image(&id).unwrap();
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    assert_eq!(result["width"], width);
    assert_eq!(result["height"], height);
    assert!(width > 0 && height > 0 && width.max(height) <= 512);
    eprintln!("Preview revision {revision}: {:?}", started.elapsed());
    (result, bytes)
}

// Compare image data rather than a changed URL, ICC chunk or other PNG metadata.
fn png_image_data(bytes: &[u8]) -> Vec<u8> {
    let mut data = Vec::new();
    let mut offset = 8;
    while offset < bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk = &bytes[offset + 4..offset + 8];
        if chunk == b"IDAT" {
            data.extend_from_slice(&bytes[offset + 8..offset + 8 + length]);
        }
        offset += length + 12;
    }
    assert!(!data.is_empty());
    data
}

#[test]
fn edited_export_requires_a_source_snapshot_before_io() {
    let temporary = tempfile::tempdir().unwrap();
    let editor = Editor::new(temporary.path().join("edits"));
    let input = temporary.path().join("not-opened.X3F");
    let output = temporary.path().join("previous.jpg");
    fs::write(&output, b"previous completed export").unwrap();
    let error = editor
        .export(
            &input,
            None,
            &x3f_render::EditRecipe::default(),
            &BatchSettings {
                output_format: OutputFormat::RenderedJpeg,
                ..Default::default()
            },
            &output,
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert!(error.contains("Review the source"));
    assert_eq!(fs::read(output).unwrap(), b"previous completed export");
}

#[test]
#[ignore = "Requires Merrill/Quattro fixtures, hardware GPU and prepared ExifTool resources"]
fn real_editor_preview_persistence_exports_and_cancellation() {
    let fixtures = [
        fixture("X3FUSE_TEST_MERRILL"),
        fixture("X3FUSE_TEST_QUATTRO"),
    ];
    let temporary = tempfile::tempdir().unwrap();
    let editor = Editor::new(temporary.path().join("edits"));
    let exif = ExifTool::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool"),
        Arc::new(Logs::new(temporary.path().join("logs"))),
    );
    let runtime = tauri::async_runtime::handle();
    runtime.block_on(exif.check()).unwrap();
    let tags = |path: &Path| {
        let bytes = runtime
            .block_on(
                exif.run(
                    [
                        "-json",
                        "-n",
                        "-Model",
                        "-DateTimeOriginal",
                        "-ImageWidth",
                        "-ImageHeight",
                        "-BitsPerSample",
                        "-Orientation",
                        "-ProfileDescription",
                    ]
                    .into_iter()
                    .map(Into::into)
                    .chain(std::iter::once(path.into()))
                    .collect(),
                    None,
                ),
            )
            .unwrap();
        serde_json::from_slice::<Vec<Value>>(&bytes)
            .unwrap()
            .remove(0)
    };
    let cancel = AtomicBool::new(false);
    for (camera, original) in fixtures.iter().enumerate() {
        let started = Instant::now();
        let original_hash = fingerprint(original);
        let input = temporary.path().join(format!("写真 {camera} 100%.X3F"));
        fs::copy(original, &input).unwrap();
        let source_tags = tags(&input);
        let family = if camera == 0 { "merrill" } else { "quattro" };
        assert!(
            source_tags["Model"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains(family),
            "Expected {family} fixture, got {}",
            source_tags["Model"]
        );
        let session = editor.open(input.clone()).unwrap();
        assert_eq!(session.source_revision, original_hash);
        assert_eq!(session.revision, 0);
        assert_eq!(session.recipe.monochrome, None);
        let as_shot_crop =
            x3f_core::read_as_shot_crop(&input)
                .unwrap()
                .map(|[x, y, width, height]| Crop {
                    x,
                    y,
                    width,
                    height,
                });
        assert_eq!(session.as_shot_crop, as_shot_crop);
        assert_eq!(session.recipe.crop, as_shot_crop);
        let (default_preview, default_png) = render(&editor, &session, &session.recipe, 1);
        assert!(
            default_preview["fullWidth"].as_u64().unwrap()
                <= default_preview["sourceWidth"].as_u64().unwrap()
        );
        assert!(
            default_preview["fullHeight"].as_u64().unwrap()
                <= default_preview["sourceHeight"].as_u64().unwrap()
        );
        assert!(default_preview["sourceWidth"].as_u64().unwrap() > 512);
        assert!(default_preview["sourceHeight"].as_u64().unwrap() > 512);
        let exposed_recipe = EditRecipe {
            exposure: 1.5,
            ..session.recipe.clone()
        };
        let (_, exposed_png) = render(&editor, &session, &exposed_recipe, 2);
        assert_ne!(png_image_data(&default_png), png_image_data(&exposed_png));
        let recipe = EditRecipe {
            monochrome: Some(MonochromeSettings {
                filter: MonochromeFilter::Red,
            }),
            ..exposed_recipe
        };
        let (edited_preview, edited_png) = render(&editor, &session, &recipe, 3);
        assert_eq!(default_preview["width"], edited_preview["width"]);
        assert_eq!(default_preview["height"], edited_preview["height"]);
        assert_eq!(
            default_preview["sourceWidth"],
            edited_preview["sourceWidth"]
        );
        assert_eq!(
            default_preview["sourceHeight"],
            edited_preview["sourceHeight"]
        );
        assert_ne!(png_image_data(&exposed_png), png_image_data(&edited_png));
        let blue_recipe = EditRecipe {
            monochrome: Some(MonochromeSettings {
                filter: MonochromeFilter::Blue,
            }),
            ..recipe.clone()
        };
        let (_, blue_png) = render(&editor, &session, &blue_recipe, 4);
        assert_ne!(
            png_image_data(&edited_png),
            png_image_data(&blue_png),
            "Red and blue sensor-layer filters produced the same preview"
        );
        let (_, restored_red_png) = render(&editor, &session, &recipe, 5);
        assert_eq!(edited_png, restored_red_png);
        let saved = editor
            .save(&input, recipe.clone(), 1, Some(&session.source_revision))
            .unwrap();
        assert_eq!(saved.recipe, recipe);
        assert_eq!(saved.storage, "sidecar");
        assert!(saved.storage_path.is_file());
        let sidecar: Value =
            serde_json::from_slice(&fs::read(&saved.storage_path).unwrap()).unwrap();
        assert_eq!(sidecar["recipe"]["monochrome"]["filter"], "red");
        let loaded = editor.load(&input).unwrap().unwrap();
        assert_eq!(loaded.recipe, recipe);
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.source_revision, session.source_revision);
        editor.close(&session.session_id).unwrap();
        assert!(editor
            .render(RenderRequest {
                session_id: session.session_id.clone(),
                recipe: recipe.clone(),
                revision: 6,
                max_edge: 512,
                region: None,
                interactive: false,
            })
            .is_err());
        let session = editor.open(input.clone()).unwrap();
        assert_eq!(session.recipe, recipe);
        assert_eq!(session.revision, 1);
        let (_, reopened_png) = render(&editor, &session, &session.recipe, 7);
        assert_eq!(
            edited_png, reopened_png,
            "Reopening changed the rendered recipe"
        );
        for (format, color_profile, profile_name) in [
            (OutputFormat::RenderedJpeg, ColorProfile::Srgb, "x3f sRGB"),
            (
                OutputFormat::Tiff,
                ColorProfile::ProPhotoRgb,
                "x3f ProPhoto RGB",
            ),
        ] {
            let started = Instant::now();
            let settings = BatchSettings {
                output_format: format,
                rendering: Rendering::Rendered,
                color_profile,
                compress: true,
                ..Default::default()
            };
            settings.validate().unwrap();
            let staging = tempfile::tempdir_in(temporary.path()).unwrap();
            let output = staging
                .path()
                .join(format!("edited.{}", format.extension()));
            let final_output = temporary
                .path()
                .join(format!("edited-{camera}.{}", format.extension()));
            fs::write(&final_output, b"previous completed export").unwrap();
            assert!(editor
                .export(
                    &input,
                    Some(&session.source_revision),
                    &recipe,
                    &settings,
                    &output,
                    &AtomicBool::new(true)
                )
                .is_err());
            assert!(!output.exists());
            assert_eq!(
                fs::read(&final_output).unwrap(),
                b"previous completed export"
            );
            editor
                .export(
                    &input,
                    Some(&session.source_revision),
                    &recipe,
                    &settings,
                    &output,
                    &cancel,
                )
                .unwrap();
            runtime
                .block_on(exif.copy_rendered_tags(&input, &output, &cancel))
                .unwrap();
            let output_tags = tags(&output);
            assert_eq!(output_tags["ImageWidth"], edited_preview["fullWidth"]);
            assert_eq!(output_tags["ImageHeight"], edited_preview["fullHeight"]);
            assert_eq!(output_tags["Orientation"], 1);
            assert_eq!(output_tags["ProfileDescription"], profile_name);
            assert_eq!(output_tags["Model"], source_tags["Model"]);
            assert_eq!(
                output_tags["DateTimeOriginal"],
                source_tags["DateTimeOriginal"]
            );
            if format == OutputFormat::Tiff {
                assert_eq!(output_tags["BitsPerSample"], "16 16 16");
            }
            let bytes = fs::read(&output).unwrap();
            assert!(bytes.len() > 100);
            assert!(if format == OutputFormat::RenderedJpeg {
                bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9])
            } else {
                bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")
            });
            let blocked = staging.path().join("not-approved");
            fs::copy(&output, &blocked).unwrap();
            assert!(publish(&blocked, &final_output, false).is_err());
            assert_eq!(
                fs::read(&final_output).unwrap(),
                b"previous completed export"
            );
            publish(&output, &final_output, true).unwrap();
            assert_eq!(fs::read(&final_output).unwrap(), bytes);
            assert!(!output.exists());
            eprintln!(
                "{format:?} edited export camera {camera}: {:?}",
                started.elapsed()
            );
        }
        assert_eq!(fingerprint(&input), original_hash);
        // A stale recipe must not attach to new bytes at the same path.
        fs::OpenOptions::new()
            .append(true)
            .open(&input)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        assert!(editor
            .save(&input, recipe.clone(), 2, Some(&session.source_revision))
            .is_err());
        let stale_output = temporary.path().join(format!("stale-{camera}.jpg"));
        assert!(editor
            .export(
                &input,
                Some(&session.source_revision),
                &recipe,
                &BatchSettings {
                    output_format: OutputFormat::RenderedJpeg,
                    ..Default::default()
                },
                &stale_output,
                &cancel
            )
            .is_err());
        assert!(!stale_output.exists());
        editor.close(&session.session_id).unwrap();
        assert_eq!(
            fingerprint(original),
            original_hash,
            "Corpus file was changed"
        );
        eprintln!("Editor acceptance camera {camera}: {:?}", started.elapsed());
    }
}
