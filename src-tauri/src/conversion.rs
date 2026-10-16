use crate::{model::*, AppState};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

fn canonical_output(file: &ConvertFile, settings: &BatchSettings) -> Result<PathBuf, String> {
    let output = settings.output_path(&file.path)?;
    let parent = output.parent().ok_or("Missing output directory")?;
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.is_dir() {
        return Err("Output destination is not a directory".into());
    }
    Ok(parent.join(output.file_name().ok_or("Invalid output filename")?))
}

fn approved_targets(request: &StartRequest) -> HashSet<(String, PathBuf)> {
    request
        .approved_outputs
        .iter()
        .filter(|_| request.replace_existing)
        .map(|output| (output.id.clone(), output.output_path.clone()))
        .collect()
}

pub fn validate_approvals(
    request: &StartRequest,
    conflicts: &[OutputConflict],
) -> Result<(), String> {
    let approved = approved_targets(request);
    if conflicts
        .iter()
        .any(|output| !approved.contains(&(output.id.clone(), output.output_path.clone())))
    {
        return Err(
            "Output files already exist or changed. Review and confirm replacement.".into(),
        );
    }
    Ok(())
}

pub fn validate_batch(
    files: &[ConvertFile],
    settings: &BatchSettings,
) -> Result<Vec<OutputConflict>, String> {
    settings.validate()?;
    if files.is_empty() || files.len() > 100_000 {
        return Err("Invalid export batch size".into());
    }
    let mut ids = HashSet::new();
    let mut directories = HashSet::new();
    let mut targets: HashMap<String, Vec<OutputConflict>> = HashMap::new();
    let mut conflicts: HashMap<String, OutputConflict> = HashMap::new();
    for file in files {
        if file.id.is_empty() || file.id.len() > 128 || !ids.insert(&file.id) {
            return Err("Invalid or duplicate file ID".into());
        }
        if settings.is_rendered()
            && !file.source_revision.as_ref().is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("Review the source before edited export".into());
        }
        // A source removed after import is a per-file conversion error, not a batch rejection.
        validate_source_path(&file.path)?;
        if let Some(recipe) = &file.recipe {
            recipe.validate()?;
        }
        let output_path = canonical_output(file, settings)?;
        let parent = output_path.parent().ok_or("Missing output directory")?;
        if directories.insert(parent.to_owned()) {
            tempfile::NamedTempFile::new_in(parent)
                .map_err(|e| format!("Cannot write to {}: {e}", parent.display()))?;
        }
        let conflict = OutputConflict {
            id: file.id.clone(),
            output_path: output_path.clone(),
        };
        let mut legacy_name = file
            .path
            .file_name()
            .ok_or("Invalid input filename")?
            .to_os_string();
        legacy_name.push(format!(".{}", settings.output_format.extension()));
        if output_path.try_exists().map_err(|e| e.to_string())?
            || parent
                .join(legacy_name)
                .try_exists()
                .map_err(|e| e.to_string())?
        {
            conflicts.insert(file.id.clone(), conflict.clone());
        }
        targets
            .entry(output_path.to_string_lossy().to_lowercase())
            .or_default()
            .push(conflict);
    }
    for group in targets.into_values().filter(|g| g.len() > 1) {
        for conflict in group {
            conflicts.insert(conflict.id.clone(), conflict);
        }
    }
    Ok(files
        .iter()
        .filter_map(|file| conflicts.remove(&file.id))
        .collect())
}

fn target_groups(
    files: Vec<ConvertFile>,
    settings: &BatchSettings,
) -> Result<VecDeque<Vec<ConvertFile>>, String> {
    let mut indices = HashMap::new();
    let mut groups: Vec<Vec<ConvertFile>> = vec![];
    for file in files {
        let key = canonical_output(&file, settings)?
            .to_string_lossy()
            .to_lowercase();
        let index = *indices.entry(key).or_insert_with(|| {
            groups.push(vec![]);
            groups.len() - 1
        });
        groups[index].push(file);
    }
    Ok(groups.into())
}

fn status(
    app: &AppHandle,
    batch: &str,
    file: &ConvertFile,
    status: &str,
    message: Option<&str>,
    output: Option<&Path>,
) {
    let _ = app.emit_to(
        "main",
        "file:status",
        json!({"batchId":batch,"id":file.id,"status":status,"message":message,"outputPath":output}),
    );
}
fn progress(app: &AppHandle, batch: &str, file: &ConvertFile, value: f64) {
    let _ = app.emit_to(
        "main",
        "file:progress",
        json!({"batchId":batch,"id":file.id,"progress":value}),
    );
}

pub fn process_options(settings: &BatchSettings, opcodes: PathBuf) -> x3f_core::ProcessOptions {
    x3f_core::ProcessOptions {
        color_encoding: match settings.color_profile {
            ColorProfile::Srgb => x3f_core::ColorEncoding::Srgb,
            ColorProfile::AdobeRgb => x3f_core::ColorEncoding::AdobeRgb,
            ColorProfile::ProPhotoRgb => x3f_core::ColorEncoding::ProPhotoRgb,
            ColorProfile::None => x3f_core::ColorEncoding::None,
        },
        denoise_intensity: settings.denoise_intensity,
        denoise_options: settings.denoise_options,
        compress: settings.compress && settings.output_format != OutputFormat::Jpeg,
        dng_highlight_recovery: settings.output_format == OutputFormat::Dng
            && settings.dng_highlight_recovery,
        cineon: settings.output_format == OutputFormat::Tiff && settings.cineon,
        // DNG always embeds every Color Mode profile, with the as-shot mode as
        // the default. TIFF needs rendered color without Cineon. Other formats ignore the mode.
        color_mode: match settings.output_format {
            OutputFormat::Dng => Some(x3f_core::ColorMode::AsShot),
            OutputFormat::Tiff
                if !settings.cineon && settings.color_profile != ColorProfile::None =>
            {
                settings
                    .color_mode
                    .as_deref()
                    .and_then(|mode| mode.parse().ok())
            }
            _ => None,
        },
        opcodes_dir: (settings.output_format == OutputFormat::Dng
            && !settings.dng_highlight_recovery)
            .then_some(opcodes),
        ..Default::default()
    }
}

/// Converts with the selected Color Mode. If core cannot use the mode for this
/// file, such as a Merrill-only mode set or a photo shot in Monochrome, it uses
/// Standard. If the camera has no Color Modes, it converts without a mode.
fn convert(
    input: &Path,
    output: &Path,
    format: x3f_core::OutputFormat,
    options: &x3f_core::ProcessOptions,
    cancel: &std::sync::atomic::AtomicBool,
    mut on_stage: impl FnMut(x3f_core::ConversionStage),
) -> Result<Vec<String>, String> {
    use x3f_core::ColorMode::{AsShot, Standard};
    let requested = options.color_mode;
    let mut options = options.clone();
    let mut reason = String::new();
    // As shot is the DNG default, so a camera without Color Modes is not a warning.
    let mut quiet = false;
    // Read the camera's modes first, so that an unusable mode costs no decode.
    if let Some(mode) = requested {
        match x3f_core::Reader::open(input).and_then(|mut reader| reader.available_color_modes()) {
            Ok(modes) if modes.contains(&Standard) => {
                if mode != AsShot && !modes.contains(&mode) {
                    options.color_mode = Some(Standard);
                    reason = "this camera does not have it".into();
                }
            }
            result => {
                options.color_mode = None;
                reason = result.map_or_else(|e| e.to_string(), |_| "no color modes".into());
                quiet = format == x3f_core::OutputFormat::Dng && mode == AsShot;
            }
        }
    }
    let report = loop {
        match x3f_core::convert_file(input, output, format, &options, cancel, &mut on_stage) {
            // Core reports an unusable mode as invalid data. ponytail: an as-shot
            // Monochrome or Sepia photo decodes twice, because core does not tell
            // the as-shot mode before the decode.
            Err(x3f_core::Error::InvalidData(error)) if options.color_mode.is_some() => {
                options.color_mode = (options.color_mode != Some(Standard)).then_some(Standard);
                reason = error;
            }
            result => break result.map_err(|e| e.to_string())?,
        }
    };
    let used = options.color_mode;
    let warning = match (requested, used) {
        (Some(mode), Some(used)) if used != mode => Some(format!(
            "Used the {used} color mode instead of {mode}: {reason}"
        )),
        (Some(mode), None) if !quiet => {
            Some(format!("Exported without the {mode} color mode: {reason}"))
        }
        _ => None,
    };
    Ok(warning.into_iter().chain(report.warnings).collect())
}

async fn process_file(
    app: &AppHandle,
    state: &Arc<AppState>,
    batch: &str,
    file: &ConvertFile,
    settings: &BatchSettings,
    approved: &HashSet<(String, PathBuf)>,
) -> Result<bool, String> {
    let check = || {
        if state.cancel.load(Ordering::Relaxed) {
            Err("Export cancelled".to_string())
        } else {
            Ok(())
        }
    };
    check()?;
    status(app, batch, file, "processing", None, None);
    state.logs.write(
        "conversion",
        format!("Starting export: {}", file.path.display()),
    );
    progress(app, batch, file, 0.1);
    // Resolve the parent again so approval for a symlink's old destination
    // cannot authorize replacement in a different directory.
    let target = canonical_output(file, settings)?;
    let directory = target.parent().ok_or("Missing output directory")?;
    // TempDir owns all ExifTool auxiliaries too. Its location keeps publication on the same filesystem.
    let temporary = tempfile::Builder::new()
        .prefix(".x3fuse-")
        .tempdir_in(directory)
        .map_err(|e| e.to_string())?;
    let temp_path = temporary
        .path()
        .join(format!("output.{}", settings.output_format.extension()));
    let core_path = temp_path.clone();
    let input = file.path.clone();
    let options = process_options(settings, state.resources.join("opcodes"));
    let cancel = state.cancel.clone();
    let handle = app.clone();
    let batch_id = batch.to_string();
    let source = file.clone();
    let export_state = state.clone();
    let export_settings = settings.clone();
    let warnings = tauri::async_runtime::spawn_blocking(move || {
        if export_settings.is_rendered() {
            let recipe = match &source.recipe {
                Some(recipe) => recipe.clone(),
                None => export_state.editor.default_recipe(
                    &input,
                    source
                        .source_revision
                        .as_deref()
                        .ok_or("Review the source before edited export")?,
                    &cancel,
                )?,
            };
            progress(&handle, &batch_id, &source, 0.25);
            export_state.editor.export(
                &input,
                source.source_revision.as_deref(),
                &recipe,
                &export_settings,
                &core_path,
                &cancel,
            )?;
            return Ok(Vec::new());
        }
        let format = match export_settings.output_format {
            OutputFormat::Dng => x3f_core::OutputFormat::Dng,
            OutputFormat::Tiff => x3f_core::OutputFormat::Tiff,
            OutputFormat::Jpeg => x3f_core::OutputFormat::Jpeg,
            OutputFormat::RenderedJpeg => {
                return Err("Rendered JPEG requires the editor pipeline".into())
            }
        };
        convert(&input, &core_path, format, &options, &cancel, |stage| {
            let value = match stage {
                x3f_core::ConversionStage::Read => 0.2,
                x3f_core::ConversionStage::Decode => 0.3,
                x3f_core::ConversionStage::Process => 0.4,
                x3f_core::ConversionStage::Write => 0.65,
            };
            progress(&handle, &batch_id, &source, value);
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    check()?;
    progress(app, batch, file, 0.7);
    if settings.output_format == OutputFormat::Dng {
        state
            .exif
            .copy_tags(&file.path, &temp_path, &state.cancel)
            .await?;
    } else if settings.is_rendered() {
        state
            .exif
            .copy_rendered_tags(&file.path, &temp_path, &state.cancel)
            .await?;
        let input = file.path.clone();
        let expected = file.source_revision.clone();
        let editor_state = state.clone();
        let actual = tauri::async_runtime::spawn_blocking(move || {
            editor_state.editor.edits.source_revision(&input)
        })
        .await
        .map_err(|e| e.to_string())??;
        if expected.as_deref() != Some(actual.as_str()) {
            return Err("Source changed during export; review the photo again".into());
        }
    }
    check()?;
    progress(app, batch, file, 0.9);
    let info = std::fs::metadata(&temp_path).map_err(|e| format!("Output missing: {e}"))?;
    if !info.is_file() || info.len() == 0 {
        return Err("Output file is empty".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o644))
        {
            state
                .logs
                .write("error", format!("Output permissions: {e}"));
        }
    }
    check()?;
    publish_approved(&temp_path, &target, &file.id, approved)?;
    // After publication the validated file is complete, even if Stop arrives concurrently.
    let warning = !warnings.is_empty();
    let message = warnings.join("\n");
    for warning in warnings {
        state.logs.write("conversion", warning);
    }
    progress(app, batch, file, 1.0);
    status(
        app,
        batch,
        file,
        if warning { "warning" } else { "completed" },
        warning.then_some(message.as_str()),
        Some(&target),
    );
    state.logs.write(
        "conversion",
        format!("Export completed: {}", target.display()),
    );
    Ok(warning)
}

fn publish_approved(
    temp: &Path,
    target: &Path,
    id: &str,
    approved: &HashSet<(String, PathBuf)>,
) -> Result<(), String> {
    publish(
        temp,
        target,
        approved.contains(&(id.to_owned(), target.to_owned())),
    )
}

/// `persist_noclobber` checks at publication, avoiding the existence-check/write race.
pub fn publish(temp: &Path, target: &Path, replace: bool) -> Result<(), String> {
    let temp = tempfile::TempPath::try_from_path(temp).map_err(|e| e.to_string())?;
    if replace {
        temp.persist(target).map_err(|e| e.to_string())
    } else {
        temp.persist_noclobber(target)
            .map_err(|e| format!("Output exists or cannot be published: {e}"))
    }
}

pub async fn run_batch(
    app: AppHandle,
    state: Arc<AppState>,
    request: StartRequest,
) -> Result<(), String> {
    let groups = match target_groups(request.files.clone(), &request.settings) {
        Ok(groups) => groups,
        Err(error) => {
            for file in &request.files {
                status(&app, &request.batch_id, file, "failed", Some(&error), None);
            }
            let _ = app.emit_to(
                "main",
                "batch:complete",
                BatchSummary {
                    batch_id: request.batch_id,
                    failed: request.files.len(),
                    total: request.files.len(),
                    ..Default::default()
                },
            );
            return Ok(());
        }
    };
    let groups = Arc::new(Mutex::new(groups));
    let lanes = if request.settings.is_rendered() {
        1
    } else {
        concurrency(request.settings.concurrency).min(groups.lock().unwrap().len())
    };
    let summary = Arc::new(Mutex::new(BatchSummary {
        batch_id: request.batch_id.clone(),
        total: request.files.len(),
        ..Default::default()
    }));
    let approved = Arc::new(approved_targets(&request));
    let request = Arc::new(request);
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..lanes {
        let (app, state, request, groups, summary, approved) = (
            app.clone(),
            state.clone(),
            request.clone(),
            groups.clone(),
            summary.clone(),
            approved.clone(),
        );
        workers.spawn(async move {
            loop {
                if state.cancel.load(Ordering::Relaxed) {
                    break;
                }
                let group = groups.lock().unwrap().pop_front();
                let Some(group) = group else {
                    break;
                };
                for file in group {
                    if state.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    match process_file(
                        &app,
                        &state,
                        &request.batch_id,
                        &file,
                        &request.settings,
                        &approved,
                    )
                    .await
                    {
                        Ok(warning) => {
                            let mut s = summary.lock().unwrap();
                            s.completed += 1;
                            s.warnings += usize::from(warning);
                        }
                        Err(_) if state.cancel.load(Ordering::Relaxed) => {
                            status(&app, &request.batch_id, &file, "queued", None, None)
                        }
                        Err(e) => {
                            state
                                .logs
                                .write("error", format!("{}: {e}", file.path.display()));
                            summary.lock().unwrap().failed += 1;
                            status(&app, &request.batch_id, &file, "failed", Some(&e), None);
                        }
                    }
                }
            }
        });
    }
    while let Some(result) = workers.join_next().await {
        if let Err(e) = result {
            state
                .logs
                .write("error", format!("Export worker failed: {e}"));
            state.cancel.store(true, Ordering::Relaxed);
        }
    }
    let mut summary = summary.lock().unwrap().clone();
    summary.cancelled = state.cancel.load(Ordering::Relaxed);
    let _ = app.emit_to("main", "batch:complete", summary);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_export_requires_a_reviewed_source_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let mut file = ConvertFile {
            id: "photo".into(),
            path: directory.path().join("photo.X3F"),
            ..Default::default()
        };
        let settings = BatchSettings {
            output_format: OutputFormat::RenderedJpeg,
            rendering: Rendering::Rendered,
            ..Default::default()
        };
        assert!(validate_batch(&[file.clone()], &settings).is_err());
        file.source_revision = Some("a".repeat(64));
        assert!(validate_batch(&[file], &settings).is_ok());
    }

    #[test]
    fn replacement_approval_does_not_extend_to_new_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|name| ConvertFile {
                id: name.into(),
                path: dir.path().join(format!("{name}.X3F")),
                ..Default::default()
            })
            .collect();
        let settings = BatchSettings {
            output_directory: Some(dir.path().into()),
            ..Default::default()
        };
        let first = canonical_output(&files[0], &settings).unwrap();
        let second = canonical_output(&files[1], &settings).unwrap();
        std::fs::write(&first, b"reviewed output").unwrap();
        let conflicts = validate_batch(&files, &settings).unwrap();
        assert_eq!(conflicts.len(), 1);
        let mut request = StartRequest {
            batch_id: "batch".into(),
            files,
            settings,
            replace_existing: true,
            approved_outputs: conflicts.clone(),
        };
        validate_approvals(&request, &conflicts).unwrap();
        let approved = approved_targets(&request);

        // A different output appears after start validation. Only the reviewed
        // target may be replaced; publication must preserve the unexpected file.
        std::fs::write(&second, b"new user file").unwrap();
        let temp = dir.path().join("pending.dng");
        std::fs::write(&temp, b"converted").unwrap();
        publish_approved(&temp, &first, "one", &approved).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"converted");
        std::fs::write(&temp, b"converted").unwrap();
        assert!(publish_approved(&temp, &second, "two", &approved).is_err());
        assert_eq!(std::fs::read(&second).unwrap(), b"new user file");

        // The same race before convert_start must fail its revalidation.
        let current = validate_batch(&request.files, &request.settings).unwrap();
        assert!(validate_approvals(&request, &current).is_err());
        request.approved_outputs = current;
        request.replace_existing = false;
        assert!(validate_approvals(&request, &conflicts).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn retargeted_output_symlink_does_not_reuse_replacement_approval() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        std::fs::write(first.join("photo.dng"), b"reviewed").unwrap();
        std::fs::write(second.join("photo.dng"), b"unreviewed").unwrap();
        let link = dir.path().join("destination");
        symlink(&first, &link).unwrap();
        let files = vec![ConvertFile {
            id: "photo".into(),
            path: dir.path().join("photo.X3F"),
            ..Default::default()
        }];
        let settings = BatchSettings {
            output_directory: Some(link.clone()),
            ..Default::default()
        };
        let approved_outputs = validate_batch(&files, &settings).unwrap();
        let request = StartRequest {
            batch_id: "batch".into(),
            files,
            settings,
            replace_existing: true,
            approved_outputs,
        };
        std::fs::remove_file(&link).unwrap();
        symlink(&second, &link).unwrap();
        let current = validate_batch(&request.files, &request.settings).unwrap();
        assert!(validate_approvals(&request, &current).is_err());
        let target = canonical_output(&request.files[0], &request.settings).unwrap();
        let temp = second.join("pending.dng");
        std::fs::write(&temp, b"converted").unwrap();
        assert!(publish_approved(&temp, &target, "photo", &approved_targets(&request)).is_err());
        assert_eq!(
            std::fs::read(second.join("photo.dng")).unwrap(),
            b"unreviewed"
        );
    }

    #[test]
    fn destinations_are_serialized_and_replacement_is_checked_at_publication() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("one");
        let b = dir.path().join("two");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let files: Vec<_> = [a, b]
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let path = p.join("same.X3F");
                std::fs::write(&path, b"source").unwrap();
                ConvertFile {
                    id: i.to_string(),
                    path,
                    ..Default::default()
                }
            })
            .collect();
        let settings = BatchSettings {
            output_directory: Some(dir.path().to_owned()),
            ..Default::default()
        };
        assert_eq!(validate_batch(&files, &settings).unwrap().len(), 2);
        assert_eq!(target_groups(files, &settings).unwrap().len(), 1);
        let temp = dir.path().join("temp.dng");
        let target = dir.path().join("same.dng");
        std::fs::write(&target, b"original").unwrap();
        std::fs::write(&temp, b"replacement").unwrap();
        assert!(publish(&temp, &target, false).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        std::fs::write(&temp, b"replacement").unwrap();
        publish(&temp, &target, true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    }
    #[test]
    fn option_mapping_keeps_highlight_recovery_and_opcodes_exclusive() {
        let mut settings = BatchSettings::default();
        assert!(process_options(&settings, "opcodes".into())
            .opcodes_dir
            .is_some());
        settings.dng_highlight_recovery = true;
        let options = process_options(&settings, "opcodes".into());
        assert!(options.opcodes_dir.is_none());
        assert!(options.dng_highlight_recovery);
        settings.output_format = OutputFormat::Tiff;
        settings.cineon = true;
        let options = process_options(&settings, "opcodes".into());
        assert!(!options.dng_highlight_recovery);
        assert!(options.cineon);
    }

    #[test]
    fn color_mode_applies_only_where_core_accepts_it() {
        let mut settings = BatchSettings {
            color_mode: Some("FCBlue".into()),
            ..Default::default()
        };
        let mode =
            |settings: &BatchSettings| process_options(settings, "opcodes".into()).color_mode;
        // DNG always embeds every Color Mode profile, with the as-shot default.
        assert_eq!(mode(&settings), Some(x3f_core::ColorMode::AsShot));
        settings.output_format = OutputFormat::Tiff;
        assert_eq!(mode(&settings), Some(x3f_core::ColorMode::FCBlue));
        settings.cineon = true;
        assert_eq!(mode(&settings), None);
        settings.cineon = false;
        settings.color_profile = ColorProfile::None;
        assert_eq!(mode(&settings), None);
        settings.output_format = OutputFormat::Jpeg;
        settings.color_profile = ColorProfile::Srgb;
        assert_eq!(mode(&settings), None);
        settings.color_mode = Some("as-shot".into());
        assert!(settings.validate().is_ok());
        settings.color_mode = Some("Sepia".into());
        assert!(settings.validate().is_err());

        // A failure that is not about the mode stays a failure.
        let dir = tempfile::tempdir().unwrap();
        let mut options = process_options(&BatchSettings::default(), "opcodes".into());
        options.color_mode = Some(x3f_core::ColorMode::Vivid);
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let tiff = x3f_core::OutputFormat::Tiff;
        let missing = dir.path().join("missing.X3F");
        assert!(convert(
            &missing,
            &dir.path().join("a.tif"),
            tiff,
            &options,
            &cancel,
            |_| {}
        )
        .is_err());
        // Merrill supports six modes. X3FUSE_TEST_MERRILL names a real Merrill X3F.
        if let Some(merrill) = std::env::var_os("X3FUSE_TEST_MERRILL") {
            options.color_mode = Some(x3f_core::ColorMode::SunsetRed);
            let output = dir.path().join("b.tif");
            let warnings = convert(
                Path::new(&merrill),
                &output,
                tiff,
                &options,
                &cancel,
                |_| {},
            );
            let warnings = warnings.unwrap();
            assert!(warnings[0].contains("Standard color mode instead of Sunset Red"));
            assert!(output.is_file());
            let output = dir.path().join("c.dng");
            let dng = process_options(&BatchSettings::default(), "opcodes".into());
            let warnings = convert(
                Path::new(&merrill),
                &output,
                x3f_core::OutputFormat::Dng,
                &dng,
                &cancel,
                |_| {},
            );
            assert!(warnings.is_ok());
            let bytes = std::fs::read(&output).unwrap();
            assert!(bytes.windows(16).any(|w| w == b"FOV Classic Blue"));
        }
    }
}
