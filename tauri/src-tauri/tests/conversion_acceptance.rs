//! Run explicitly with X3FUSE_TEST_MERRILL and X3FUSE_TEST_QUATTRO absolute paths.
//! Unlike the historical integration tests, an explicit run fails when fixtures are missing.
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use x3fuse_app::{
    conversion::{process_options, publish},
    metadata::ExifTool,
    model::{BatchSettings, OutputFormat},
    storage::Logs,
};

fn fixture(key: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var(key).unwrap_or_else(|_| panic!("Set {key} to an X3F corpus file")),
    );
    assert!(
        path.is_absolute() && path.is_file(),
        "Missing fixture: {}",
        path.display()
    );
    path
}

#[test]
#[ignore = "Requires explicitly supplied Merrill and Quattro corpus files plus prepared resources"]
fn real_conversion_metadata_previews_and_cancelled_publication() {
    let samples = [
        fixture("X3FUSE_TEST_MERRILL"),
        fixture("X3FUSE_TEST_QUATTRO"),
    ];
    let temporary = tempfile::tempdir().unwrap();
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let exif = ExifTool::new(
        resources.join("exiftool"),
        Arc::new(Logs::new(temporary.path().join("logs"))),
    );
    let runtime = tauri::async_runtime::handle();
    runtime.block_on(exif.check()).unwrap();
    for (camera, original) in samples.iter().enumerate() {
        // Exercise spaces, percent signs and Unicode at the real native file boundary.
        let input = temporary.path().join(format!("写真 {camera} 100%.X3F"));
        std::fs::copy(original, &input).unwrap();
        assert!(!runtime.block_on(exif.full(&input)).unwrap().is_empty());
        assert!(runtime
            .block_on(exif.preview(&input, false))
            .unwrap()
            .is_some());
        assert!(runtime
            .block_on(exif.preview(&input, true))
            .unwrap()
            .is_some());
        for (format, core_format) in [
            (OutputFormat::Dng, x3f_core::OutputFormat::Dng),
            (OutputFormat::Tiff, x3f_core::OutputFormat::Tiff),
            (OutputFormat::Jpeg, x3f_core::OutputFormat::Jpeg),
        ] {
            let settings = BatchSettings {
                output_format: format,
                denoise_intensity: 0,
                output_directory: Some(temporary.path().to_owned()),
                ..Default::default()
            };
            let options = process_options(&settings, resources.join("opcodes"));
            let staging = tempfile::tempdir_in(temporary.path()).unwrap();
            let output = staging
                .path()
                .join(format!("output.{}", format.extension()));
            let mut stages = vec![];
            x3f_core::convert_file(
                &input,
                &output,
                core_format,
                &options,
                &AtomicBool::new(false),
                |s| stages.push(s),
            )
            .unwrap();
            if format == OutputFormat::Dng {
                runtime
                    .block_on(exif.copy_tags(&input, &output, &AtomicBool::new(false)))
                    .unwrap();
            }
            let bytes = std::fs::read(&output).unwrap();
            assert!(bytes.len() > 100);
            if format == OutputFormat::Jpeg {
                assert!(bytes.starts_with(&[0xff, 0xd8]));
            } else {
                assert!(bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*"));
            }
            let final_output = settings.output_path(&input).unwrap();
            publish(&output, &final_output, false).unwrap();
            assert!(final_output.is_file());
            assert!(!output.exists());
            if format == OutputFormat::Dng {
                let tags = |path: &std::path::Path| {
                    let bytes = runtime
                        .block_on(exif.run(
                            vec![
                                "-json".into(),
                                "-Model".into(),
                                "-DateTimeOriginal".into(),
                                path.into(),
                            ],
                            None,
                        ))
                        .unwrap();
                    serde_json::from_slice::<Vec<serde_json::Value>>(&bytes)
                        .unwrap()
                        .remove(0)
                };
                let source = tags(&input);
                let output = tags(&final_output);
                assert_eq!(source["Model"], output["Model"]);
                assert_eq!(source["DateTimeOriginal"], output["DateTimeOriginal"]);
            }
            assert!(!stages.is_empty());
        }
        let target = temporary.path().join(format!("cancelled-{camera}.dng"));
        let cancel = AtomicBool::new(false);
        let result = x3f_core::convert_file(
            &input,
            &target,
            x3f_core::OutputFormat::Dng,
            &x3f_core::ProcessOptions::default(),
            &cancel,
            |stage| {
                if matches!(stage, x3f_core::ConversionStage::Process) {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(matches!(result, Err(x3f_core::Error::Cancelled)));
        assert!(!target.exists());
    }
}
