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
        // A source removed after import is a per-file conversion error, not a batch rejection.
        validate_source_path(&file.path)?;
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
        compress: settings.compress && settings.output_format != OutputFormat::Jpeg,
        dng_highlight_recovery: settings.output_format == OutputFormat::Dng
            && settings.dng_highlight_recovery,
        cineon: settings.output_format == OutputFormat::Tiff && settings.cineon,
        opcodes_dir: (settings.output_format == OutputFormat::Dng
            && !settings.dng_highlight_recovery)
            .then_some(opcodes),
        ..Default::default()
    }
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
    let format = match settings.output_format {
        OutputFormat::Dng => x3f_core::OutputFormat::Dng,
        OutputFormat::Tiff => x3f_core::OutputFormat::Tiff,
        OutputFormat::Jpeg => x3f_core::OutputFormat::Jpeg,
    };
    let cancel = state.cancel.clone();
    let handle = app.clone();
    let batch_id = batch.to_string();
    let source = file.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        x3f_core::convert_file(&input, &core_path, format, &options, &cancel, |stage| {
            let value = match stage {
                x3f_core::ConversionStage::Read => 0.2,
                x3f_core::ConversionStage::Decode => 0.3,
                x3f_core::ConversionStage::Process => 0.4,
                x3f_core::ConversionStage::Write => 0.65,
            };
            progress(&handle, &batch_id, &source, value);
        })
        .map_err(|e| e.to_string())
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
    let warning = !report.warnings.is_empty();
    let message = report.warnings.join("\n");
    for warning in report.warnings {
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
    let lanes = concurrency(request.settings.concurrency).min(groups.lock().unwrap().len());
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
    fn replacement_approval_does_not_extend_to_new_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|name| ConvertFile {
                id: name.into(),
                path: dir.path().join(format!("{name}.X3F")),
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
}
