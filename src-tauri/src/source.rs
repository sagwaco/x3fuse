//! Source capabilities and DNG metadata shared by import, editing, and export.
use crate::{edits::SourceStamp, model::BatchSettings};
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    X3f,
    X3i,
    Dng,
}

impl Kind {
    pub fn of(path: &Path) -> Self {
        match path.extension() {
            Some(ext) if ext.eq_ignore_ascii_case("dng") => Self::Dng,
            Some(ext) if ext.eq_ignore_ascii_case("x3i") => Self::X3i,
            _ => Self::X3f,
        }
    }

    pub fn validate_export(self, settings: &BatchSettings) -> Result<(), String> {
        settings.validate()?;
        if self == Self::Dng && !settings.is_rendered() {
            return Err("DNG inputs support edited JPEG or TIFF export only".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub foveon: bool,
    pub white_balance: bool,
    pub rendered_only: bool,
    pub bayer: bool,
}

impl Capabilities {
    pub fn for_kind(kind: Kind, monochrome: bool) -> Self {
        Self {
            foveon: kind != Kind::Dng,
            white_balance: !monochrome,
            rendered_only: kind == Kind::Dng,
            bayer: false,
        }
    }
}

/// The lowest ISO at which `DngDemosaic::Default` uses LMMSE.
pub const HIGH_ISO: f32 = 1600.;

#[derive(Clone, Copy)]
pub struct Info {
    pub kind: Kind,
    pub capabilities: Capabilities,
    pub crop: Option<[f32; 4]>,
    pub orientation: Option<u8>,
    pub iso: Option<f32>,
}

type MetadataCache = VecDeque<(PathBuf, SourceStamp, Info)>;

impl Info {
    pub fn read(path: &Path, cancel: &AtomicBool) -> Result<Self, String> {
        if cancel.load(Ordering::Relaxed) {
            return Err("RAW preparation cancelled".into());
        }
        let kind = Kind::of(path);
        if kind != Kind::Dng {
            return Ok(Self {
                kind,
                capabilities: Capabilities::for_kind(kind, false),
                crop: None,
                orientation: None,
                iso: None,
            });
        }
        static CACHE: OnceLock<Mutex<MetadataCache>> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let stamp = SourceStamp::new(&fs::metadata(&path).map_err(|e| e.to_string())?)?;
        {
            let mut entries = cache.lock().map_err(|_| "DNG metadata cache unavailable")?;
            if let Some(at) = entries
                .iter()
                .position(|(p, s, _)| p == &path && s == &stamp)
            {
                let entry = entries.remove(at).unwrap();
                let info = entry.2;
                entries.push_back(entry);
                return Ok(info);
            }
        }
        let dng = x3f_dng::inspect(&path, cancel)?;
        if SourceStamp::new(&fs::metadata(&path).map_err(|e| e.to_string())?)? != stamp {
            return Err("Source changed while reading DNG metadata; reopen the photo".into());
        }
        let info = Self {
            kind,
            capabilities: Capabilities {
                bayer: dng.bayer,
                ..Capabilities::for_kind(kind, dng.monochrome)
            },
            crop: dng.as_shot_crop,
            orientation: Some(dng.orientation as u8),
            iso: dng.iso,
        };
        let mut entries = cache.lock().map_err(|_| "DNG metadata cache unavailable")?;
        entries.retain(|(p, _, _)| p != &path);
        entries.push_back((path, stamp, info));
        while entries.len() > 1024 {
            entries.pop_front();
        }
        Ok(info)
    }

    /// A Bayer DNG takes every method; a monochrome DNG takes Default and Mono.
    pub fn supports_demosaic(self) -> bool {
        self.capabilities.bayer || (self.kind == Kind::Dng && !self.capabilities.white_balance)
    }

    /// The method to prepare with. Default becomes Mono for a monochrome DNG,
    /// LMMSE from `HIGH_ISO`, or AMaZE.
    pub fn resolve_demosaic(
        self,
        method: Option<x3f_render::DngDemosaic>,
    ) -> Option<x3f_render::DngDemosaic> {
        use x3f_render::DngDemosaic as D;
        match method {
            Some(D::Default) if !self.capabilities.white_balance => Some(D::Mono),
            Some(D::Default) if self.iso.is_some_and(|iso| iso >= HIGH_ISO) => Some(D::Lmmse),
            Some(D::Default) => Some(D::Amaze),
            method => method,
        }
    }

    pub fn validate_recipe(self, recipe: &x3f_render::EditRecipe) -> Result<(), String> {
        use x3f_render::DngDemosaic as D;
        match recipe.dng_demosaic {
            Some(_) if !self.supports_demosaic() => {
                return Err("Demosaicing methods require a Bayer or monochrome DNG input".into())
            }
            Some(method) if !self.capabilities.bayer && !matches!(method, D::Default | D::Mono) => {
                return Err("Monochrome DNG inputs support Default and Mono only".into())
            }
            _ => {}
        }
        if self.kind == Kind::Dng {
            recipe.validate_dng(!self.capabilities.white_balance)
        } else {
            recipe.validate()
        }
    }

    pub fn white_balance_available(self, recipe: &x3f_render::EditRecipe) -> bool {
        self.capabilities.white_balance
            && self.resolve_demosaic(recipe.dng_demosaic) != Some(x3f_render::DngDemosaic::Mono)
    }
}

pub fn validate_recipe(path: &Path, recipe: &x3f_render::EditRecipe) -> Result<(), String> {
    Info::read(path, &AtomicBool::new(false))?.validate_recipe(recipe)
}

pub fn decoder_identity(path: &Path) -> &'static str {
    if Kind::of(path) == Kind::Dng {
        x3f_dng::DECODER_VERSION
    } else {
        ""
    }
}

// Keep imported sources protected for this session, including photos removed from the view.
static IMPORTED: OnceLock<Mutex<Imported>> = OnceLock::new();

#[derive(Default)]
struct Imported {
    paths: HashSet<PathBuf>,
    #[cfg(unix)]
    identities: HashSet<(u64, u64)>,
}

pub fn remember(path: &Path) -> Result<(), String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let mut imported = IMPORTED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Source protection unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        imported.identities.insert((metadata.dev(), metadata.ino()));
    }
    imported.paths.insert(path);
    Ok(())
}

pub fn protect_output(
    output: &Path,
    inputs: impl IntoIterator<Item = PathBuf>,
) -> Result<(), String> {
    let target = match output.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let imported = IMPORTED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Source protection unavailable")?;
    let mut known = imported.paths.contains(&target) || crate::edits::sidecar(&target).exists();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
        known |= imported
            .identities
            .contains(&(metadata.dev(), metadata.ino()));
    }
    if known
        || inputs
            .into_iter()
            .any(|input| input.canonicalize().ok().as_ref() == Some(&target))
    {
        return Err(format!(
            "Cannot overwrite a source photo: {}",
            output.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{OutputFormat, Rendering};

    #[test]
    fn demosaic_requires_bayer_and_mono_disables_white_balance() {
        let mut source = Info {
            kind: Kind::Dng,
            capabilities: Capabilities::for_kind(Kind::Dng, false),
            crop: None,
            orientation: Some(1),
            iso: None,
        };
        let mut recipe = x3f_render::EditRecipe {
            film: None,
            denoise: 0,
            ..Default::default()
        };
        source.validate_recipe(&recipe).unwrap();
        recipe.dng_demosaic = Some(x3f_render::DngDemosaic::Amaze);
        assert!(source.validate_recipe(&recipe).is_err());
        source.capabilities.bayer = true;
        source.validate_recipe(&recipe).unwrap();
        assert!(source.white_balance_available(&recipe));
        recipe.dng_demosaic = Some(x3f_render::DngDemosaic::Mono);
        source.validate_recipe(&recipe).unwrap();
        assert!(!source.white_balance_available(&recipe));
        recipe.temperature = Some(5000.);
        assert!(source.validate_recipe(&recipe).is_err());
        source.kind = Kind::X3f;
        source.capabilities = Capabilities::for_kind(Kind::X3f, false);
        assert!(source.validate_recipe(&recipe).is_err());
    }

    #[test]
    fn default_demosaic_follows_sensor_and_iso() {
        use x3f_render::DngDemosaic as D;
        let mut source = Info {
            kind: Kind::Dng,
            capabilities: Capabilities {
                bayer: true,
                ..Capabilities::for_kind(Kind::Dng, false)
            },
            crop: None,
            orientation: Some(1),
            iso: None,
        };
        let resolve = |source: Info| source.resolve_demosaic(Some(D::Default));
        // Missing ISO, from LibRaw zero or a non-finite value, is normal ISO.
        assert_eq!(resolve(source), Some(D::Amaze));
        source.iso = Some(HIGH_ISO.next_down());
        assert_eq!(resolve(source), Some(D::Amaze));
        source.iso = Some(HIGH_ISO);
        assert_eq!(resolve(source), Some(D::Lmmse));
        assert_eq!(source.resolve_demosaic(None), None);
        assert_eq!(source.resolve_demosaic(Some(D::Fast)), Some(D::Fast));
        let mut recipe = x3f_render::EditRecipe {
            film: None,
            denoise: 0,
            dng_demosaic: Some(D::Default),
            ..Default::default()
        };
        assert!(source.white_balance_available(&recipe));

        source.capabilities = Capabilities::for_kind(Kind::Dng, true);
        assert!(source.supports_demosaic());
        assert_eq!(resolve(source), Some(D::Mono));
        assert!(!source.white_balance_available(&recipe));
        for method in [None, Some(D::Default), Some(D::Mono)] {
            recipe.dng_demosaic = method;
            source.validate_recipe(&recipe).unwrap();
        }
        recipe.dng_demosaic = Some(D::Amaze);
        assert!(source.validate_recipe(&recipe).is_err());

        source.capabilities = Capabilities::for_kind(Kind::Dng, false);
        assert!(!source.supports_demosaic());
        source.kind = Kind::X3f;
        assert!(!source.supports_demosaic());
        for method in [Some(D::Default), Some(D::Mono)] {
            recipe.dng_demosaic = method;
            assert!(source.validate_recipe(&recipe).is_err());
        }
    }

    #[test]
    fn dng_export_requires_rendered_pixels() {
        let mut settings = BatchSettings::default();
        for format in [OutputFormat::Dng, OutputFormat::Jpeg, OutputFormat::Tiff] {
            settings.output_format = format;
            assert!(Kind::Dng.validate_export(&settings).is_err());
        }
        settings.rendering = Rendering::Rendered;
        for format in [OutputFormat::RenderedJpeg, OutputFormat::Tiff] {
            settings.output_format = format;
            assert!(Kind::Dng.validate_export(&settings).is_ok());
        }
    }

    #[test]
    fn imported_sources_are_never_replaceable_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.dng");
        let generated = dir.path().join("previous.dng");
        fs::write(&source, b"source").unwrap();
        fs::write(&generated, b"generated").unwrap();
        assert!(protect_output(&source, [source.clone()]).is_err());
        remember(&source).unwrap();
        assert!(protect_output(&source, []).is_err());
        assert!(protect_output(&generated, []).is_ok());
        fs::write(crate::edits::sidecar(&generated), b"saved edits").unwrap();
        assert!(protect_output(&generated, []).is_err());
        let alias = dir.path().join("alias.dng");
        fs::hard_link(&source, &alias).unwrap();
        #[cfg(unix)]
        assert!(protect_output(&alias, []).is_err());
        let case_alias = dir.path().join("PHOTO.DNG");
        if case_alias.exists() {
            assert!(protect_output(&case_alias, []).is_err());
        }
        assert_eq!(fs::read(source).unwrap(), b"source");
    }
}
