use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum OutputFormat {
    #[serde(rename = "dng")]
    Dng,
    #[serde(rename = "embeddedJpg")]
    Jpeg,
    #[serde(rename = "jpeg")]
    RenderedJpeg,
    #[serde(rename = "tiff")]
    Tiff,
}

impl OutputFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Dng => "dng",
            Self::Jpeg | Self::RenderedJpeg => "jpg",
            Self::Tiff => "tif",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Rendering {
    #[default]
    Original,
    Rendered,
}

fn default_jpeg_quality() -> u8 {
    92
}
fn default_editor_width() -> u16 {
    320
}
fn default_true() -> bool {
    true
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
    #[serde(default)]
    pub rendering: Rendering,
    #[serde(default = "default_jpeg_quality")]
    pub jpeg_quality: u8,
    pub compress: bool,
    pub denoise_intensity: u8,
    #[serde(default)]
    pub denoise_options: x3f_core::DenoiseOptions,
    pub color_profile: ColorProfile,
    pub dng_highlight_recovery: bool,
    pub cineon: bool,
    /// Sigma Color Mode name, such as "as-shot" or "Vivid", for TIFF.
    /// None keeps the TIFF without a Color Mode. DNG always embeds every mode.
    #[serde(default)]
    pub color_mode: Option<String>,
    /// The frames of an X3I for an original export. Embedded JPG always uses
    /// the middle exposure. Rendered exports use the frames of the recipe.
    #[serde(default)]
    pub x3i_source: x3f_core::X3iSource,
    pub output_directory: Option<PathBuf>,
    pub concurrency: u8,
}

impl Default for BatchSettings {
    fn default() -> Self {
        Self {
            output_format: OutputFormat::Dng,
            rendering: Rendering::Original,
            jpeg_quality: default_jpeg_quality(),
            compress: false,
            denoise_intensity: 10,
            denoise_options: x3f_core::DenoiseOptions::default(),
            color_profile: ColorProfile::Srgb,
            dng_highlight_recovery: false,
            cineon: false,
            color_mode: None,
            x3i_source: x3f_core::X3iSource::Merge,
            output_directory: None,
            concurrency: 0,
        }
    }
}

impl BatchSettings {
    pub fn is_rendered(&self) -> bool {
        self.output_format == OutputFormat::RenderedJpeg || self.rendering == Rendering::Rendered
    }

    pub fn validate(&self) -> Result<(), String> {
        self.denoise_options.validate()?;
        if self.denoise_intensity > 10
            || self.concurrency > 8
            || !(1..=100).contains(&self.jpeg_quality)
            || self
                .color_mode
                .as_deref()
                .is_some_and(|mode| mode.parse::<x3f_core::ColorMode>().is_err())
        {
            return Err("Invalid export setting".into());
        }
        if self.is_rendered()
            && (!matches!(
                self.output_format,
                OutputFormat::RenderedJpeg | OutputFormat::Tiff
            ) || self.color_profile == ColorProfile::None
                || self.cineon)
        {
            return Err(
                "Edited export requires JPEG or TIFF with a color profile and without Cineon"
                    .into(),
            );
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
    pub inspector_width: u16,
    pub export_panel_width: u16,
    #[serde(default = "default_editor_width")]
    pub editor_panel_width: u16,
    #[serde(default = "default_true")]
    pub editor_panel_open: bool,
    pub list_column_widths: ListColumnWidths,
    pub inspector_scope_mode: String,
    pub last_import_directory: Option<PathBuf>,
    #[serde(default = "default_appearance_mode")]
    pub appearance_mode: String,
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,
    /// The disk cache of embedded previews and import metadata.
    #[serde(default = "default_true")]
    pub preview_cache_enabled: bool,
    /// The size limit of the preview cache in bytes.
    #[serde(default = "default_preview_cache_limit")]
    pub preview_cache_limit: u64,
}

/// Decimal units, as the Settings window shows sizes.
const PREVIEW_CACHE_LIMITS: std::ops::RangeInclusive<u64> = 100_000_000..=1_000_000_000_000;

fn default_preview_cache_limit() -> u64 {
    1_000_000_000
}

fn default_appearance_mode() -> String {
    "auto".into()
}

fn default_light_theme() -> String {
    "light".into()
}

fn default_dark_theme() -> String {
    "dark".into()
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
            inspector_width: 300,
            export_panel_width: 380,
            editor_panel_width: default_editor_width(),
            editor_panel_open: true,
            list_column_widths: ListColumnWidths {
                name: 0,
                date: 220,
                size: 110,
            },
            inspector_scope_mode: "rgbParade".into(),
            last_import_directory: None,
            appearance_mode: default_appearance_mode(),
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
            preview_cache_enabled: true,
            preview_cache_limit: default_preview_cache_limit(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        self.batch.validate()?;
        let widths = &self.list_column_widths;
        if !(220..=800).contains(&self.inspector_width)
            || !(300..=800).contains(&self.export_panel_width)
            || !(280..=800).contains(&self.editor_panel_width)
            || (widths.name != 0 && !(180..=2000).contains(&widths.name))
            || !(80..=1000).contains(&widths.date)
            || !(64..=400).contains(&widths.size)
        {
            return Err("Invalid layout width".into());
        }
        if !["File Name", "Date", "Size"].contains(&self.sort_field.as_str())
            || !["list", "grid", "filmstrip", "survey"].contains(&self.queue_view_mode.as_str())
            || !["auto", "light", "dark"].contains(&self.appearance_mode.as_str())
            || !["dark", "light", "gray"].contains(&self.light_theme.as_str())
            || !["dark", "light", "gray"].contains(&self.dark_theme.as_str())
            || !["histogram", "rgbParade", "waveform", "vectorscope"]
                .contains(&self.inspector_scope_mode.as_str())
            || self
                .last_import_directory
                .as_ref()
                .is_some_and(|p| !p.is_absolute())
            || !PREVIEW_CACHE_LIMITS.contains(&self.preview_cache_limit)
        {
            return Err("Invalid application setting".into());
        }
        Ok(())
    }

    /// Returns the pinned appearance (None follows the system), the theme that
    /// applies, and its surface color.
    pub fn window_theme(
        &self,
        system_dark: bool,
    ) -> (Option<tauri::Theme>, &str, tauri::window::Color) {
        let (pinned, dark) = match self.appearance_mode.as_str() {
            "light" => (Some(tauri::Theme::Light), false),
            "dark" => (Some(tauri::Theme::Dark), true),
            _ => (None, system_dark),
        };
        let theme = if dark {
            self.dark_theme.as_str()
        } else {
            self.light_theme.as_str()
        };
        let value = match theme {
            "light" => 250,
            "gray" => 133,
            _ => 10,
        };
        (
            pinned,
            theme,
            tauri::window::Color(value, value, value, 255),
        )
    }
}

/// Script that sets the theme attribute before the first style pass, so the
/// page paints in its theme without a dark frame.
pub fn theme_script(theme: &str) -> String {
    let name = serde_json::to_string(theme).unwrap_or_else(|_| "\"dark\"".into());
    format!(
        "(function () {{ var theme = {name}; var root = document.documentElement; \
         if (root) root.dataset.theme = theme; \
         else document.addEventListener('DOMContentLoaded', function () {{ \
         document.documentElement.dataset.theme = theme; }}); }})()"
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ListColumnWidths {
    pub name: u16,
    pub date: u16,
    pub size: u16,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertFile {
    pub id: String,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<BatchSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe: Option<x3f_render::EditRecipe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

impl ConvertFile {
    pub fn effective_settings<'a>(&'a self, fallback: &'a BatchSettings) -> &'a BatchSettings {
        self.settings.as_ref().unwrap_or(fallback)
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exif: Option<Vec<ExifPair>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit: Option<crate::editor::EditRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_error: Option<String>,
    /// The number of frames in an X3I (Super Fine Detail) photo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<u32>,
    #[serde(flatten)]
    pub cull: crate::culling::Cull,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExifPair {
    pub label: String,
    pub value: String,
}

pub fn validate_source_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.extension().is_some_and(is_source_extension) {
        return Err("Expected an absolute X3F or X3I path".into());
    }
    Ok(())
}

/// X3F photos and Quattro SFD X3I containers.
pub fn is_source_extension(extension: &std::ffi::OsStr) -> bool {
    extension.eq_ignore_ascii_case("x3f") || extension.eq_ignore_ascii_case("x3i")
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
    fn per_file_settings_are_optional_and_use_camel_case() {
        let mut file: ConvertFile = serde_json::from_value(serde_json::json!({
            "id": "photo",
            "path": "photo.X3F"
        }))
        .unwrap();
        let fallback = BatchSettings::default();
        assert!(std::ptr::eq(file.effective_settings(&fallback), &fallback));
        assert!(serde_json::to_value(&file)
            .unwrap()
            .get("settings")
            .is_none());
        file.settings = Some(BatchSettings {
            output_format: OutputFormat::Tiff,
            ..Default::default()
        });
        let wire = serde_json::to_value(&file).unwrap();
        assert_eq!(wire["settings"]["outputFormat"], "tiff");
        let restored: ConvertFile = serde_json::from_value(wire).unwrap();
        assert_eq!(
            restored.effective_settings(&fallback).output_format,
            OutputFormat::Tiff
        );
    }

    #[test]
    fn appearance_settings_migrate_and_validate() {
        let mut wire = serde_json::to_value(Settings::default()).unwrap();
        let fields = wire.as_object_mut().unwrap();
        fields.remove("appearanceMode");
        fields.remove("lightTheme");
        fields.remove("darkTheme");
        let mut settings: Settings = serde_json::from_value(wire).unwrap();
        assert_eq!(settings.appearance_mode, "auto");
        assert_eq!(settings.light_theme, "light");
        assert_eq!(settings.dark_theme, "dark");
        assert!(settings.validate().is_ok());
        settings.light_theme = "neon".into();
        assert!(settings.validate().is_err());
        settings.light_theme = "light".into();
        settings.dark_theme = "neon".into();
        assert!(settings.validate().is_err());
        settings.dark_theme = "dark".into();
        settings.appearance_mode = "night".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn preview_cache_settings_migrate_and_validate() {
        let mut wire = serde_json::to_value(Settings::default()).unwrap();
        let fields = wire.as_object_mut().unwrap();
        fields.remove("previewCacheEnabled");
        fields.remove("previewCacheLimit");
        let mut settings: Settings = serde_json::from_value(wire).unwrap();
        assert!(settings.preview_cache_enabled);
        assert_eq!(settings.preview_cache_limit, 1_000_000_000);
        assert!(settings.validate().is_ok());
        for limit in [0, 99_999_999, 1_000_000_000_001] {
            settings.preview_cache_limit = limit;
            assert!(settings.validate().is_err());
        }
    }

    #[test]
    fn window_theme_follows_or_pins_appearance() {
        let gray = tauri::window::Color(133, 133, 133, 255);
        let light = tauri::window::Color(250, 250, 250, 255);
        let mut settings = Settings {
            dark_theme: "gray".into(),
            ..Settings::default()
        };
        assert_eq!(settings.window_theme(true), (None, "gray", gray));
        assert_eq!(settings.window_theme(false), (None, "light", light));
        settings.appearance_mode = "light".into();
        assert_eq!(
            settings.window_theme(true),
            (Some(tauri::Theme::Light), "light", light)
        );
        settings.appearance_mode = "dark".into();
        assert_eq!(
            settings.window_theme(false),
            (Some(tauri::Theme::Dark), "gray", gray)
        );
        settings.dark_theme = "dark".into();
        assert_eq!(
            settings.window_theme(false).2,
            tauri::window::Color(10, 10, 10, 255)
        );
        assert!(theme_script("gray").contains("var theme = \"gray\";"));
    }

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

    #[test]
    fn denoise_options_migrate_and_validate_at_the_api_boundary() {
        let mut wire = serde_json::to_value(BatchSettings::default()).unwrap();
        wire.as_object_mut().unwrap().remove("denoiseOptions");
        let mut settings: BatchSettings = serde_json::from_value(wire).unwrap();
        assert_eq!(
            settings.denoise_options,
            x3f_core::DenoiseOptions::default()
        );
        settings.denoise_options.algorithm = x3f_core::DenoiseAlgorithm::Bm3d;
        settings.denoise_options.luminance = true;
        settings.denoise_options.chroma = false;
        let options = crate::conversion::process_options(&settings, PathBuf::new());
        assert_eq!(options.denoise_options, settings.denoise_options);
        let recipe: x3f_render::EditRecipe = serde_json::from_str("{}").unwrap();
        assert_eq!(recipe.denoise_options, x3f_core::DenoiseOptions::default());
        let mut wire = serde_json::to_value(settings).unwrap();
        assert_eq!(wire["denoiseOptions"]["algorithm"], "bm3d");
        wire["denoiseOptions"]["nlm"]["chromaPatch"] = serde_json::json!(4);
        assert!(serde_json::from_value::<BatchSettings>(wire.clone())
            .unwrap()
            .validate()
            .is_err());
        wire["denoiseOptions"]["algorithm"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<BatchSettings>(wire).is_err());
    }
}
