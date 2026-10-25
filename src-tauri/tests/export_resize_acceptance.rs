//! Run with X3FUSE_TEST_RESIZE, a supported GPU, bundled ExifTool, and --ignored.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use x3f_render::{Crop, ExportResize, ResamplingMethod};
use x3fuse_app::{
    editor::{Editor, RenderRequest},
    metadata::ExifTool,
    model::{BatchSettings, ColorProfile, OutputFormat, Rendering},
    storage::Logs,
};

#[test]
#[ignore = "requires X3FUSE_TEST_RESIZE, GPU, and ExifTool"]
fn developed_exports_fit_the_edited_geometry_and_keep_metadata() {
    let source =
        PathBuf::from(std::env::var_os("X3FUSE_TEST_RESIZE").expect("Set X3FUSE_TEST_RESIZE"));
    assert!(source.is_absolute() && source.is_file());
    let temporary = tempfile::tempdir().unwrap();
    let input = temporary.path().join(source.file_name().unwrap());
    fs::copy(source, &input).unwrap();
    let original = Sha256::digest(fs::read(&input).unwrap());
    let cancel = AtomicBool::new(false);
    let editor = Editor::new(temporary.path().join("edits"));
    let session = editor.open(input.clone()).unwrap();
    let mut recipe = session.recipe.clone();
    recipe.crop = Some(Crop {
        x: 0.1,
        y: 0.12,
        width: 0.65,
        height: 0.5,
    });
    recipe.rotation = 1;
    recipe.exposure = 0.4;
    let preview = serde_json::to_value(
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
    let native_width = preview["fullWidth"].as_u64().unwrap();
    let native_height = preview["fullHeight"].as_u64().unwrap();
    let exif = ExifTool::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool"),
        temporary.path().join("frames"),
        Arc::new(Logs::new(temporary.path().join("logs"))),
    );
    let runtime = tauri::async_runtime::handle();
    runtime.block_on(exif.check()).unwrap();
    for (index, (format, bounds, profile)) in [
        (
            OutputFormat::RenderedJpeg,
            (321, 241, ResamplingMethod::Lanczos3),
            ColorProfile::Srgb,
        ),
        (
            OutputFormat::Tiff,
            (149, 223, ResamplingMethod::Area),
            ColorProfile::ProPhotoRgb,
        ),
        (
            OutputFormat::RenderedJpeg,
            (65535, 65535, ResamplingMethod::Bilinear),
            ColorProfile::AdobeRgb,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let settings = BatchSettings {
            output_format: format,
            rendering: Rendering::Rendered,
            color_profile: profile,
            resize: Some(ExportResize {
                max_width: bounds.0,
                max_height: bounds.1,
                method: bounds.2,
            }),
            ..Default::default()
        };
        let output = temporary
            .path()
            .join(format!("resized-{index}.{}", format.extension()));
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
            .block_on(exif.copy_rendered_tags(&input, recipe.x3i_source, &output, &cancel))
            .unwrap();
        let bytes = runtime
            .block_on(
                exif.run(
                    [
                        "-json",
                        "-n",
                        "-ImageWidth",
                        "-ImageHeight",
                        "-Orientation",
                        "-BitsPerSample",
                        "-ProfileDescription",
                    ]
                    .into_iter()
                    .map(Into::into)
                    .chain(std::iter::once(output.into()))
                    .collect(),
                    None,
                ),
            )
            .unwrap();
        let tags = serde_json::from_slice::<Vec<Value>>(&bytes)
            .unwrap()
            .remove(0);
        let scale = (bounds.0 as f64 / native_width as f64)
            .min(bounds.1 as f64 / native_height as f64)
            .min(1.);
        let width = tags["ImageWidth"].as_u64().unwrap();
        let height = tags["ImageHeight"].as_u64().unwrap();
        assert!((width as f64 - (native_width as f64 * scale).max(1.)).abs() < 0.500001);
        assert!((height as f64 - (native_height as f64 * scale).max(1.)).abs() < 0.500001);
        assert!(width <= bounds.0 as u64 && height <= bounds.1 as u64);
        if scale == 1. {
            assert_eq!((width, height), (native_width, native_height));
        } else {
            assert!(width == bounds.0 as u64 || height == bounds.1 as u64);
        }
        assert_eq!(tags["Orientation"], 1);
        assert_eq!(
            tags["ProfileDescription"],
            match profile {
                ColorProfile::Srgb => "x3f sRGB",
                ColorProfile::AdobeRgb => "x3f Adobe RGB (1998)",
                ColorProfile::ProPhotoRgb => "x3f ProPhoto RGB",
                ColorProfile::None => unreachable!(),
            }
        );
        if format == OutputFormat::Tiff {
            assert_eq!(tags["BitsPerSample"], "16 16 16");
        }
        eprintln!(
            "{format:?} {:?}: {native_width}x{native_height} -> {width}x{height}",
            bounds.2
        );
    }
    assert_eq!(Sha256::digest(fs::read(&input).unwrap()), original);
}
