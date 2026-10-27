//! Non-destructive recipes. Originals are opened read-only; failed writes stay pending.
use crate::{
    cache::Store,
    model::source_path,
    storage::{read_json_bounded, write_bytes_atomic, write_json_atomic},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use x3f_render::EditRecipe;

const FINGERPRINTS_FILE: &str = "fingerprints-v2.json";
/// The most entries in `FINGERPRINTS_FILE`. The preview cache keeps the others.
const FINGERPRINT_LIMIT: usize = 1024;
/// The most fingerprints in memory, about 300 bytes each.
const FINGERPRINT_MEMORY_LIMIT: usize = 16 * 1024;
const JSON_LIMIT: usize = 1024 * 1024;
/// Version 2 documents were saved after photos opened with their camera
/// defaults. Version 1 documents can hold an untouched photo's old defaults.
const DOCUMENT_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRecord {
    pub recipe: EditRecipe,
    pub revision: u64,
    pub source_revision: String,
    pub storage: String,
    pub storage_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    /// False when the recipe is the photo's defaults, as after Reset or Undo.
    pub edited: bool,
    /// Saved before camera defaults (document version 1).
    #[serde(skip)]
    pub legacy: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    source_revision: String,
    revision: u64,
    updated_ms: u64,
    recipe: EditRecipe,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SourceStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    // Detect replacements and same-size writes that restore the old mtime.
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl SourceStamp {
    pub(crate) fn new(metadata: &fs::Metadata) -> Result<Self, String> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified().map_err(|e| e.to_string())?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }
}

type Fingerprint = (PathBuf, SourceStamp, String);

fn hash_valid(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

struct Remembered {
    stamp: SourceStamp,
    hash: String,
    tick: u64,
    /// The cache generation in which the preview cache stored this
    /// fingerprint. A Clear changes the generation and removes it.
    stored: Option<u64>,
}

/// Fingerprints by canonical path, least recently used out.
#[derive(Default)]
struct FingerprintCache {
    entries: HashMap<PathBuf, Remembered>,
    order: BTreeMap<u64, PathBuf>,
    tick: u64,
    dirty: bool,
}

impl FingerprintCache {
    fn get(&mut self, path: &Path, stamp: &SourceStamp) -> Option<String> {
        let entry = self.entries.get_mut(path).filter(|e| e.stamp == *stamp)?;
        self.tick += 1;
        let old = std::mem::replace(&mut entry.tick, self.tick);
        let hash = entry.hash.clone();
        let path = self.order.remove(&old)?;
        self.order.insert(self.tick, path);
        Some(hash)
    }

    /// Returns the removed fingerprints that the preview cache does not have
    /// in the `current` generation.
    fn put(
        &mut self,
        path: PathBuf,
        stamp: SourceStamp,
        hash: String,
        stored: Option<u64>,
        current: Option<u64>,
    ) -> Vec<Fingerprint> {
        self.tick += 1;
        let tick = self.tick;
        if let Some(old) = self.entries.insert(
            path.clone(),
            Remembered {
                stamp,
                hash,
                tick,
                stored,
            },
        ) {
            self.order.remove(&old.tick);
        }
        self.order.insert(tick, path);
        self.dirty = true;
        let mut evicted = vec![];
        while self.entries.len() > FINGERPRINT_MEMORY_LIMIT {
            let Some((_, path)) = self.order.pop_first() else {
                break;
            };
            if let Some(old) = self.entries.remove(&path).filter(|e| e.stored != current) {
                evicted.push((path, old.stamp, old.hash));
            }
        }
        evicted
    }

    /// The newest fingerprints, newest first.
    fn newest(&self, limit: usize) -> Vec<Fingerprint> {
        self.order
            .values()
            .rev()
            .take(limit)
            .map(|path| {
                let entry = &self.entries[path];
                (path.clone(), entry.stamp.clone(), entry.hash.clone())
            })
            .collect()
    }

    /// The fingerprints after the newest `skip` that the preview cache does
    /// not have in the `current` generation. A snapshot leaves them out, so the
    /// preview cache must keep them.
    fn unstored(&self, skip: usize, current: u64) -> Vec<Fingerprint> {
        self.order
            .values()
            .rev()
            .skip(skip)
            .filter_map(|path| {
                let entry = &self.entries[path];
                (entry.stored != Some(current))
                    .then(|| (path.clone(), entry.stamp.clone(), entry.hash.clone()))
            })
            .collect()
    }
}

fn fingerprint_snapshot(entries: &[Fingerprint]) -> Vec<u8> {
    // Newest first, as given. Bad paths/timestamps only omit their own entry;
    // long paths cannot make us publish a file the bounded reader rejects.
    let mut bytes = vec![b'['];
    for entry in entries {
        let Ok(json) = serde_json::to_vec(entry) else {
            continue;
        };
        if bytes.len() + json.len() + 2 > JSON_LIMIT {
            continue;
        }
        if bytes.len() > 1 {
            bytes.push(b',');
        }
        bytes.extend(json);
    }
    bytes.push(b']');
    bytes
}

/// The preview cache entry of one fingerprint. It is keyed by the canonical
/// path and the full stamp only, as the hash does not depend on a decoder.
fn fingerprint_name(path: &Path, stamp: &SourceStamp) -> Option<String> {
    let key = serde_json::to_vec(&("fp", path, stamp)).ok()?;
    Some(format!("{:x}.fp.json", Sha256::digest(key)))
}

/// The hash in a preview cache entry, if the entry is for `path` and `stamp`.
fn stored_fingerprint(bytes: &[u8], path: &Path, stamp: &SourceStamp) -> Option<String> {
    let (p, s, hash): Fingerprint = serde_json::from_slice(bytes).ok()?;
    (p == path && s == *stamp && hash_valid(&hash)).then_some(hash)
}

pub struct Edits {
    directory: PathBuf,
    // Serializes saves/flush so an older request cannot publish after a newer one.
    pending: Mutex<HashMap<PathBuf, Document>>,
    fingerprints: Mutex<FingerprintCache>,
    fingerprint_writer: Mutex<()>,
    /// Keeps the fingerprints beyond `FINGERPRINT_LIMIT` across restarts.
    store: Option<Arc<Store>>,
}

impl Edits {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_store(directory, None)
    }

    pub fn with_store(directory: PathBuf, store: Option<Arc<Store>>) -> Self {
        // PNGs already survive restarts; their source validation must too, or
        // importing saved edits reads every full RAW before showing cached pixels.
        // ponytail: Windows keeps session-only hashes until file-ID/change-time
        // validation is available; size/mtime/creation time cannot safely persist.
        let mut entries = if cfg!(unix) {
            read_json_bounded::<VecDeque<Fingerprint>>(
                &directory.join(FINGERPRINTS_FILE),
                JSON_LIMIT,
            )
            .ok()
            .flatten()
            .unwrap_or_default()
        } else {
            VecDeque::new()
        };
        entries.retain(|(path, _, hash)| path.is_absolute() && hash_valid(hash));
        entries.truncate(FINGERPRINT_LIMIT);
        let mut fingerprints = FingerprintCache::default();
        // Oldest first, so that the newest has the highest tick. A first-level
        // entry is not known to be in the preview cache; eviction stores it.
        for (path, stamp, hash) in entries.into_iter().rev() {
            fingerprints.put(path, stamp, hash, None, None);
        }
        fingerprints.dirty = false;
        Self {
            directory,
            pending: Mutex::new(HashMap::new()),
            fingerprints: Mutex::new(fingerprints),
            fingerprint_writer: Mutex::new(()),
            // The Windows stamp cannot detect a replacement with the same size
            // and times, so its hashes stay in memory for this session only.
            store: store.filter(|_| cfg!(unix)),
        }
    }

    /// Puts fingerprints into the preview cache for `generation`. Returns the
    /// stored ones.
    fn spill(&self, entries: Vec<Fingerprint>, generation: u64) -> Vec<Fingerprint> {
        let Some(store) = &self.store else {
            return vec![];
        };
        entries
            .into_iter()
            .filter(|entry| {
                let (Some(name), Ok(bytes)) = (
                    fingerprint_name(&entry.0, &entry.1),
                    serde_json::to_vec(entry),
                ) else {
                    return false;
                };
                store.put(generation, &name, &bytes)
            })
            .collect()
    }

    fn remember(&self, path: PathBuf, stamp: SourceStamp, hash: String, stored: Option<u64>) {
        let current = self.store.as_ref().map(|s| s.generation());
        let evicted = match self.fingerprints.lock() {
            Ok(mut cache) => cache.put(path, stamp, hash, stored, current),
            Err(_) => return,
        };
        // Memory no longer has them, so there is nothing to mark.
        if let Some(current) = current {
            self.spill(evicted, current);
        }
    }

    pub fn flush_fingerprints(&self) {
        if !cfg!(unix) {
            return;
        }
        // Serialize publishers, not readers. A later flush must not be replaced
        // by an older snapshot, and changes during the write must stay dirty.
        let Ok(_writer) = self.fingerprint_writer.lock() else {
            return;
        };
        // A Clear removes stored fingerprints without a change here, so check
        // the generation on each flush, not only when the snapshot changes.
        let generation = self
            .store
            .as_ref()
            .filter(|s| s.enabled())
            .map(|s| s.generation());
        let (entries, beyond) = {
            let Ok(mut cache) = self.fingerprints.lock() else {
                return;
            };
            let beyond = generation.map_or_else(Vec::new, |g| cache.unstored(FINGERPRINT_LIMIT, g));
            if !cache.dirty && beyond.is_empty() {
                return;
            }
            let entries = cache.dirty.then(|| cache.newest(FINGERPRINT_LIMIT));
            cache.dirty = false;
            (entries, beyond)
        };
        // Store the fingerprints that the snapshot leaves out before it
        // replaces a snapshot that has them.
        if let Some(generation) = generation {
            let stored = self.spill(beyond, generation);
            if let Ok(mut cache) = self.fingerprints.lock() {
                for (path, stamp, _) in stored {
                    if let Some(entry) = cache.entries.get_mut(&path).filter(|e| e.stamp == stamp) {
                        entry.stored = Some(generation);
                    }
                }
            }
        }
        let Some(entries) = entries else {
            return;
        };
        let bytes = fingerprint_snapshot(&entries);
        if write_bytes_atomic(&self.directory.join(FINGERPRINTS_FILE), &bytes, false).is_err() {
            if let Ok(mut cache) = self.fingerprints.lock() {
                cache.dirty = true;
            }
        }
    }

    pub fn source_revision(&self, path: &Path) -> Result<String, String> {
        source_path(path)?;
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        // Capture the generation before the stamp. A Clear after this point
        // makes the store reject this fingerprint.
        let generation = self.store.as_ref().map(|s| s.generation());
        let before = SourceStamp::new(&fs::metadata(&canonical).map_err(|e| e.to_string())?)?;
        if let Some(hash) = self
            .fingerprints
            .lock()
            .map_err(|_| "Source cache unavailable")?
            .get(&canonical, &before)
        {
            return Ok(hash);
        }
        let cached = self
            .store
            .as_ref()
            .zip(fingerprint_name(&canonical, &before));
        if let Some((store, name)) = &cached {
            if let Some(hash) = store
                .get(name, &[], |b| {
                    stored_fingerprint(b, &canonical, &before).is_some()
                })
                .and_then(|b| stored_fingerprint(&b, &canonical, &before))
            {
                self.remember(canonical, before, hash.clone(), generation);
                return Ok(hash);
            }
        }
        let mut file = fs::File::open(&canonical).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut bytes = [0_u8; 65536];
        loop {
            let n = file.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            digest.update(&bytes[..n]);
        }
        let after = SourceStamp::new(&fs::metadata(&canonical).map_err(|e| e.to_string())?)?;
        if after != before {
            return Err("The source changed while being read; reopen the photo".into());
        }
        let hash = format!("{:x}", digest.finalize());
        let persisted = match (&cached, generation) {
            (Some((store, name)), Some(generation)) => {
                serde_json::to_vec(&(&canonical, &before, &hash))
                    .is_ok_and(|bytes| store.put(generation, name, &bytes))
            }
            _ => false,
        };
        self.remember(
            canonical,
            before,
            hash.clone(),
            generation.filter(|_| persisted),
        );
        Ok(hash)
    }

    fn backup(&self, path: &Path) -> PathBuf {
        self.directory.join(format!(
            "{:x}.json",
            Sha256::digest(path.to_string_lossy().as_bytes())
        ))
    }

    pub fn protect_backup(&self, output: &Path) -> Result<(), String> {
        if let Ok(target) = output.canonicalize() {
            if self
                .backup(&target)
                .try_exists()
                .map_err(|e| e.to_string())?
            {
                return Err(format!(
                    "Cannot overwrite a source photo with saved edits: {}",
                    output.display()
                ));
            }
        }
        Ok(())
    }

    fn read(path: &Path) -> Result<Option<Document>, String> {
        let Some(document) = read_json_bounded::<Document>(path, JSON_LIMIT).map_err(|e| {
            format!(
                "Cannot read edits at {}: {e}. The file has been preserved.",
                path.display()
            )
        })?
        else {
            return Ok(None);
        };
        if !(1..=DOCUMENT_VERSION).contains(&document.version) {
            return Err(format!(
                "Unsupported edit version in {}; update X3Fuse. The file has been preserved.",
                path.display()
            ));
        }
        document
            .recipe
            .validate()
            .map_err(|e| format!("Invalid edits at {}: {e}", path.display()))?;
        Ok(Some(document))
    }

    fn current(&self, path: &Path) -> Result<Option<(Document, String, PathBuf)>, String> {
        let sidecar_path = sidecar(path);
        let backup_path = self.backup(path);
        let adjacent = Self::read(&sidecar_path)?;
        let backup = Self::read(&backup_path)?;
        Ok(match (adjacent, backup) {
            (Some(a), Some(b)) if b.updated_ms > a.updated_ms => {
                Some((b, "backup".into(), backup_path))
            }
            (Some(a), _) => Some((a, "sidecar".into(), sidecar_path)),
            (None, Some(b)) => Some((b, "backup".into(), backup_path)),
            _ => None,
        })
    }

    pub fn load(&self, path: &Path) -> Result<Option<EditRecord>, String> {
        source_path(path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let _pending = self
            .pending
            .lock()
            .map_err(|_| "Edit storage unavailable")?;
        let Some((document, storage, storage_path)) = self.current(&path)? else {
            return Ok(None);
        };
        if document.source_revision != self.source_revision(&path)? {
            return Err("The saved edits belong to different source contents. Both files have been preserved.".into());
        }
        crate::source::validate_recipe(&path, &document.recipe)?;
        Ok(Some(record(document, storage, storage_path)))
    }

    pub fn save(
        &self,
        path: &Path,
        recipe: EditRecipe,
        revision: u64,
        expected_source: Option<&str>,
    ) -> Result<EditRecord, String> {
        crate::source::validate_recipe(path, &recipe)?;
        if revision == 0 || revision > 9_007_199_254_740_991 {
            return Err("Invalid edit revision".into());
        }
        let source_revision = self.source_revision(path)?;
        if expected_source.is_some_and(|expected| expected != source_revision) {
            return Err("Source contents changed; reopen the photo before saving".into());
        }
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Edit storage unavailable")?;
        let current = self.current(&path)?;
        let mut previous_ms = 0;
        for previous in pending
            .get(&path)
            .into_iter()
            .chain(current.as_ref().map(|(doc, _, _)| doc))
        {
            check_previous(previous, &source_revision, &recipe, revision)?;
            previous_ms = previous_ms.max(previous.updated_ms);
        }
        let updated_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let document = Document {
            version: DOCUMENT_VERSION,
            source_revision,
            revision,
            updated_ms: updated_ms.max(previous_ms.saturating_add(1)),
            recipe,
        };
        pending.insert(path.clone(), document.clone());
        let saved = self.publish(&path, document)?;
        pending.remove(&path);
        drop(pending);
        self.flush_fingerprints();
        Ok(saved)
    }

    /// Removes stored edits that are not edits. Returns false and keeps the files
    /// when a newer or unpublished save replaced the loaded document.
    pub fn clear(&self, path: &Path, loaded: &EditRecord) -> Result<bool, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Edit storage unavailable")?;
        let Some((document, _, current)) = self.current(&path)? else {
            return Ok(false);
        };
        if pending.contains_key(&path)
            || document.revision != loaded.revision
            || document.recipe != loaded.recipe
        {
            return Ok(false);
        }
        // Remove the current document last. If a removal fails, it stays the one
        // that loads, and an older copy cannot return.
        let older = if current == sidecar(&path) {
            self.backup(&path)
        } else {
            sidecar(&path)
        };
        for file in [older, current] {
            match fs::remove_file(&file) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(format!("Cannot remove edits at {}: {e}", file.display())),
            }
        }
        Ok(true)
    }

    fn publish(&self, path: &Path, document: Document) -> Result<EditRecord, String> {
        if self.source_revision(path)? != document.source_revision {
            return Err("Source contents changed before edits could be saved".into());
        }
        let adjacent = sidecar(path);
        let backup = self.backup(path);
        match write_json_atomic(&adjacent, &document) {
            Ok(()) => {
                // A stale fallback must not win on a later load.
                match fs::remove_file(&backup) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(_) => { /* Sidecar has a newer timestamp and remains authoritative. */ }
                }
                Ok(record(document, "sidecar".into(), adjacent))
            }
            Err(primary) => {
                write_json_atomic(&backup, &document).map_err(|fallback| {
                    format!("Edits remain unsaved. Sidecar: {primary}. Local backup: {fallback}")
                })?;
                Ok(record(document, "backup".into(), backup))
            }
        }
    }

    pub fn flush(&self) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Edit storage unavailable")?;
        let paths: Vec<_> = pending.keys().cloned().collect();
        for path in paths {
            let mut document = pending.get(&path).ok_or("Missing pending edits")?.clone();
            if self.source_revision(&path)? != document.source_revision {
                return Err(
                    "Source changed with unsaved edits; keep the app open and recover the edits"
                        .into(),
                );
            }
            // A document can change externally while a failed write awaits retry.
            if let Some((previous, _, _)) = self.current(&path)? {
                check_previous(
                    &previous,
                    &document.source_revision,
                    &document.recipe,
                    document.revision,
                )?;
                document.updated_ms = document
                    .updated_ms
                    .max(previous.updated_ms.saturating_add(1));
            }
            self.publish(&path, document)?;
            pending.remove(&path);
        }
        drop(pending);
        self.flush_fingerprints();
        Ok(())
    }

    pub fn has_pending(&self) -> bool {
        self.pending
            .lock()
            .map_or(true, |pending| !pending.is_empty())
    }
}

fn check_previous(
    previous: &Document,
    source_revision: &str,
    recipe: &EditRecipe,
    revision: u64,
) -> Result<(), String> {
    if previous.source_revision != source_revision {
        return Err("Source contents changed; reopen the photo before saving".into());
    }
    if previous.revision > revision {
        return Err("A newer edit revision is already saved".into());
    }
    if previous.revision == revision && previous.recipe != *recipe {
        return Err("Conflicting edit revision; reload before saving".into());
    }
    Ok(())
}

pub fn sidecar(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".x3fuse.json");
    PathBuf::from(name)
}

fn record(document: Document, storage: String, storage_path: PathBuf) -> EditRecord {
    EditRecord {
        edited: true,
        legacy: document.version == 1,
        recipe: document.recipe,
        revision: document.revision,
        source_revision: document.source_revision,
        storage,
        storage_path,
        preview_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_edits_protect_an_unimported_source_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.dng");
        fs::write(&input, b"source").unwrap();
        let input = input.canonicalize().unwrap();
        let directory = temp.path().join("edits");
        fs::create_dir_all(&directory).unwrap();
        let edits = Edits::new(directory.clone());
        assert!(edits.protect_backup(&input).is_ok());
        fs::write(edits.backup(&input), b"saved edits").unwrap();
        let reopened = Edits::new(directory);
        assert!(reopened.protect_backup(&input).is_err());
    }

    #[test]
    fn saved_source_fingerprints_survive_restart_and_reject_changed_raws() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"original RAW bytes").unwrap();
        let input = input.canonicalize().unwrap();
        let directory = temp.path().join("edits");
        let edits = Edits::new(directory.clone());
        let saved = edits.save(&input, EditRecipe::default(), 1, None).unwrap();
        drop(edits);

        let reopened = Edits::new(directory.clone());
        #[cfg(unix)]
        assert_eq!(
            reopened.fingerprints.lock().unwrap().newest(1)[0].2,
            saved.source_revision,
            "A restart must restore the validated hash before loading saved edits"
        );
        assert_eq!(
            reopened.load(&input).unwrap().unwrap().source_revision,
            saved.source_revision
        );

        fs::write(&input, b"replacement RAW contents").unwrap();
        assert!(reopened
            .load(&input)
            .unwrap_err()
            .contains("different source"));
        let changed = reopened.source_revision(&input).unwrap();
        assert_ne!(changed, saved.source_revision);
        reopened.flush_fingerprints();
        assert_eq!(
            Edits::new(directory).source_revision(&input).unwrap(),
            changed
        );
        assert_eq!(fs::read(&input).unwrap(), b"replacement RAW contents");
    }

    #[cfg(unix)]
    #[test]
    fn fingerprints_reject_same_size_rewrites_and_replacements_with_preserved_mtime() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        let directory = temp.path().join("edits");
        fs::write(&input, b"original").unwrap();
        let edits = Edits::new(directory.clone());
        let original = edits.source_revision(&input).unwrap();
        edits.flush_fingerprints();
        let modified = fs::metadata(&input).unwrap().modified().unwrap();

        for replace in [false, true] {
            // Older Linux kernels timestamp ctime at clock-tick resolution.
            std::thread::sleep(std::time::Duration::from_millis(20));
            let path = if replace {
                temp.path().join("replacement.X3F")
            } else {
                input.clone()
            };
            fs::write(&path, if replace { b"replaced" } else { b"modified" }).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
            if replace {
                fs::rename(path, &input).unwrap();
            }
            let actual = format!("{:x}", Sha256::digest(fs::read(&input).unwrap()));
            assert_ne!(actual, original);
            assert_eq!(
                Edits::new(directory.clone())
                    .source_revision(&input)
                    .unwrap(),
                actual
            );
            assert_eq!(edits.source_revision(&input).unwrap(), actual);
            edits.flush_fingerprints();
        }
    }

    #[test]
    fn missing_corrupt_or_unwritable_fingerprint_cache_does_not_block_edits() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let directory = temp.path().join("edits");
        let saved = Edits::new(directory.clone())
            .save(&input, EditRecipe::default(), 1, None)
            .unwrap();
        fs::create_dir_all(&directory).unwrap();
        let cache = directory.join(FINGERPRINTS_FILE);
        fs::write(&cache, b"{incomplete").unwrap();
        assert_eq!(
            Edits::new(directory.clone())
                .load(&input)
                .unwrap()
                .unwrap()
                .source_revision,
            saved.source_revision
        );
        fs::remove_file(&cache).unwrap();
        fs::create_dir(&cache).unwrap();
        let edits = Edits::new(directory);
        assert_eq!(
            edits.load(&input).unwrap().unwrap().source_revision,
            saved.source_revision
        );
        assert!(edits.save(&input, EditRecipe::default(), 2, None).is_ok());
        #[cfg(unix)]
        {
            assert!(edits.fingerprints.lock().unwrap().dirty);
            fs::remove_dir(&cache).unwrap();
            edits.flush_fingerprints();
            assert!(!edits.fingerprints.lock().unwrap().dirty);
            assert!(cache.is_file());
        }
    }

    #[test]
    fn fingerprints_evict_only_the_least_recent_source_and_batch_publication() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let directory = temp.path().join("edits");
        let edits = Edits::new(directory.clone());
        let stamp = SourceStamp::new(&fs::metadata(&input).unwrap()).unwrap();
        let hash = edits.source_revision(&input).unwrap();
        assert!(
            !directory.join(FINGERPRINTS_FILE).exists(),
            "Hashing must not write the cache per file"
        );
        let path = |n| temp.path().join(format!("{n}.X3F"));
        {
            let mut cache = edits.fingerprints.lock().unwrap();
            for n in 0..FINGERPRINT_MEMORY_LIMIT {
                let stored = (n == 2 || n == 3).then_some(0);
                cache.put(path(n), stamp.clone(), hash.clone(), stored, Some(0));
            }
            assert_eq!(cache.get(&path(0), &stamp), Some(hash.clone()));
            let evicted = cache.put(
                path(FINGERPRINT_MEMORY_LIMIT),
                stamp.clone(),
                hash.clone(),
                None,
                Some(0),
            );
            assert_eq!(evicted.len(), 1);
            assert_eq!(evicted[0].0, path(1));
            assert_eq!(cache.entries.len(), FINGERPRINT_MEMORY_LIMIT);
            assert!(cache.get(&path(1), &stamp).is_none());
            assert_eq!(cache.get(&path(0), &stamp), Some(hash.clone()));
            // A stored fingerprint leaves memory without a second write.
            assert!(cache
                .put(
                    path(FINGERPRINT_MEMORY_LIMIT + 1),
                    stamp.clone(),
                    hash.clone(),
                    None,
                    Some(0)
                )
                .is_empty());
            assert!(!cache.entries.contains_key(&path(2)));
            // After a Clear, a fingerprint stored earlier is not stored.
            let evicted = cache.put(
                path(FINGERPRINT_MEMORY_LIMIT + 2),
                stamp.clone(),
                hash.clone(),
                None,
                Some(1),
            );
            assert_eq!(evicted.len(), 1);
            assert_eq!(evicted[0].0, path(3));
        }
        edits.flush_fingerprints();
        let reopened = Edits::new(directory);
        #[cfg(unix)]
        {
            let mut cache = reopened.fingerprints.lock().unwrap();
            assert_eq!(cache.entries.len(), FINGERPRINT_LIMIT);
            assert_eq!(cache.get(&path(0), &stamp), Some(hash));
            assert!(cache.get(&path(3), &stamp).is_none());
        }
        #[cfg(not(unix))]
        assert!(reopened.fingerprints.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn fingerprint_snapshot_skips_bad_entries_and_respects_the_read_limit() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&input).unwrap()).unwrap();
        let mut entries = VecDeque::new();
        for n in 0..FINGERPRINT_LIMIT {
            entries.push_back((
                temp.path().join(format!("{n}-{}.X3F", "long".repeat(400))),
                stamp.clone(),
                "a".repeat(64),
            ));
        }
        let mut before_epoch = stamp.clone();
        before_epoch.modified = UNIX_EPOCH - std::time::Duration::from_secs(1);
        entries.push_back((input.clone(), before_epoch, "a".repeat(64)));
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            entries.push_back((
                temp.path()
                    .join(std::ffi::OsString::from_vec(b"bad-\xff.X3F".to_vec())),
                stamp.clone(),
                "a".repeat(64),
            ));
        }
        entries.push_back((input.clone(), stamp, "b".repeat(64)));
        let newest: Vec<_> = entries.into_iter().rev().collect();
        let bytes = fingerprint_snapshot(&newest);
        assert!(bytes.len() <= JSON_LIMIT);
        let cache_path = temp.path().join(FINGERPRINTS_FILE);
        write_bytes_atomic(&cache_path, &bytes, false).unwrap();
        let saved: VecDeque<Fingerprint> =
            read_json_bounded(&cache_path, JSON_LIMIT).unwrap().unwrap();
        assert!(saved.len() > 1 && saved.len() < FINGERPRINT_LIMIT);
        assert_eq!(saved.front().unwrap().0, input);
        assert_eq!(saved.front().unwrap().2, "b".repeat(64));
        assert_eq!(
            saved.iter().filter(|(path, _, _)| path == &input).count(),
            1
        );
        assert!(saved.iter().all(|(path, _, _)| path.to_str().is_some()));
    }

    #[cfg(unix)]
    #[test]
    fn fingerprint_readers_do_not_wait_for_a_pending_publisher() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let edits = Edits::new(temp.path().join("edits"));
        let hash = edits.source_revision(&input).unwrap();
        let writer = edits.fingerprint_writer.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let publisher = scope.spawn(|| edits.flush_fingerprints());
            scope.spawn(|| send.send(edits.source_revision(&input)).unwrap());
            let hit = receive.recv_timeout(std::time::Duration::from_secs(1));
            drop(writer);
            publisher.join().unwrap();
            assert_eq!(hit.unwrap().unwrap(), hash);
        });
    }

    fn store(root: &Path, enabled: bool) -> Arc<Store> {
        let logs = Arc::new(crate::storage::Logs::new(root.join("logs")));
        Arc::new(Store::new(
            root.join("cache"),
            vec![],
            enabled,
            crate::cache::DEFAULT_LIMIT,
            logs,
        ))
    }

    #[cfg(unix)]
    fn stored_entry(root: &Path, path: &Path) -> PathBuf {
        let path = path.canonicalize().unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&path).unwrap()).unwrap();
        let name = fingerprint_name(&path, &stamp).unwrap();
        root.join("cache").join(&name[..2]).join(name)
    }

    #[cfg(unix)]
    #[test]
    fn fingerprints_beyond_the_snapshot_survive_restart_in_the_preview_cache() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("edits");
        let count = FINGERPRINT_LIMIT + 8;
        let inputs: Vec<_> = (0..count)
            .map(|n| {
                let input = temp.path().join(format!("{n}.X3F"));
                fs::write(&input, format!("RAW {n}")).unwrap();
                input
            })
            .collect();
        let edits = Edits::with_store(directory.clone(), Some(store(temp.path(), true)));
        let hashes: Vec<_> = inputs
            .iter()
            .map(|input| edits.source_revision(input).unwrap())
            .collect();
        edits.flush_fingerprints();
        drop(edits);

        // Replace the stored hash of the oldest source. Only a cache hit can
        // return it, so the source is not hashed again.
        let fake = "c".repeat(64);
        let entry = stored_entry(temp.path(), &inputs[0]);
        let canonical = inputs[0].canonicalize().unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&canonical).unwrap()).unwrap();
        fs::write(
            &entry,
            serde_json::to_vec(&(&canonical, &stamp, &fake)).unwrap(),
        )
        .unwrap();
        let store = store(temp.path(), true);
        let reopened = Edits::with_store(directory, Some(store.clone()));
        assert_eq!(
            reopened.fingerprints.lock().unwrap().entries.len(),
            FINGERPRINT_LIMIT
        );
        for (n, input) in inputs.iter().enumerate() {
            let expected = if n == 0 { &fake } else { &hashes[n] };
            assert_eq!(&reopened.source_revision(input).unwrap(), expected);
        }
        assert_eq!(store.stats.disk_hits.load(Ordering::Relaxed), 8);
        // A changed source misses its old entry.
        fs::write(&inputs[0], b"replacement RAW contents").unwrap();
        assert_eq!(
            reopened.source_revision(&inputs[0]).unwrap(),
            format!("{:x}", Sha256::digest(b"replacement RAW contents"))
        );
        assert_eq!(fs::read(&inputs[1]).unwrap(), b"RAW 1");
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_fingerprints_move_to_the_preview_cache_before_the_snapshot_drops_them() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("edits");
        let inputs: Vec<_> = (0..FINGERPRINT_LIMIT + 8)
            .map(|n| {
                let input = temp.path().join(format!("{n}.X3F"));
                fs::write(&input, format!("RAW {n}")).unwrap();
                input
            })
            .collect();
        // An earlier session without the preview cache wrote a full snapshot.
        let earlier = Edits::new(directory.clone());
        for input in &inputs[..FINGERPRINT_LIMIT] {
            earlier.source_revision(input).unwrap();
        }
        earlier.flush_fingerprints();
        drop(earlier);

        let edits = Edits::with_store(directory.clone(), Some(store(temp.path(), true)));
        for input in &inputs[FINGERPRINT_LIMIT..] {
            edits.source_revision(input).unwrap();
        }
        assert!(!stored_entry(temp.path(), &inputs[0]).exists());
        edits.flush_fingerprints();
        assert!(inputs[..8]
            .iter()
            .all(|input| stored_entry(temp.path(), input).is_file()));
        assert!(!stored_entry(temp.path(), &inputs[8]).exists());
        drop(edits);

        let cache = store(temp.path(), true);
        let reopened = Edits::with_store(directory, Some(cache.clone()));
        for input in &inputs {
            reopened.source_revision(input).unwrap();
        }
        assert_eq!(cache.stats.disk_hits.load(Ordering::Relaxed), 8);
    }

    #[cfg(unix)]
    #[test]
    fn flush_stores_fingerprints_again_after_clear() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("edits");
        let inputs: Vec<_> = (0..FINGERPRINT_LIMIT + 8)
            .map(|n| {
                let input = temp.path().join(format!("{n}.X3F"));
                fs::write(&input, format!("RAW {n}")).unwrap();
                input
            })
            .collect();
        let cache = store(temp.path(), true);
        let edits = Edits::with_store(directory.clone(), Some(cache.clone()));
        for input in &inputs {
            edits.source_revision(input).unwrap();
        }
        edits.flush_fingerprints();
        cache.clear().unwrap();
        assert!(!stored_entry(temp.path(), &inputs[0]).exists());
        // Nothing changed in memory, but the Clear removed the stored copies.
        edits.flush_fingerprints();
        assert!(inputs[..8]
            .iter()
            .all(|input| stored_entry(temp.path(), input).is_file()));
        assert!(!stored_entry(temp.path(), &inputs[8]).exists());
        drop(edits);

        let cache = store(temp.path(), true);
        let reopened = Edits::with_store(directory, Some(cache.clone()));
        for input in &inputs {
            reopened.source_revision(input).unwrap();
        }
        assert_eq!(cache.stats.disk_hits.load(Ordering::Relaxed), 8);
    }

    #[cfg(unix)]
    #[test]
    fn tampered_or_disabled_preview_cache_entries_are_not_trusted() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        let other = temp.path().join("other.X3F");
        fs::write(&input, b"RAW").unwrap();
        fs::write(&other, b"other RAW").unwrap();
        let real = format!("{:x}", Sha256::digest(b"RAW"));
        let directory = temp.path().join("edits");
        let store = store(temp.path(), true);
        assert_eq!(
            Edits::with_store(directory.clone(), Some(store.clone()))
                .source_revision(&input)
                .unwrap(),
            real
        );
        let entry = stored_entry(temp.path(), &input);
        let valid = fs::read(&entry).unwrap();
        let canonical = input.canonicalize().unwrap();
        let stamp = SourceStamp::new(&fs::metadata(&canonical).unwrap()).unwrap();
        let other_stamp = SourceStamp::new(&fs::metadata(&other).unwrap()).unwrap();
        let fake = "c".repeat(64);
        for bytes in [
            b"{incomplete".to_vec(),
            serde_json::to_vec(&(&canonical, &stamp, "c".repeat(63))).unwrap(),
            serde_json::to_vec(&(&canonical, &stamp, "z".repeat(64))).unwrap(),
            serde_json::to_vec(&(&canonical, &other_stamp, &fake)).unwrap(),
            serde_json::to_vec(&(other.canonicalize().unwrap(), &stamp, &fake)).unwrap(),
        ] {
            fs::write(&entry, &bytes).unwrap();
            // A new instance without a fingerprints file.
            let edits = Edits::with_store(directory.clone(), Some(store.clone()));
            assert_eq!(edits.source_revision(&input).unwrap(), real);
            assert_eq!(fs::read(&entry).unwrap(), valid);
        }

        // A disabled cache neither reads nor writes fingerprints.
        fs::write(
            &entry,
            serde_json::to_vec(&(&canonical, &stamp, &fake)).unwrap(),
        )
        .unwrap();
        store.configure(false, crate::cache::DEFAULT_LIMIT);
        let edits = Edits::with_store(directory.clone(), Some(store.clone()));
        assert_eq!(edits.source_revision(&input).unwrap(), real);
        assert_eq!(edits.source_revision(&other).unwrap().len(), 64);
        assert!(!stored_entry(temp.path(), &other).exists());
        // After Clear, nothing remains to trust.
        store.configure(true, crate::cache::DEFAULT_LIMIT);
        store.clear().unwrap();
        assert!(!entry.exists());
        let edits = Edits::with_store(directory, Some(store));
        assert_eq!(edits.source_revision(&input).unwrap(), real);
        assert!(entry.is_file());
    }

    #[cfg(not(unix))]
    #[test]
    fn windows_hashes_do_not_use_the_preview_cache() {
        let temp = tempfile::tempdir().unwrap();
        let edits = Edits::with_store(temp.path().join("edits"), Some(store(temp.path(), true)));
        assert!(edits.store.is_none());
    }

    #[cfg(not(unix))]
    #[test]
    fn persisted_hashes_are_not_trusted_without_change_time_validation() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"original").unwrap();
        let directory = temp.path().join("edits");
        let edits = Edits::new(directory.clone());
        edits.save(&input, EditRecipe::default(), 1, None).unwrap();
        let snapshot =
            fingerprint_snapshot(&edits.fingerprints.lock().unwrap().newest(FINGERPRINT_LIMIT));
        write_bytes_atomic(&directory.join(FINGERPRINTS_FILE), &snapshot, false).unwrap();
        let modified = fs::metadata(&input).unwrap().modified().unwrap();
        fs::write(&input, b"replaced").unwrap();
        fs::File::options()
            .write(true)
            .open(&input)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let reopened = Edits::new(directory);
        assert!(reopened.fingerprints.lock().unwrap().entries.is_empty());
        assert!(reopened
            .load(&input)
            .unwrap_err()
            .contains("different source"));
    }

    #[test]
    fn recipes_follow_original_bytes_and_never_replace_invalid_documents() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"original RAW bytes").unwrap();
        let edits = Edits::new(temp.path().join("backup"));
        let recipe = EditRecipe {
            exposure: 1.0,
            ..Default::default()
        };
        let saved = edits.save(&input, recipe.clone(), 1, None).unwrap();
        assert_eq!(saved.storage, "sidecar");
        assert_eq!(edits.load(&input).unwrap().unwrap().recipe, recipe);
        let moved = temp.path().join("renamed.X3F");
        fs::rename(&input, &moved).unwrap();
        fs::rename(sidecar(&input), sidecar(&moved)).unwrap();
        assert_eq!(edits.load(&moved).unwrap().unwrap().revision, 1);
        fs::write(sidecar(&moved), b"{\"version\":999}").unwrap();
        assert!(edits.save(&moved, recipe, 2, None).is_err());
        assert_eq!(fs::read(sidecar(&moved)).unwrap(), b"{\"version\":999}");
        assert_eq!(fs::read(&moved).unwrap(), b"original RAW bytes");
    }

    #[test]
    fn earlier_documents_load_as_legacy_and_clear_removes_only_the_loaded_document() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let input = input.canonicalize().unwrap();
        let edits = Edits::new(temp.path().join("backup"));
        let earlier = Document {
            version: 1,
            source_revision: edits.source_revision(&input).unwrap(),
            revision: 1,
            updated_ms: 1,
            recipe: EditRecipe::default(),
        };
        // An earlier build saved the sidecar, and a failed write left a backup.
        write_json_atomic(&sidecar(&input), &earlier).unwrap();
        fs::create_dir_all(&edits.directory).unwrap();
        write_json_atomic(&edits.backup(&input), &earlier).unwrap();
        let loaded = edits.load(&input).unwrap().unwrap();
        assert!(loaded.legacy && loaded.edited);
        let changed = EditRecord {
            revision: 2,
            ..loaded.clone()
        };
        assert!(!edits.clear(&input, &changed).unwrap());
        assert!(sidecar(&input).is_file());
        assert!(edits.clear(&input, &loaded).unwrap());
        assert!(!sidecar(&input).exists() && !edits.backup(&input).exists());
        assert!(edits.load(&input).unwrap().is_none());
        // New documents are version 2 and are not legacy.
        let saved = edits.save(&input, EditRecipe::default(), 1, None).unwrap();
        assert!(!saved.legacy);
        let text = fs::read_to_string(sidecar(&input)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap()["version"],
            2
        );
        assert!(!edits.load(&input).unwrap().unwrap().legacy);
    }

    #[cfg(unix)]
    #[test]
    fn clear_keeps_the_current_document_when_an_older_copy_cannot_be_removed() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let input = input.canonicalize().unwrap();
        let edits = Edits::new(temp.path().join("backup"));
        let source_revision = edits.source_revision(&input).unwrap();
        let older = Document {
            version: 2,
            source_revision: source_revision.clone(),
            revision: 1,
            updated_ms: 1,
            recipe: EditRecipe {
                exposure: 1.,
                ..Default::default()
            },
        };
        let defaults = Document {
            revision: 2,
            updated_ms: 2,
            recipe: EditRecipe::default(),
            ..older.clone()
        };
        fs::create_dir_all(&edits.directory).unwrap();
        write_json_atomic(&edits.backup(&input), &older).unwrap();
        write_json_atomic(&sidecar(&input), &defaults).unwrap();
        let loaded = edits.load(&input).unwrap().unwrap();
        assert_eq!(loaded.revision, 2);
        let mode =
            |mode| fs::set_permissions(&edits.directory, fs::Permissions::from_mode(mode)).unwrap();
        mode(0o500);
        let cleared = edits.clear(&input, &loaded);
        mode(0o700);
        assert!(cleared.is_err());
        assert_eq!(edits.load(&input).unwrap().unwrap().revision, 2);
        assert!(edits.clear(&input, &loaded).unwrap());
        assert!(edits.load(&input).unwrap().is_none());
    }

    #[test]
    fn failed_sidecar_uses_backup_and_recovered_sidecar_removes_stale_backup() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let input = input.canonicalize().unwrap();
        // A non-existent sidecar's parent can be writable while publication fails.
        let edits = Edits::new(temp.path().join("backup"));
        let document = Document {
            version: 1,
            source_revision: edits.source_revision(&input).unwrap(),
            revision: 1,
            updated_ms: 1,
            recipe: EditRecipe::default(),
        };
        fs::create_dir(sidecar(&input)).unwrap();
        let saved = edits.publish(&input, document.clone()).unwrap();
        assert_eq!(saved.storage, "backup");
        assert!(saved.storage_path.is_file());
        fs::remove_dir(sidecar(&input)).unwrap();
        assert_eq!(edits.load(&input).unwrap().unwrap().storage, "backup");
        let next = EditRecipe {
            exposure: 2.0,
            ..Default::default()
        };
        edits.save(&input, next, 2, None).unwrap();
        assert_eq!(edits.load(&input).unwrap().unwrap().storage, "sidecar");
        assert!(!saved.storage_path.exists());
    }

    #[test]
    fn failed_publication_keeps_pending_until_storage_recovers() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let input = input.canonicalize().unwrap();
        let edits = Edits::new(temp.path().join("backup"));
        fs::write(&edits.directory, b"unavailable directory").unwrap();
        let document = Document {
            version: 1,
            source_revision: edits.source_revision(&input).unwrap(),
            revision: 1,
            updated_ms: 1,
            recipe: EditRecipe::default(),
        };
        // Simulate accepted pending edits while both storage locations are unavailable.
        // This is deterministic on Windows too, unlike directory permissions.
        fs::create_dir(sidecar(&input)).unwrap();
        edits
            .pending
            .lock()
            .unwrap()
            .insert(input.clone(), document.clone());
        let failure = edits.publish(&input, document).unwrap_err();
        assert!(failure.contains("Sidecar:") && failure.contains("Local backup:"));
        assert!(edits.flush().is_err());
        assert!(edits.has_pending());
        fs::remove_dir(sidecar(&input)).unwrap();
        fs::remove_file(&edits.directory).unwrap();
        edits.flush().unwrap();
        assert!(!edits.has_pending());
        assert_eq!(edits.load(&input).unwrap().unwrap().revision, 1);
        assert_eq!(fs::read(&input).unwrap(), b"RAW");
    }

    #[test]
    fn retry_preserves_external_documents_and_changed_sources() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"RAW").unwrap();
        let input = input.canonicalize().unwrap();
        let edits = Edits::new(temp.path().join("backup"));
        let document = Document {
            version: 1,
            source_revision: edits.source_revision(&input).unwrap(),
            revision: 2,
            updated_ms: 1,
            recipe: EditRecipe::default(),
        };
        edits
            .pending
            .lock()
            .unwrap()
            .insert(input.clone(), document.clone());
        let mut newer = document.clone();
        newer.revision = 3;
        let mut conflict = document.clone();
        conflict.recipe.exposure = 1.0;
        for external in [
            b"{\"version\":999}".to_vec(),
            serde_json::to_vec(&newer).unwrap(),
            serde_json::to_vec(&conflict).unwrap(),
        ] {
            fs::write(sidecar(&input), &external).unwrap();
            assert!(edits.flush().is_err());
            assert!(edits.has_pending());
            assert_eq!(fs::read(sidecar(&input)).unwrap(), external);
            assert!(edits
                .save(&input, document.recipe.clone(), 2, None)
                .is_err());
        }
        fs::remove_file(sidecar(&input)).unwrap();
        fs::write(&input, b"replacement RAW contents").unwrap();
        assert!(edits.flush().is_err());
        assert!(edits.has_pending());
        assert!(edits
            .save(&input, document.recipe, 3, Some(&document.source_revision),)
            .is_err());
        assert!(!sidecar(&input).exists());
        assert_eq!(fs::read(&input).unwrap(), b"replacement RAW contents");
    }
}
