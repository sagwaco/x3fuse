//! Pick/reject flags and star ratings. They are kept apart from edit recipes
//! and never change or delete the original files.
use crate::{
    model::source_path,
    storage::{read_json_bounded, write_json_atomic},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const JSON_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flag {
    #[default]
    Unflagged,
    Pick,
    Reject,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cull {
    pub flag: Flag,
    pub rating: u8,
}

pub struct Culling {
    path: PathBuf,
    // ponytail: keyed by path, so a moved or renamed photo loses its flag and rating.
    // Key by source fingerprint if photos must keep them across moves.
    photos: Mutex<HashMap<PathBuf, Cull>>,
    /// Set when an unreadable store could not be moved aside. Saves would replace it.
    unreadable: Option<String>,
    /// Set by the first save. Afterwards a close waits for the window's queued saves.
    pub used: AtomicBool,
}

impl Culling {
    pub fn load(path: PathBuf) -> Self {
        let mut unreadable = None;
        let mut photos = match read_json_bounded::<HashMap<PathBuf, Cull>>(&path, JSON_LIMIT) {
            Ok(photos) => photos.unwrap_or_default(),
            Err(error) => {
                // Keep an unreadable store for recovery under a name that no save uses.
                let millis = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |time| time.as_millis());
                if fs::rename(&path, path.with_extension(format!("json.{millis}.bad"))).is_err() {
                    unreadable = Some(format!(
                        "Cannot read flags and ratings at {}: {error}. The file has been preserved.",
                        path.display()
                    ));
                }
                HashMap::new()
            }
        };
        photos.retain(|_, cull| cull.rating <= 5);
        Self {
            path,
            photos: Mutex::new(photos),
            unreadable,
            used: AtomicBool::new(false),
        }
    }

    pub fn used(&self) -> bool {
        self.used.load(Ordering::SeqCst)
    }

    pub fn get(&self, path: &Path) -> Cull {
        self.photos
            .lock()
            .ok()
            .and_then(|photos| photos.get(&key(path)).copied())
            .unwrap_or_default()
    }

    /// Sets the given fields on every path. The change is saved before it applies.
    pub fn set(
        &self,
        paths: &[PathBuf],
        flag: Option<Flag>,
        rating: Option<u8>,
    ) -> Result<(), String> {
        if let Some(error) = &self.unreadable {
            return Err(error.clone());
        }
        if rating.is_some_and(|rating| rating > 5) {
            return Err("Invalid rating".into());
        }
        if paths.len() > 100_000 {
            return Err("Too many photos".into());
        }
        let mut photos = self.photos.lock().map_err(|_| "Culling unavailable")?;
        let mut next = photos.clone();
        for path in paths {
            source_path(path)?;
            let key = key(path);
            let mut cull = next.get(&key).copied().unwrap_or_default();
            cull.flag = flag.unwrap_or(cull.flag);
            cull.rating = rating.unwrap_or(cull.rating);
            if cull == Cull::default() {
                next.remove(&key);
            } else {
                next.insert(key, cull);
            }
        }
        write_json_atomic(&self.path, &next)?;
        *photos = next;
        Ok(())
    }
}

fn key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn culls_persist_by_photo_and_keep_unreadable_files() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("a.X3F");
        fs::write(&photo, b"x3f").unwrap();
        let store = dir.path().join("culling.json");
        let culling = Culling::load(store.clone());
        culling
            .set(std::slice::from_ref(&photo), Some(Flag::Pick), None)
            .unwrap();
        culling
            .set(std::slice::from_ref(&photo), None, Some(4))
            .unwrap();
        assert!(culling
            .set(std::slice::from_ref(&photo), None, Some(6))
            .is_err());
        assert!(culling
            .set(&[dir.path().join("missing.X3F")], Some(Flag::Reject), None)
            .is_err());
        let expected = Cull {
            flag: Flag::Pick,
            rating: 4,
        };
        assert_eq!(Culling::load(store.clone()).get(&photo), expected);

        // Default values are not stored.
        culling
            .set(std::slice::from_ref(&photo), Some(Flag::Unflagged), Some(0))
            .unwrap();
        assert_eq!(fs::read_to_string(&store).unwrap().trim(), "{}");

        fs::write(&store, b"{").unwrap();
        let recovered = Culling::load(store.clone());
        assert_eq!(recovered.get(&photo), Cull::default());
        let bad: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.to_string_lossy().ends_with(".bad"))
            .collect();
        assert_eq!(bad.len(), 1);
        assert_eq!(fs::read(&bad[0]).unwrap(), b"{");
        recovered
            .set(std::slice::from_ref(&photo), Some(Flag::Pick), None)
            .unwrap();
        assert_eq!(fs::read(&bad[0]).unwrap(), b"{");

        // A store that cannot be moved aside is never replaced.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&store, b"{").unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
            let locked = Culling::load(store.clone());
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
            assert!(locked
                .set(std::slice::from_ref(&photo), Some(Flag::Pick), None)
                .is_err());
            assert_eq!(fs::read(&store).unwrap(), b"{");
        }
    }
}
