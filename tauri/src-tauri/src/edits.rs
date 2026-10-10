//! Non-destructive recipes. Originals are opened read-only; failed writes stay pending.
use crate::{
    model::source_path,
    storage::{read_json_bounded, write_bytes_atomic, write_json_atomic},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use x3f_render::EditRecipe;

const FINGERPRINTS_FILE: &str = "fingerprints-v2.json";
const FINGERPRINT_LIMIT: usize = 1024;
const JSON_LIMIT: usize = 1024 * 1024;

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
struct SourceStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    // Detect replacements and same-size writes that restore the old mtime.
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl SourceStamp {
    fn new(metadata: &fs::Metadata) -> Result<Self, String> {
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

#[derive(Default)]
struct FingerprintCache {
    // ponytail: linear LRU lookup, bounded to 1024 sources like the preview cache.
    entries: VecDeque<Fingerprint>,
    dirty: bool,
}

impl FingerprintCache {
    fn get(&mut self, path: &Path, stamp: &SourceStamp) -> Option<String> {
        let index = self
            .entries
            .iter()
            .position(|(p, s, _)| p == path && s == stamp)?;
        let entry = self.entries.remove(index)?;
        let hash = entry.2.clone();
        self.entries.push_back(entry);
        Some(hash)
    }

    fn put(&mut self, path: PathBuf, stamp: SourceStamp, hash: String) {
        self.entries.retain(|(p, _, _)| p != &path);
        self.entries.push_back((path, stamp, hash));
        while self.entries.len() > FINGERPRINT_LIMIT {
            self.entries.pop_front();
        }
        self.dirty = true;
    }
}

fn fingerprint_snapshot(entries: &VecDeque<Fingerprint>) -> Vec<u8> {
    // Newest first on disk. Bad paths/timestamps only omit their own entry;
    // long paths cannot make us publish a file the bounded reader rejects.
    let mut bytes = vec![b'['];
    for entry in entries.iter().rev() {
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

pub struct Edits {
    directory: PathBuf,
    // Serializes saves/flush so an older request cannot publish after a newer one.
    pending: Mutex<HashMap<PathBuf, Document>>,
    fingerprints: Mutex<FingerprintCache>,
    fingerprint_writer: Mutex<()>,
}

impl Edits {
    pub fn new(directory: PathBuf) -> Self {
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
        entries.retain(|(path, _, hash)| {
            path.is_absolute() && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
        });
        entries.truncate(FINGERPRINT_LIMIT);
        entries.make_contiguous().reverse();
        Self {
            directory,
            pending: Mutex::new(HashMap::new()),
            fingerprints: Mutex::new(FingerprintCache {
                entries,
                dirty: false,
            }),
            fingerprint_writer: Mutex::new(()),
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
        let entries = {
            let Ok(mut cache) = self.fingerprints.lock() else {
                return;
            };
            if !cache.dirty {
                return;
            }
            cache.dirty = false;
            cache.entries.clone()
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
        let before = SourceStamp::new(&fs::metadata(&canonical).map_err(|e| e.to_string())?)?;
        if let Some(hash) = self
            .fingerprints
            .lock()
            .map_err(|_| "Source cache unavailable")?
            .get(&canonical, &before)
        {
            return Ok(hash);
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
        let mut cache = self
            .fingerprints
            .lock()
            .map_err(|_| "Source cache unavailable")?;
        cache.put(canonical, before, hash.clone());
        Ok(hash)
    }

    fn backup(&self, path: &Path) -> PathBuf {
        self.directory.join(format!(
            "{:x}.json",
            Sha256::digest(path.to_string_lossy().as_bytes())
        ))
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
        if document.version != 1 {
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
        Ok(Some(record(document, storage, storage_path)))
    }

    pub fn save(
        &self,
        path: &Path,
        recipe: EditRecipe,
        revision: u64,
        expected_source: Option<&str>,
    ) -> Result<EditRecord, String> {
        recipe.validate().map_err(|e| e.to_string())?;
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
            version: 1,
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
            reopened
                .fingerprints
                .lock()
                .unwrap()
                .entries
                .back()
                .unwrap()
                .2,
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
            for n in 0..FINGERPRINT_LIMIT {
                cache.put(path(n), stamp.clone(), hash.clone());
            }
            assert_eq!(cache.get(&path(0), &stamp), Some(hash.clone()));
            cache.put(path(FINGERPRINT_LIMIT), stamp.clone(), hash.clone());
            assert_eq!(cache.entries.len(), FINGERPRINT_LIMIT);
            assert!(cache.get(&path(1), &stamp).is_none());
            assert_eq!(cache.get(&path(0), &stamp), Some(hash.clone()));
        }
        edits.flush_fingerprints();
        let reopened = Edits::new(directory);
        #[cfg(unix)]
        {
            let mut cache = reopened.fingerprints.lock().unwrap();
            assert_eq!(cache.entries.len(), FINGERPRINT_LIMIT);
            assert_eq!(cache.get(&path(0), &stamp), Some(hash));
            assert!(cache.get(&path(1), &stamp).is_none());
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
        let bytes = fingerprint_snapshot(&entries);
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

    #[cfg(not(unix))]
    #[test]
    fn persisted_hashes_are_not_trusted_without_change_time_validation() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("photo.X3F");
        fs::write(&input, b"original").unwrap();
        let directory = temp.path().join("edits");
        let edits = Edits::new(directory.clone());
        edits.save(&input, EditRecipe::default(), 1, None).unwrap();
        let snapshot = fingerprint_snapshot(&edits.fingerprints.lock().unwrap().entries);
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
