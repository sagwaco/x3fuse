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

#[derive(Clone, Copy)]
pub struct Info {
    pub kind: Kind,
    pub capabilities: Capabilities,
    pub crop: Option<[f32; 4]>,
    pub orientation: Option<u8>,
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
        };
        let mut entries = cache.lock().map_err(|_| "DNG metadata cache unavailable")?;
        entries.retain(|(p, _, _)| p != &path);
        entries.push_back((path, stamp, info));
        while entries.len() > 1024 {
            entries.pop_front();
        }
        Ok(info)
    }

    pub fn validate_recipe(self, recipe: &x3f_render::EditRecipe) -> Result<(), String> {
        if recipe.dng_demosaic.is_some() && !self.capabilities.bayer {
            return Err("Demosaicing methods require a Bayer DNG input".into());
        }
        if self.kind == Kind::Dng {
            recipe.validate_dng(!self.capabilities.white_balance)
        } else {
            recipe.validate()
        }
    }

    pub fn white_balance_available(self, recipe: &x3f_render::EditRecipe) -> bool {
        self.capabilities.white_balance
            && recipe.dng_demosaic != Some(x3f_render::DngDemosaic::Mono)
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
