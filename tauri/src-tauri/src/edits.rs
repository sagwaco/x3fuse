//! Non-destructive recipes. Originals are opened read-only; failed writes stay pending.
use crate::{model::source_path, storage::write_json_atomic};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use x3f_render::EditRecipe;

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

type FingerprintCache = HashMap<PathBuf, (u64, SystemTime, String)>;

pub struct Edits {
    directory: PathBuf,
    // Serializes saves/flush so an older request cannot publish after a newer one.
    pending: Mutex<HashMap<PathBuf, Document>>,
    fingerprints: Mutex<FingerprintCache>,
}

impl Edits {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            pending: Mutex::new(HashMap::new()),
            fingerprints: Mutex::new(HashMap::new()),
        }
    }

    pub fn source_revision(&self, path: &Path) -> Result<String, String> {
        source_path(path)?;
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let before = fs::metadata(&canonical).map_err(|e| e.to_string())?;
        let modified = before.modified().map_err(|e| e.to_string())?;
        if let Some((size, time, hash)) = self
            .fingerprints
            .lock()
            .map_err(|_| "Source cache unavailable")?
            .get(&canonical)
        {
            if *size == before.len() && *time == modified {
                return Ok(hash.clone());
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
        let after = fs::metadata(&canonical).map_err(|e| e.to_string())?;
        if after.len() != before.len() || after.modified().map_err(|e| e.to_string())? != modified {
            return Err("The source changed while being read; reopen the photo".into());
        }
        let hash = format!("{:x}", digest.finalize());
        let mut cache = self
            .fingerprints
            .lock()
            .map_err(|_| "Source cache unavailable")?;
        if cache.len() >= 1024 {
            cache.clear();
        }
        cache.insert(canonical, (before.len(), modified, hash.clone()));
        Ok(hash)
    }

    fn backup(&self, path: &Path) -> PathBuf {
        self.directory.join(format!(
            "{:x}.json",
            Sha256::digest(path.to_string_lossy().as_bytes())
        ))
    }

    fn read(path: &Path) -> Result<Option<Document>, String> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Cannot read edits at {}: {e}", path.display())),
        };
        if file.metadata().map_err(|e| e.to_string())?.len() > 1024 * 1024 {
            return Err(format!(
                "Edit document exceeds size limit: {}",
                path.display()
            ));
        }
        let document: Document = serde_json::from_reader(file).map_err(|e| {
            format!(
                "Cannot read edits at {}: {e}. The file has been preserved.",
                path.display()
            )
        })?;
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
        let document = Document {
            version: 1,
            source_revision: edits.source_revision(&input).unwrap(),
            revision: 1,
            updated_ms: 1,
            recipe: EditRecipe::default(),
        };
        // Simulate storage becoming unavailable after save accepts the document.
        // This is deterministic on Windows too, unlike directory permissions.
        fs::create_dir(sidecar(&input)).unwrap();
        fs::write(&edits.directory, b"unavailable directory").unwrap();
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
