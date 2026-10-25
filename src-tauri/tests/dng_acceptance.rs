//! Run with X3FUSE_TEST_DNG and --ignored. Each test uses a temporary input copy.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use x3fuse_app::{
    conversion::validate_batch,
    editor::{Editor, RenderRequest},
    metadata::{basic_metadata, ExifTool},
    model::{BatchSettings, ConvertFile, OutputFormat, Rendering},
    preview::{DiskCache, Previews},
    source::Kind,
    storage::Logs,
};

#[tokio::test]
#[ignore = "requires bundled ExifTool"]
async fn unsupported_dng_keeps_its_embedded_preview() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("unsupported.dng");
    let jpeg = x3f_render::RenderedImage {
        width: 2,
        height: 1,
        full_width: 2,
        full_height: 1,
        data: x3f_render::Pixels::Rgb16(vec![65535, 0, 0, 0, 0, 65535]),
        color_profile: x3f_render::ColorProfile::Srgb,
        region: None,
    }
    .jpeg(95)
    .unwrap();
    // A TIFF preview with DNG tags and no decodable RAW image.
    let tags: [(u16, u16, u32, u32); 10] = [
        (254, 4, 1, 1),
        (256, 4, 1, 2),
        (257, 4, 1, 1),
        (259, 3, 1, 7),
        (262, 3, 1, 2),
        (273, 4, 1, 8 + 2 + 10 * 12 + 4),
        (274, 3, 1, 6),
        (277, 3, 1, 3),
        (279, 4, 1, jpeg.len() as u32),
        (50706, 1, 4, 0x00000401),
    ];
    let mut bytes = b"II\x2a\0\x08\0\0\0".to_vec();
    bytes.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    for (tag, kind, count, value) in tags {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&jpeg);
    fs::write(&path, bytes).unwrap();
    assert!(basic_metadata(path.clone()).unwrap().edit_error.is_some());
    let exif = ExifTool::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool"),
        directory.path().join("frames"),
        Arc::new(Logs::new(directory.path().join("logs"))),
    );
    for full in [false, true] {
        let bytes = exif.preview(&path, full).await.unwrap().unwrap();
        assert_eq!(
            x3f_sys::jpeg_exif::parse_jpeg_exif(&bytes)
                .unwrap()
                .orientation,
            Some(6)
        );
    }
}

#[tokio::test]
#[ignore = "requires X3FUSE_TEST_DNG and bundled ExifTool"]
async fn dng_previews_have_orientation_and_survive_cache_reload() {
    let input = PathBuf::from(std::env::var_os("X3FUSE_TEST_DNG").expect("Set X3FUSE_TEST_DNG"));
    assert!(input.is_absolute() && input.is_file());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("preview.dng");
    fs::copy(input, &path).unwrap();
    let logs = Arc::new(Logs::new(directory.path().join("logs")));
    let exif = Arc::new(ExifTool::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool"),
        directory.path().join("frames"),
        logs.clone(),
    ));
    exif.check().await.unwrap();
    let disk = Arc::new(DiskCache::new(
        directory.path().join("previews"),
        true,
        64 * 1024 * 1024,
        logs,
    ));
    let previews = Previews::new(exif.clone(), disk.clone());
    let small = previews.get(&path, false).await.unwrap().unwrap();
    let full = previews.get(&path, true).await.unwrap().unwrap();
    for bytes in [&small, &full] {
        let orientation = x3f_sys::jpeg_exif::parse_jpeg_exif(bytes)
            .and_then(|exif| exif.orientation)
            .expect("DNG previews need an explicit orientation");
        assert!((1..=8).contains(&orientation));
        assert!(bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9]));
    }
    // Files without an embedded preview use the RAW orientation on both paths.
    if exif.preview(&path, false).await.unwrap().is_none() {
        let info = x3f_dng::inspect(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            x3f_sys::jpeg_exif::parse_jpeg_exif(&full)
                .unwrap()
                .orientation,
            Some(info.orientation)
        );
    }
    let reloaded = Previews::new(exif, disk);
    assert_eq!(reloaded.get(&path, false).await.unwrap().unwrap(), small);
}

#[test]
#[ignore = "requires X3FUSE_TEST_DNG and a supported GPU"]
fn dng_edit_export_reopen_and_source_protection() {
    let input = PathBuf::from(std::env::var_os("X3FUSE_TEST_DNG").expect("Set X3FUSE_TEST_DNG"));
    assert!(input.is_absolute() && input.is_file());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.dng");
    fs::copy(&input, &path).unwrap();
    let fingerprint = Sha256::digest(fs::read(&path).unwrap());
    let dto = basic_metadata(path.clone()).unwrap();
    assert!(dto.edit_error.is_none(), "{:?}", dto.edit_error);
    assert_eq!(dto.source_kind, Kind::Dng);
    assert!(!dto.capabilities.foveon && dto.capabilities.rendered_only);
    let editor = Editor::new(directory.path().join("edits"));
    let session = editor.open(path.clone()).unwrap();
    assert_eq!(session.source_kind, Kind::Dng);
    assert!(session.camera_profiles.is_empty());
    assert!(session.as_shot_camera_profile.is_none());
    assert!(session.recipe.camera_profile.is_none() && session.recipe.film.is_none());
    assert_eq!(session.recipe.denoise, 0);
    let mut recipe = session.recipe.clone();
    recipe.exposure = 0.5;
    let frame = editor
        .render(RenderRequest {
            session_id: session.session_id.clone(),
            recipe: recipe.clone(),
            revision: 1,
            max_edge: 512,
            region: None,
            interactive: false,
        })
        .unwrap();
    let frame = serde_json::to_value(frame).unwrap();
    assert!(frame["width"].as_u64().unwrap() > 0);
    assert!(frame["height"].as_u64().unwrap() > 0);
    editor
        .save(&path, recipe.clone(), 1, Some(&session.source_revision))
        .unwrap();
    let sidecar = path.with_file_name("photo.dng.x3fuse.json");
    let saved_bytes = fs::read(&sidecar).unwrap();
    let mut incompatible = recipe.clone();
    incompatible.camera_profile = Some("Standard".into());
    assert!(editor
        .save(&path, incompatible, 2, Some(&session.source_revision))
        .is_err());
    assert_eq!(fs::read(&sidecar).unwrap(), saved_bytes);
    let file = ConvertFile {
        id: "dng".into(),
        path: path.clone(),
        recipe: Some(recipe.clone()),
        source_revision: Some(session.source_revision.clone()),
        ..Default::default()
    };
    for format in [OutputFormat::Dng, OutputFormat::Jpeg, OutputFormat::Tiff] {
        assert!(validate_batch(
            std::slice::from_ref(&file),
            &BatchSettings {
                output_format: format,
                ..Default::default()
            }
        )
        .is_err());
    }
    for format in [OutputFormat::RenderedJpeg, OutputFormat::Tiff] {
        let settings = BatchSettings {
            output_format: format,
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
        let bytes = fs::read(output).unwrap();
        assert!(bytes.len() > 100);
        match format {
            OutputFormat::RenderedJpeg => assert!(bytes.starts_with(&[0xff, 0xd8])),
            OutputFormat::Tiff => {
                assert!(bytes.starts_with(b"II\x2a\0") || bytes.starts_with(b"MM\0\x2a"))
            }
            _ => unreachable!(),
        }
    }
    // Another file's original DNG export must not replace this imported source.
    let x3f = directory.path().join("photo.X3F");
    fs::write(&x3f, b"other source").unwrap();
    let original = ConvertFile {
        id: "x3f".into(),
        path: x3f,
        ..Default::default()
    };
    let error = validate_batch(&[original], &BatchSettings::default()).unwrap_err();
    assert!(error.contains("source photo"), "{error}");
    editor.close(&session.session_id).unwrap();
    let reopened = editor.open(path.clone()).unwrap();
    assert_eq!(reopened.recipe, recipe);
    assert_eq!(Sha256::digest(fs::read(&path).unwrap()), fingerprint);
    editor.close(&reopened.session_id).unwrap();
    // An outside metadata change must not silently discard the saved recipe.
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"external metadata change")
        .unwrap();
    assert!(editor.load(&path).unwrap_err().contains("preserved"));
    assert_eq!(fs::read(&sidecar).unwrap(), saved_bytes);
}
