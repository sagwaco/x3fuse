//! Source capabilities and DNG metadata shared by import, editing, and export.
use crate::{cache::Store, edits::SourceStamp, model::BatchSettings};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub kind: Kind,
    pub capabilities: Capabilities,
    pub crop: Option<[f32; 4]>,
    pub orientation: Option<u8>,
    pub iso: Option<f32>,
}

static STORE: OnceLock<Arc<Store>> = OnceLock::new();

/// Sets the disk store for DNG metadata. App setup calls it once.
pub fn use_store(store: Arc<Store>) {
    let _ = STORE.set(store);
}

/// The DNG metadata entry in the preview cache. It repeats its key, so that a
/// read can reject an entry for another file, stamp or decoder.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Persisted {
    path: PathBuf,
    stamp: SourceStamp,
    decoder: String,
    info: Info,
}

impl Persisted {
    fn parse(bytes: &[u8], path: &Path, stamp: &SourceStamp) -> Option<Info> {
        let entry: Self = serde_json::from_slice(bytes).ok()?;
        (entry.path == path
            && entry.stamp == *stamp
            && entry.decoder == decoder_identity(path)
            && entry.info.valid_dng())
        .then_some(entry.info)
    }
}

/// DNG metadata of this session, by canonical path. It removes the oldest
/// insertion first. The disk store keeps the metadata that it removes.
#[derive(Default)]
struct Memory {
    entries: HashMap<PathBuf, (SourceStamp, u64, Info)>,
    order: VecDeque<PathBuf>,
    bytes: usize,
}

impl Memory {
    const LIMIT: usize = 16 * 1024 * 1024;

    fn lock(memory: &Mutex<Self>) -> Result<MutexGuard<'_, Self>, String> {
        memory
            .lock()
            .map_err(|_| "DNG metadata cache unavailable".into())
    }

    fn cost(path: &Path) -> usize {
        // The path is in `entries` and `order`; the rest is a fixed size.
        2 * path.as_os_str().len() + 192
    }

    fn get(&self, path: &Path, stamp: &SourceStamp, generation: u64) -> Option<Info> {
        let (s, g, info) = self.entries.get(path)?;
        (s == stamp && *g == generation).then_some(*info)
    }

    fn put(&mut self, path: PathBuf, stamp: SourceStamp, generation: u64, info: Info) {
        if let Some(entry) = self.entries.get_mut(&path) {
            *entry = (stamp, generation, info);
            return;
        }
        self.bytes += Self::cost(&path);
        self.order.push_back(path.clone());
        self.entries.insert(path, (stamp, generation, info));
        while self.bytes > Self::LIMIT {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.bytes -= Self::cost(&oldest);
            self.entries.remove(&oldest);
        }
    }
}

static MEMORY: OnceLock<Mutex<Memory>> = OnceLock::new();

impl Info {
    pub fn read(path: &Path, cancel: &AtomicBool) -> Result<Self, String> {
        Self::read_in(
            path,
            cancel,
            STORE.get().map(AsRef::as_ref),
            Some(MEMORY.get_or_init(Default::default)),
            inspect,
        )
    }

    /// Reads with `store` and without the session memory, for isolated contexts.
    pub fn read_with(
        path: &Path,
        cancel: &AtomicBool,
        store: Option<&Store>,
    ) -> Result<Self, String> {
        Self::read_in(path, cancel, store, None, inspect)
    }

    fn read_in(
        path: &Path,
        cancel: &AtomicBool,
        store: Option<&Store>,
        memory: Option<&Mutex<Memory>>,
        inspect: impl FnOnce(&Path, &AtomicBool) -> Result<Self, String>,
    ) -> Result<Self, String> {
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
        // Capture the generation first. A Clear or Disable after this point
        // makes the store reject the entry and the memory miss it.
        let generation = store.map_or(0, Store::generation);
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let stamp = SourceStamp::new(&fs::metadata(&path).map_err(|e| e.to_string())?)?;
        if let Some(memory) = memory {
            if let Some(info) = Memory::lock(memory)?.get(&path, &stamp, generation) {
                return Ok(info);
            }
        }
        let name = store.and_then(|_| crate::cache::source_key(&path).map(|k| k + ".info.json"));
        let persisted = store.zip(name.as_deref()).and_then(|(store, name)| {
            let bytes = store.get(name, &[], |b| Persisted::parse(b, &path, &stamp).is_some())?;
            Persisted::parse(&bytes, &path, &stamp)
        });
        let info = match persisted {
            Some(info) => info,
            None => {
                let info = inspect(&path, cancel)?;
                if SourceStamp::new(&fs::metadata(&path).map_err(|e| e.to_string())?)? != stamp {
                    return Err(
                        "Source changed while reading DNG metadata; reopen the photo".into(),
                    );
                }
                if let Some((store, name)) = store.zip(name.as_deref()).filter(|_| info.valid_dng())
                {
                    let entry = Persisted {
                        path: path.clone(),
                        stamp: stamp.clone(),
                        decoder: decoder_identity(&path).into(),
                        info,
                    };
                    if let Ok(bytes) = serde_json::to_vec(&entry) {
                        store.put(generation, name, &bytes);
                    }
                }
                info
            }
        };
        if let Some(memory) = memory {
            Memory::lock(memory)?.put(path, stamp, generation, info);
        }
        Ok(info)
    }

    /// Metadata that `inspect` can give: orientation 1 to 8, a positive ISO,
    /// and a normalized crop in the image.
    fn valid_dng(self) -> bool {
        let crop = self.crop.is_none_or(|[x, y, w, h]| {
            [x, y, w, h].iter().all(|v| v.is_finite())
                && x >= 0.
                && y >= 0.
                && w > 0.
                && h > 0.
                && x + w <= 1.0001
                && y + h <= 1.0001
        });
        self.kind == Kind::Dng
            && self.capabilities
                == Capabilities {
                    bayer: self.capabilities.bayer,
                    ..Capabilities::for_kind(Kind::Dng, !self.capabilities.white_balance)
                }
            && self.orientation.is_some_and(|o| (1..=8).contains(&o))
            && self.iso.is_none_or(|iso| iso.is_finite() && iso > 0.)
            && crop
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

fn inspect(path: &Path, cancel: &AtomicBool) -> Result<Info, String> {
    let dng = x3f_dng::inspect(path, cancel)?;
    Ok(Info {
        kind: Kind::Dng,
        capabilities: Capabilities {
            bayer: dng.bayer,
            ..Capabilities::for_kind(Kind::Dng, dng.monochrome)
        },
        crop: dng.as_shot_crop,
        orientation: Some(dng.orientation as u8),
        iso: dng.iso,
    })
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

    fn fake() -> Info {
        Info {
            kind: Kind::Dng,
            capabilities: Capabilities {
                bayer: true,
                ..Capabilities::for_kind(Kind::Dng, false)
            },
            crop: Some([0.1, 0.1, 0.8, 0.8]),
            orientation: Some(6),
            iso: Some(200.),
        }
    }

    fn store(root: &Path, enabled: bool) -> Store {
        let logs = Arc::new(crate::storage::Logs::new(root.join("logs")));
        Store::new(
            root.join("cache"),
            vec![],
            enabled,
            crate::cache::DEFAULT_LIMIT,
            logs,
        )
    }

    /// Reads with `store` and fresh session memory. Returns the inspections.
    fn read(path: &Path, store: Option<&Store>, memory: &Mutex<Memory>) -> (Info, usize) {
        let mut calls = 0;
        let info = Info::read_in(
            path,
            &AtomicBool::new(false),
            store,
            Some(memory),
            |_, _| {
                calls += 1;
                Ok(fake())
            },
        )
        .unwrap();
        (info, calls)
    }

    fn entry(root: &Path, path: &Path) -> PathBuf {
        let name = crate::cache::source_key(path).unwrap() + ".info.json";
        root.join("cache").join(&name[..2]).join(name)
    }

    #[test]
    fn persisted_metadata_skips_inspection_in_a_new_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"not a real DNG").unwrap();
        let first = store(dir.path(), true);
        assert_eq!(read(&path, Some(&first), &Default::default()), (fake(), 1));
        assert!(entry(dir.path(), &path).is_file());
        // The store fills the session memory, which then answers alone.
        let memory = Mutex::default();
        assert_eq!(read(&path, Some(&first), &memory), (fake(), 0));
        assert_eq!(read(&path, None, &memory), (fake(), 0));
        drop(first);
        // A restart: another store and memory on the same directory.
        let reopened = store(dir.path(), true);
        assert_eq!(
            read(&path, Some(&reopened), &Default::default()),
            (fake(), 0)
        );
        // Without a store, metadata is for this session only.
        assert_eq!(read(&path, None, &Default::default()), (fake(), 1));
        assert_eq!(fs::read(&path).unwrap(), b"not a real DNG");
    }

    #[test]
    fn mismatched_corrupt_or_invalid_entries_miss_and_are_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"not a real DNG").unwrap();
        let canonical = path.canonicalize().unwrap();
        let store = store(dir.path(), true);
        assert_eq!(read(&path, Some(&store), &Default::default()).1, 1);
        let file = entry(dir.path(), &path);
        let valid = fs::read(&file).unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&canonical).unwrap()).unwrap();
        let persisted = |path: &Path, stamp: &SourceStamp, decoder: &str, info: Info| {
            serde_json::to_vec(&Persisted {
                path: path.into(),
                stamp: stamp.clone(),
                decoder: decoder.into(),
                info,
            })
            .unwrap()
        };
        let decoder = decoder_identity(&canonical);
        let other_file = dir.path().join("other.dng");
        fs::write(&other_file, b"another file with another size").unwrap();
        let other = SourceStamp::new(&fs::metadata(&other_file).unwrap()).unwrap();
        let mut tampered = vec![
            b"{incomplete".to_vec(),
            b"[]".to_vec(),
            persisted(&canonical, &other, decoder, fake()),
            persisted(&other_file.canonicalize().unwrap(), &stamp, decoder, fake()),
            persisted(&canonical, &stamp, "older decoder", fake()),
        ];
        for info in [
            Info {
                orientation: Some(9),
                ..fake()
            },
            Info {
                kind: Kind::X3f,
                ..fake()
            },
            Info {
                iso: Some(-100.),
                ..fake()
            },
            Info {
                crop: Some([0.5, 0., 0.6, 1.]),
                ..fake()
            },
            Info {
                capabilities: Capabilities::for_kind(Kind::X3f, false),
                ..fake()
            },
        ] {
            tampered.push(persisted(&canonical, &stamp, decoder, info));
        }
        let mut with_field = serde_json::from_slice::<serde_json::Value>(&valid).unwrap();
        with_field["extra"] = true.into();
        tampered.push(serde_json::to_vec(&with_field).unwrap());
        for bytes in tampered {
            fs::write(&file, &bytes).unwrap();
            assert_eq!(read(&path, Some(&store), &Default::default()), (fake(), 1));
            assert_eq!(fs::read(&file).unwrap(), valid);
        }
    }

    #[test]
    fn a_replaced_source_is_inspected_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"first").unwrap();
        let store = store(dir.path(), true);
        let memory = Mutex::default();
        assert_eq!(read(&path, Some(&store), &memory).1, 1);
        // Same size, by rename: Unix sees another inode, every platform
        // sees other times.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let replacement = dir.path().join("replacement.dng");
        fs::write(&replacement, b"later").unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(read(&path, Some(&store), &memory).1, 1);
        assert_eq!(read(&path, Some(&store), &Default::default()).1, 0);
    }

    #[test]
    fn clear_during_inspection_cannot_store_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"not a real DNG").unwrap();
        let store = store(dir.path(), true);
        let memory = Mutex::default();
        let info = Info::read_in(
            &path,
            &AtomicBool::new(false),
            Some(&store),
            Some(&memory),
            |_, _| {
                store.clear().unwrap();
                Ok(fake())
            },
        )
        .unwrap();
        assert_eq!(info, fake());
        assert!(!entry(dir.path(), &path).exists());
        assert_eq!(read(&path, Some(&store), &memory).1, 1);
        // A Clear after a read also makes the session memory miss.
        assert_eq!(read(&path, Some(&store), &memory).1, 0);
        store.clear().unwrap();
        assert_eq!(read(&path, Some(&store), &memory).1, 1);
    }

    #[test]
    fn a_disabled_store_keeps_no_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"not a real DNG").unwrap();
        let disabled = store(dir.path(), false);
        let memory = Mutex::default();
        assert_eq!(read(&path, Some(&disabled), &memory).1, 1);
        assert_eq!(read(&path, Some(&disabled), &memory).1, 0);
        assert_eq!(read(&path, Some(&disabled), &Default::default()).1, 1);
        assert!(!entry(dir.path(), &path).exists());
        disabled.configure(true, crate::cache::DEFAULT_LIMIT);
        assert_eq!(read(&path, Some(&disabled), &Default::default()).1, 1);
        assert!(entry(dir.path(), &path).is_file());
    }

    #[test]
    fn non_dng_and_cancelled_reads_do_not_inspect() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path(), true);
        let x3f = dir.path().join("photo.X3F");
        fs::write(&x3f, b"RAW").unwrap();
        let (info, calls) = read(&x3f, Some(&store), &Default::default());
        assert_eq!((info.kind, info.orientation, calls), (Kind::X3f, None, 0));
        let dng = dir.path().join("photo.dng");
        fs::write(&dng, b"not a real DNG").unwrap();
        let cancelled = Info::read_in(
            &dng,
            &AtomicBool::new(true),
            Some(&store),
            None,
            |_, _| unreachable!(),
        );
        assert!(cancelled.is_err());
        let failed = Info::read_in(&dng, &AtomicBool::new(false), Some(&store), None, |_, _| {
            Err("not a DNG".into())
        });
        assert_eq!(failed, Err(String::from("not a DNG")));
        assert!(!entry(dir.path(), &dng).exists());
    }

    #[test]
    fn session_memory_holds_more_than_1024_sources_within_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.dng");
        fs::write(&path, b"DNG").unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&path).unwrap()).unwrap();
        let mut memory = Memory::default();
        let name = |n: usize| dir.path().join(format!("{n}.dng"));
        for n in 0..5000 {
            memory.put(name(n), stamp.clone(), 0, fake());
        }
        assert!((0..5000).all(|n| memory.get(&name(n), &stamp, 0) == Some(fake())));
        assert!(memory.get(&name(0), &stamp, 1).is_none());
        let long = |n: usize| dir.path().join(format!("{n}-{}.dng", "long".repeat(1000)));
        for n in 0..5000 {
            memory.put(long(n), stamp.clone(), 0, fake());
        }
        assert!(memory.bytes <= Memory::LIMIT);
        assert_eq!(memory.entries.len(), memory.order.len());
        assert!(memory.get(&name(0), &stamp, 0).is_none());
        assert!(memory.get(&long(4999), &stamp, 0).is_some());
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
