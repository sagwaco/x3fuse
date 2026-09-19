use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum OutputFormat {
    #[serde(rename = "dng")]
    Dng,
    #[serde(rename = "embeddedJpg")]
    Jpeg,
    #[serde(rename = "tiff")]
    Tiff,
}

impl OutputFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Dng => "dng",
            Self::Jpeg => "jpg",
            Self::Tiff => "tif",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ColorProfile {
    #[serde(rename = "sRGB")]
    Srgb,
    #[serde(rename = "adobeRGB")]
    AdobeRgb,
    #[serde(rename = "proPhotoRGB")]
    ProPhotoRgb,
    #[serde(rename = "none")]
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSettings {
    pub output_format: OutputFormat,
    pub compress: bool,
    pub denoise_intensity: u8,
    pub color_profile: ColorProfile,
    pub dng_highlight_recovery: bool,
    pub cineon: bool,
    pub output_directory: Option<PathBuf>,
    pub concurrency: u8,
}

impl Default for BatchSettings {
    fn default() -> Self {
        Self {
            output_format: OutputFormat::Dng,
            compress: false,
            denoise_intensity: 10,
            color_profile: ColorProfile::Srgb,
            dng_highlight_recovery: false,
            cineon: false,
            output_directory: None,
            concurrency: 0,
        }
    }
}

impl BatchSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.denoise_intensity > 10 || self.concurrency > 8 {
            return Err("Invalid export setting".into());
        }
        if self
            .output_directory
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        {
            return Err("Output directory must be an absolute path".into());
        }
        Ok(())
    }

    pub fn output_path(&self, input: &Path) -> Result<PathBuf, String> {
        let name = if self.output_format == OutputFormat::Dng {
            input.file_stem()
        } else {
            input.file_name()
        }
        .ok_or("Invalid input filename")?;
        let mut name = name.to_os_string();
        name.push(format!(".{}", self.output_format.extension()));
        let dir = self
            .output_directory
            .as_deref()
            .or_else(|| input.parent())
            .ok_or("Missing output directory")?;
        Ok(dir.join(name))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(flatten)]
    pub batch: BatchSettings,
    pub debug_logging_enabled: bool,
    pub has_previous_conversion: bool,
    pub sort_field: String,
    pub sort_ascending: bool,
    pub auto_check_updates: bool,
    pub auto_download_updates: bool,
    pub queue_view_mode: String,
    pub inspector_open: bool,
    pub inspector_scope_mode: String,
    pub last_import_directory: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            batch: BatchSettings::default(),
            debug_logging_enabled: false,
            has_previous_conversion: false,
            sort_field: "File Name".into(),
            sort_ascending: true,
            auto_check_updates: true,
            auto_download_updates: false,
            queue_view_mode: "list".into(),
            inspector_open: false,
            inspector_scope_mode: "rgbParade".into(),
            last_import_directory: None,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        self.batch.validate()?;
        if !["File Name", "Date", "Size"].contains(&self.sort_field.as_str())
            || !["list", "grid", "filmstrip"].contains(&self.queue_view_mode.as_str())
            || !["histogram", "rgbParade", "waveform", "vectorscope"]
                .contains(&self.inspector_scope_mode.as_str())
            || self
                .last_import_directory
                .as_ref()
                .is_some_and(|p| !p.is_absolute())
        {
            return Err("Invalid application setting".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConvertFile {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BatchRequest {
    pub files: Vec<ConvertFile>,
    pub settings: BatchSettings,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub batch_id: String,
    pub files: Vec<ConvertFile>,
    pub settings: BatchSettings,
    pub replace_existing: bool,
    #[serde(default)]
    pub approved_outputs: Vec<OutputConflict>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputConflict {
    pub id: String,
    pub output_path: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub batch_id: String,
    pub cancelled: bool,
    pub completed: usize,
    pub failed: usize,
    pub warnings: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub id: String,
    pub path: PathBuf,
    pub file_name: String,
    pub file_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExifPair {
    pub label: String,
    pub value: String,
}

pub fn validate_source_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("x3f"))
    {
        return Err("Expected an absolute X3F path".into());
    }
    Ok(())
}

pub fn source_path(path: &Path) -> Result<(), String> {
    validate_source_path(path)?;
    if !std::fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .is_file()
    {
        return Err("Input is not a file".into());
    }
    Ok(())
}

pub fn auto_concurrency() -> usize {
    (std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        / 2)
    .clamp(1, 4)
}

pub fn concurrency(setting: u8) -> usize {
    if let Some(n) = std::env::var("X3FUSE_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
    {
        return n;
    }
    if setting == 0 {
        auto_concurrency()
    } else {
        setting.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_names_and_wire_defaults_match_frontend() {
        let input = std::env::temp_dir().join("Photo.X3F");
        let mut settings = BatchSettings::default();
        for (format, name) in [
            (OutputFormat::Dng, "Photo.dng"),
            (OutputFormat::Tiff, "Photo.X3F.tif"),
            (OutputFormat::Jpeg, "Photo.X3F.jpg"),
        ] {
            settings.output_format = format;
            assert_eq!(
                settings.output_path(&input).unwrap().file_name().unwrap(),
                name
            );
        }
        let wire = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(wire["outputFormat"], "dng");
        assert_eq!(wire["colorProfile"], "sRGB");
        assert_eq!(wire["inspectorScopeMode"], "rgbParade");
        assert!(wire.get("batch").is_none());
        assert!(serde_json::from_value::<Settings>(wire)
            .unwrap()
            .validate()
            .is_ok());
        settings.denoise_intensity = 11;
        assert!(settings.validate().is_err());
    }
}
