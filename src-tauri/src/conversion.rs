use crate::{model::*, AppState};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

fn canonical_output(file: &ConvertFile, settings: &BatchSettings) -> Result<PathBuf, String> {
    let settings = file.effective_settings(settings);
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
    for file in files {
        if file.path.is_file() {
            crate::source::remember(&file.path)?;
        }
    }
    let mut ids = HashSet::new();
    let mut directories = HashSet::new();
    let mut targets: HashMap<String, Vec<OutputConflict>> = HashMap::new();
    let mut conflicts: HashMap<String, OutputConflict> = HashMap::new();
    let mut protected = Vec::new();
    for file in files {
        let settings = file.effective_settings(settings);
        crate::source::Kind::of(&file.path).validate_export(settings)?;
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
            crate::source::validate_recipe(&file.path, recipe)?;
        }
        let output_path = canonical_output(file, settings)?;
        if let Err(error) = crate::source::protect_output(&output_path, [file.path.clone()]) {
            protected.push(error);
            continue;
        }
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
    if !protected.is_empty() {
        return Err(protected.join("\n"));
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

fn worker_count(request: &StartRequest, groups: usize) -> usize {
    if request
        .files
        .iter()
        .any(|file| file.effective_settings(&request.settings).is_rendered())
    {
        1
    } else {
        concurrency(request.settings.concurrency).min(groups)
    }
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
        x3i_source: settings.x3i_source,
        ..Default::default()
    }
}

/// Core reports X3I merge statistics, and a hint about an environment
/// variable, with its warnings. They are diagnostics for the log only.
fn x3i_diagnostic(line: &str) -> bool {
    const FRAME: [&str; 5] = [
        "shutter_us=",
        "statistics ",
        "aligned-ratio-bin ",
        "ghost-bin ",
        "alignment ",
    ];
    [
        "X3I middle exposure: ",
        "X3I saturation: ",
        "X3I merge: ",
        "X3I noise: ",
        "X3I denoise is off;",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
        || line
            .strip_prefix("X3I frame ")
            .and_then(|rest| rest.split_once(": "))
            .is_some_and(|(_, rest)| FRAME.iter().any(|prefix| rest.starts_with(prefix)))
}

/// Converts with the selected Color Mode. If core cannot use the mode for this
/// file, such as a Merrill-only mode set or a photo shot in Monochrome, it uses
/// Standard. If the camera has no Color Modes, it converts without a mode.
/// Returns warnings for the user, then details for the log only.
fn convert(
    input: &Path,
    output: &Path,
    format: x3f_core::OutputFormat,
    options: &x3f_core::ProcessOptions,
    cancel: &std::sync::atomic::AtomicBool,
    mut on_stage: impl FnMut(x3f_core::ConversionStage),
) -> Result<(Vec<String>, Vec<String>), String> {
    use x3f_core::ColorMode::{AsShot, Standard};
    let x3i = crate::x3i::is_x3i(input);
    // Frame 0 holds the camera metadata and the reference exposure of an X3I.
    let reader = || {
        if x3i {
            x3f_core::X3iContainer::open(input).and_then(|container| container.open_frame(0))
        } else {
            x3f_core::Reader::open(input)
        }
    };
    let requested = options.color_mode;
    let mut options = options.clone();
    // An X3I has an embedded JPEG in each frame, and no merged one.
    if format == x3f_core::OutputFormat::Jpeg {
        options.x3i_source = x3f_core::X3iSource::MiddleExposure;
    }
    let mut reason = String::new();
    // As shot is the DNG default, so a camera without Color Modes is not a warning.
    let mut quiet = false;
    // Read the camera's modes first, so that an unusable mode costs no decode.
    if let Some(mode) = requested {
        match reader().and_then(|mut reader| reader.available_color_modes()) {
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
    // A merge holds about 3 GB, so X3I files merge one at a time.
    let _merge = (x3i && options.x3i_source == x3f_core::X3iSource::Merge)
        .then(|| crate::x3i::MERGE.lock())
        .transpose()
        .map_err(|_| "X3I merge unavailable")?;
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
    let (details, warnings) = report.warnings.into_iter().partition(|w| x3i_diagnostic(w));
    Ok((warning.into_iter().chain(warnings).collect(), details))
}

async fn process_file(
    app: &AppHandle,
    state: &Arc<AppState>,
    batch: &str,
    file: &ConvertFile,
    settings: &BatchSettings,
    approved: &HashSet<(String, PathBuf)>,
) -> Result<bool, String> {
    let settings = file.effective_settings(settings);
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
    crate::source::Kind::of(&file.path).validate_export(settings)?;
    crate::source::protect_output(&target, [file.path.clone()])?;
    state.editor.edits.protect_backup(&target)?;
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
    let (warnings, details) = tauri::async_runtime::spawn_blocking(move || {
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
            return Ok((Vec::new(), Vec::new()));
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
    // The tags of an X3I come from the frames that the pixels use.
    let x3i_source = if settings.is_rendered() {
        file.recipe
            .as_ref()
            .map_or(x3f_render::EditRecipe::default().x3i_source, |recipe| {
                recipe.x3i_source
            })
    } else {
        settings.x3i_source
    };
    if settings.output_format == OutputFormat::Dng {
        state
            .exif
            .copy_tags(&file.path, x3i_source, &temp_path, &state.cancel)
            .await?;
    } else if settings.is_rendered() {
        state
            .exif
            .copy_rendered_tags(&file.path, x3i_source, &temp_path, &state.cancel)
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
    crate::source::protect_output(&target, [file.path.clone()])?;
    state.editor.edits.protect_backup(&target)?;
    publish_approved(&temp_path, &target, &file.id, approved)?;
    // After publication the validated file is complete, even if Stop arrives concurrently.
    let warning = !warnings.is_empty();
    let message = warnings.join("\n");
    for warning in warnings.into_iter().chain(details) {
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
    let lanes = worker_count(&request, groups.len());
    let groups = Arc::new(Mutex::new(groups));
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
    #[ignore = "Set X3FUSE_TEST_X3I to an absolute X3I path"]
    fn x3i_converts_to_dng_and_its_embedded_jpeg() {
        use x3f_core::X3iSource::{Merge, MiddleExposure};
        let input = PathBuf::from(std::env::var_os("X3FUSE_TEST_X3I").expect("X3FUSE_TEST_X3I"));
        let directory = tempfile::tempdir().unwrap();
        let opcodes = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/opcodes");
        for (format, core, source) in [
            (OutputFormat::Jpeg, x3f_core::OutputFormat::Jpeg, Merge),
            (
                OutputFormat::Jpeg,
                x3f_core::OutputFormat::Jpeg,
                MiddleExposure,
            ),
            (
                OutputFormat::Dng,
                x3f_core::OutputFormat::Dng,
                MiddleExposure,
            ),
            (OutputFormat::Dng, x3f_core::OutputFormat::Dng, Merge),
        ] {
            let settings = BatchSettings {
                output_format: format,
                x3i_source: source,
                ..Default::default()
            };
            let output = directory
                .path()
                .join(format!("x3i-{source:?}.{}", format.extension()));
            let warnings = convert(
                &input,
                &output,
                core,
                &process_options(&settings, opcodes.clone()),
                &std::sync::atomic::AtomicBool::new(false),
                |_| (),
            )
            .unwrap();
            assert!(std::fs::metadata(&output).unwrap().len() > 0);
            // Merge statistics and the chosen frame go to the log, not to the user.
            assert!(!warnings.0.iter().any(|w| x3i_diagnostic(w)));
            // An embedded JPEG always comes from the middle exposure.
            let merged = format == OutputFormat::Dng && source == Merge;
            let prefix = if merged {
                "X3I merge: "
            } else {
                "X3I middle exposure: "
            };
            assert!(
                warnings.1.iter().any(|line| line.starts_with(prefix)),
                "{warnings:?}"
            );
        }
    }

    #[test]
    fn x3i_statistics_are_diagnostics_and_fallbacks_are_warnings() {
        assert!(x3i_diagnostic(
            "X3I frame 3: ghost-bin lower=0.05000 upper=0.11875"
        ));
        assert!(x3i_diagnostic("X3I merge: frames=7 s=2.78"));
        assert!(x3i_diagnostic(
            "X3I middle exposure: frame 0 shutter_us=4000"
        ));
        assert!(!x3i_diagnostic("X3I safety limit clipped 12 samples"));
        assert!(!x3i_diagnostic(
            "X3I ratio warning: frame=5 fit 1.3 exceeds 0.3 EV; keep shutter ratio 0.25"
        ));
        assert!(!x3i_diagnostic(
            "Unknown or empty as-shot Color Mode resolved to Standard"
        ));
    }

    #[test]
    fn validation_reports_all_protected_sources() {
        let directory = tempfile::tempdir().unwrap();
        let files: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|name| {
                let dng = directory.path().join(format!("{name}.dng"));
                std::fs::write(&dng, b"source").unwrap();
                std::fs::write(crate::edits::sidecar(&dng), b"edits").unwrap();
                ConvertFile {
                    id: name.into(),
                    path: directory.path().join(format!("{name}.X3F")),
                    ..Default::default()
                }
            })
            .collect();
        let error = validate_batch(&files, &BatchSettings::default()).unwrap_err();
        assert!(error.contains("one.dng") && error.contains("two.dng"));
    }

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
    fn per_file_formats_and_directories_control_conflicts_and_groups() {
        let directory = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let settings = BatchSettings::default();
        let files: Vec<_> = [
            None,
            Some(BatchSettings {
                output_format: OutputFormat::Tiff,
                ..Default::default()
            }),
            Some(BatchSettings {
                output_directory: Some(other.path().to_owned()),
                ..Default::default()
            }),
        ]
        .into_iter()
        .enumerate()
        .map(|(id, settings)| ConvertFile {
            id: id.to_string(),
            path: directory.path().join("same.X3F"),
            settings,
            ..Default::default()
        })
        .collect();
        let outputs = [
            directory.path().canonicalize().unwrap().join("same.dng"),
            directory
                .path()
                .canonicalize()
                .unwrap()
                .join("same.X3F.tif"),
            other.path().canonicalize().unwrap().join("same.dng"),
        ];
        for (file, output) in files.iter().zip(&outputs) {
            assert_eq!(canonical_output(file, &settings).unwrap(), *output);
        }
        assert!(validate_batch(&files, &settings).unwrap().is_empty());
        assert_eq!(target_groups(files.clone(), &settings).unwrap().len(), 3);

        std::fs::write(&outputs[0], b"existing DNG").unwrap();
        std::fs::write(&outputs[1], b"existing TIFF").unwrap();
        std::fs::write(other.path().join("same.X3F.dng"), b"legacy DNG").unwrap();
        let conflicts = validate_batch(&files, &settings).unwrap();
        assert_eq!(conflicts.len(), 3);
        for (conflict, output) in conflicts.iter().zip(&outputs) {
            assert_eq!(conflict.output_path, *output);
        }

        let mut duplicates = files;
        let mut duplicate = duplicates[2].clone();
        duplicate.id = "duplicate".into();
        duplicates.push(duplicate);
        let groups = target_groups(duplicates, &settings).unwrap();
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[2].len(), 2);
    }

    #[test]
    fn per_file_settings_validate_before_export() {
        let directory = tempfile::tempdir().unwrap();
        let settings = BatchSettings::default();
        let mut file = ConvertFile {
            id: "photo".into(),
            path: directory.path().join("photo.X3F"),
            settings: Some(BatchSettings {
                denoise_intensity: 11,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            validate_batch(&[file.clone()], &settings).unwrap_err(),
            "Invalid export setting"
        );
        file.settings = Some(BatchSettings {
            output_directory: Some("relative".into()),
            ..Default::default()
        });
        assert_eq!(
            validate_batch(&[file.clone()], &settings).unwrap_err(),
            "Output directory must be an absolute path"
        );
        file.settings = Some(BatchSettings {
            output_format: OutputFormat::RenderedJpeg,
            ..Default::default()
        });
        assert_eq!(
            validate_batch(&[file.clone()], &settings).unwrap_err(),
            "Review the source before edited export"
        );
        file.source_revision = Some("a".repeat(64));
        assert!(validate_batch(&[file.clone()], &settings).is_ok());
        file.settings.as_mut().unwrap().cineon = true;
        assert!(validate_batch(&[file.clone()], &settings).is_err());

        file.settings = Some(BatchSettings::default());
        file.source_revision = None;
        let rendered_fallback = BatchSettings {
            output_format: OutputFormat::RenderedJpeg,
            ..Default::default()
        };
        assert!(validate_batch(&[file], &rendered_fallback).is_ok());
    }

    #[test]
    fn rendered_file_serializes_workers_and_batch_controls_concurrency() {
        let mut request = StartRequest {
            batch_id: "batch".into(),
            files: vec![
                ConvertFile::default(),
                ConvertFile {
                    settings: Some(BatchSettings {
                        concurrency: 8,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ],
            settings: BatchSettings {
                concurrency: 3,
                ..Default::default()
            },
            replace_existing: false,
            approved_outputs: vec![],
        };
        assert_eq!(worker_count(&request, 4), concurrency(3).min(4));
        request.files[1].settings.as_mut().unwrap().output_format = OutputFormat::RenderedJpeg;
        assert_eq!(worker_count(&request, 4), 1);
        request.files[1].settings.as_mut().unwrap().output_format = OutputFormat::Dng;
        request.settings.output_format = OutputFormat::RenderedJpeg;
        assert_eq!(worker_count(&request, 4), 1);
        request.files[0].settings = Some(BatchSettings::default());
        assert_eq!(worker_count(&request, 4), concurrency(3).min(4));
    }

    #[test]
    fn replacement_approval_does_not_extend_to_new_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|name| ConvertFile {
                id: name.into(),
                path: dir.path().join(format!("{name}.X3F")),
                settings: (name == "two").then(|| BatchSettings {
                    output_format: OutputFormat::Tiff,
                    ..Default::default()
                }),
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
            let (warnings, _) = warnings.unwrap();
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
