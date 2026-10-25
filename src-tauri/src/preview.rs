use crate::{
    edits::SourceStamp,
    metadata::{is_jpeg, DisplayMeta, ExifTool},
    model::source_path,
    storage::{write_bytes_atomic, Logs},
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const BUDGET: usize = 128 * 1024 * 1024;
/// The preview cache directory in the app cache directory.
pub const CACHE_DIRECTORY: &str = "previews-v1";
/// The largest preview or metadata file that the cache stores and reads.
const ENTRY_LIMIT: u64 = 16 * 1024 * 1024;
type Image = Option<Arc<Vec<u8>>>;
#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Image)>,
    bytes: usize,
}

/// JPEG previews (`<key>.jpg`) and import metadata (`<key>.json`) on disk, so that
/// photos seen before load without ExifTool. Errors only cause a miss.
pub struct DiskCache {
    dir: PathBuf,
    state: Mutex<DiskState>,
    logs: Arc<Logs>,
}

struct DiskState {
    enabled: bool,
    limit: u64,
    /// The bytes in the directory, counted from the directory once.
    used: Option<u64>,
    /// Clear and Disable increment it, so that older work cannot store entries after them.
    generation: u64,
}

/// The cache key of a source file, taken before the file is read.
pub struct Ticket {
    key: String,
    generation: u64,
}

impl DiskCache {
    pub fn new(dir: PathBuf, enabled: bool, limit: u64, logs: Arc<Logs>) -> Self {
        Self {
            dir,
            state: Mutex::new(DiskState {
                enabled,
                limit,
                used: None,
                generation: 0,
            }),
            logs,
        }
    }

    fn state(&self) -> MutexGuard<'_, DiskState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The SHA-256 of the path and its `SourceStamp`. On Unix the stamp has the device,
    /// inode and change time, so a replaced file misses even with the same size and
    /// modified time. On Windows it has only the size and the modified and created
    /// times: a replacement that keeps all three hits the old entry.
    fn key(path: &Path) -> Option<String> {
        let stamp = SourceStamp::new(&fs::metadata(path).ok()?).ok()?;
        let mut bytes = serde_json::to_vec(&(path, stamp)).ok()?;
        bytes.extend(crate::source::decoder_identity(path).as_bytes());
        Some(format!("{:x}", Sha256::digest(bytes)))
    }

    /// None while the cache is disabled.
    pub fn ticket(&self, path: &Path) -> Option<Ticket> {
        let generation = {
            let state = self.state();
            if !state.enabled {
                return None;
            }
            state.generation
        };
        Some(Ticket {
            key: Self::key(path)?,
            generation,
        })
    }

    fn file(&self, ticket: &Ticket, extension: &str) -> PathBuf {
        self.dir.join(format!("{}.{extension}", ticket.key))
    }

    fn current(&self, ticket: &Ticket) -> bool {
        let state = self.state();
        state.enabled && state.generation == ticket.generation
    }

    fn read(&self, ticket: &Ticket, extension: &str) -> Option<Vec<u8>> {
        if !self.current(ticket) {
            return None;
        }
        let mut file = fs::File::options()
            .read(true)
            .write(true)
            .open(self.file(ticket, extension))
            .ok()?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(ENTRY_LIMIT + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > ENTRY_LIMIT {
            return None;
        }
        // Eviction removes the files with the oldest modified time first.
        let _ = file.set_modified(SystemTime::now());
        Some(bytes)
    }

    /// A corrupt entry is a miss. The next read from the source replaces it.
    fn corrupt(&self, ticket: &Ticket, extension: &str, error: impl std::fmt::Display) {
        let path = self.file(ticket, extension);
        self.logs.write(
            "error",
            format!("Preview cache entry {}: {error}", path.display()),
        );
    }

    /// The cached import metadata, with the cached preview when there is one.
    pub fn metadata(&self, ticket: &Ticket) -> Option<DisplayMeta> {
        let bytes = self.read(ticket, "json")?;
        match serde_json::from_slice::<DisplayMeta>(&bytes) {
            Ok(mut meta) => {
                meta.preview = self.preview(ticket);
                Some(meta)
            }
            Err(error) => {
                self.corrupt(ticket, "json", error);
                None
            }
        }
    }

    pub fn preview(&self, ticket: &Ticket) -> Option<Vec<u8>> {
        let bytes = self.read(ticket, "jpg")?;
        if is_jpeg(&bytes) {
            Some(bytes)
        } else {
            self.corrupt(ticket, "jpg", "not a JPEG");
            None
        }
    }

    /// Stores data read from `path`. It does nothing when the file changed after the
    /// ticket, or when a Clear or Disable came after it.
    pub fn store(&self, path: &Path, ticket: &Ticket, extension: &str, bytes: &[u8]) {
        if bytes.len() as u64 > ENTRY_LIMIT || Self::key(path).as_ref() != Some(&ticket.key) {
            return;
        }
        let mut state = self.state();
        if !state.enabled || state.generation != ticket.generation {
            return;
        }
        let target = self.file(ticket, extension);
        let used = self.used(&mut state);
        let old = fs::metadata(&target).map_or(0, |meta| meta.len());
        match write_bytes_atomic(&target, bytes, false) {
            Ok(()) => {
                state.used = Some(used.saturating_sub(old) + bytes.len() as u64);
                self.trim_locked(&mut state);
            }
            Err(error) => self.logs.write(
                "error",
                format!("Preview cache write {}: {error}", target.display()),
            ),
        }
    }

    fn scan(&self) -> Vec<(SystemTime, u64, PathBuf)> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return vec![];
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                meta.is_file().then(|| {
                    (
                        meta.modified().unwrap_or(UNIX_EPOCH),
                        meta.len(),
                        entry.path(),
                    )
                })
            })
            .collect()
    }

    fn used(&self, state: &mut DiskState) -> u64 {
        *state
            .used
            .get_or_insert_with(|| self.scan().iter().map(|(_, len, _)| len).sum())
    }

    /// Over the limit, removes the least recently used files down to 90% of it.
    // ponytail: each eviction lists the directory; keep an index if that gets slow.
    fn trim_locked(&self, state: &mut DiskState) {
        if self.used(state) <= state.limit {
            return;
        }
        let mut files = self.scan();
        files.sort_unstable_by_key(|(modified, _, _)| *modified);
        let mut used: u64 = files.iter().map(|(_, len, _)| len).sum();
        for (_, len, path) in files {
            if used <= state.limit / 10 * 9 {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                used -= len;
            }
        }
        state.used = Some(used);
    }

    /// Counts the cache and removes files over the limit.
    pub fn trim(&self) {
        self.trim_locked(&mut self.state());
    }

    /// Disable keeps the files until Clear. A lower limit removes files at once.
    pub fn configure(&self, enabled: bool, limit: u64) {
        let mut state = self.state();
        if state.enabled && !enabled {
            state.generation += 1;
        }
        state.enabled = enabled;
        state.limit = limit;
        self.trim_locked(&mut state);
    }

    pub fn size(&self) -> u64 {
        self.used(&mut self.state())
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut state = self.state();
        state.generation += 1;
        state.used = None;
        match fs::remove_dir_all(&self.dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => {
                state.used = Some(0);
                Ok(())
            }
        }
    }
}

pub struct Previews {
    cache: Mutex<Cache>,
    flights: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    slots: Semaphore,
    thumbnail_slots: Semaphore,
    raw_slot: Semaphore,
    exif: Arc<ExifTool>,
    pub disk: Arc<DiskCache>,
}

impl Previews {
    pub fn new(exif: Arc<ExifTool>, disk: Arc<DiskCache>) -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            flights: AsyncMutex::new(HashMap::new()),
            slots: Semaphore::new(4),
            thumbnail_slots: Semaphore::new(3),
            raw_slot: Semaphore::new(1),
            exif,
            disk,
        }
    }

    /// Import metadata and previews for `paths`. The disk cache gives what it has, and one
    /// ExifTool call reads the rest. Missing JPEGs are rendered from RAW.
    /// The previews go to the memory cache, not the result.
    pub async fn import(&self, paths: &[PathBuf]) -> HashMap<PathBuf, DisplayMeta> {
        let (disk, inputs) = (self.disk.clone(), paths.to_vec());
        let lookups = tauri::async_runtime::spawn_blocking(move || {
            inputs
                .into_iter()
                .map(|path| {
                    let ticket = disk.ticket(&path);
                    let hit = ticket.as_ref().and_then(|ticket| disk.metadata(ticket));
                    (path, ticket, hit)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut result = HashMap::new();
        let mut tickets = HashMap::new();
        for (path, ticket, hit) in lookups {
            match (hit, ticket) {
                (Some(meta), _) => {
                    result.insert(path, meta);
                }
                (None, Some(ticket)) => {
                    tickets.insert(path, ticket);
                }
                (None, None) => {}
            }
        }
        let misses: Vec<_> = paths
            .iter()
            .filter(|path| !result.contains_key(*path))
            .cloned()
            .collect();
        if !misses.is_empty() {
            let read = self.exif.display(&misses).await;
            let writes: Vec<_> = read
                .iter()
                .filter_map(|(path, meta)| {
                    let json = serde_json::to_vec(meta).ok()?;
                    Some((
                        path.clone(),
                        tickets.remove(path)?,
                        json,
                        meta.preview.clone(),
                    ))
                })
                .collect();
            let disk = self.disk.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                for (path, ticket, json, preview) in writes {
                    // Without a preview, keep a JPEG that `get` may have stored.
                    if let Some(jpeg) = preview {
                        disk.store(&path, &ticket, "jpg", &jpeg);
                    }
                    disk.store(&path, &ticket, "json", &json);
                }
            })
            .await;
            result.extend(read);
        }
        for (path, meta) in &mut result {
            if let Some(bytes) = meta.preview.take() {
                self.prime(path, bytes);
            } else if let Err(error) = self.get(path, false).await {
                self.disk
                    .logs
                    .write("error", format!("Preview {}: {error}", path.display()));
            }
        }
        result
    }
    fn key(path: &Path, full: bool) -> Result<String, String> {
        source_path(path)?;
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        Ok(format!(
            "{full}:{}:{:?}:{}:{}",
            meta.len(),
            meta.modified().map_err(|e| e.to_string())?,
            path.display(),
            crate::source::decoder_identity(path)
        ))
    }
    fn cached(&self, key: &str) -> Option<Image> {
        let mut cache = self.cache.lock().unwrap();
        let index = cache.entries.iter().position(|(k, _)| k == key)?;
        let entry = cache.entries.remove(index)?;
        let result = entry.1.clone();
        cache.entries.push_back(entry);
        Some(result)
    }
    fn store(&self, key: String, image: Image) {
        let mut cache = self.cache.lock().unwrap();
        if let Some(i) = cache.entries.iter().position(|(k, _)| k == &key) {
            if let Some((_, old)) = cache.entries.remove(i) {
                cache.bytes -= old.map_or(0, |b| b.len());
            }
        }
        cache.bytes += image.as_ref().map_or(0, |b| b.len());
        cache.entries.push_back((key, image));
        // ponytail: linear LRU lookup, bounded to 512 entries; use an indexed LRU if profiling warrants it.
        while cache.bytes > BUDGET || cache.entries.len() > 512 {
            if let Some((_, old)) = cache.entries.pop_front() {
                cache.bytes -= old.map_or(0, |b| b.len());
            }
        }
    }
    pub fn prime(&self, path: &Path, bytes: Vec<u8>) {
        if is_jpeg(&bytes) {
            if let Ok(key) = Self::key(path, false) {
                self.store(key, Some(Arc::new(bytes)));
            }
        }
    }
    pub async fn get(&self, path: &Path, full: bool) -> Result<Image, String> {
        let key = Self::key(path, full)?;
        if let Some(hit) = self.cached(&key) {
            return Ok(hit);
        }
        let flight = self
            .flights
            .lock()
            .await
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _guard = flight.lock().await;
        if let Some(hit) = self.cached(&key) {
            return Ok(hit);
        }
        // The disk cache has only the small preview. A hit needs no ExifTool slot.
        let ticket = if full {
            None
        } else {
            let (disk, source) = (self.disk.clone(), path.to_owned());
            let (ticket, hit) = tauri::async_runtime::spawn_blocking(move || {
                let ticket = disk.ticket(&source);
                let hit = ticket.as_ref().and_then(|ticket| disk.preview(ticket));
                (ticket, hit)
            })
            .await
            .unwrap_or((None, None));
            if let Some(bytes) = hit {
                let image = Some(Arc::new(bytes));
                self.store(key.clone(), image.clone());
                self.flights.lock().await.remove(&key);
                return Ok(image);
            }
            ticket
        };
        // Acquire this first so waiting thumbnails cannot occupy the foreground slot.
        let _thumbnail_slot = if full {
            None
        } else {
            Some(
                self.thumbnail_slots
                    .acquire()
                    .await
                    .map_err(|e| e.to_string())?,
            )
        };
        let _slot = self.slots.acquire().await.map_err(|e| e.to_string())?;
        // Import metadata can prime the preview while extraction is queued.
        let result = match self.cached(&key) {
            Some(hit) => Ok(hit),
            None => {
                let mut result = self.exif.preview(path, full).await.map(|b| b.map(Arc::new));
                if matches!(result, Ok(None)) {
                    // Release extraction slots before the full view requests its thumbnail.
                    drop(_slot);
                    drop(_thumbnail_slot);
                    result = if full {
                        Box::pin(self.get(path, false)).await
                    } else {
                        let _raw_slot = self.raw_slot.acquire().await.map_err(|e| e.to_string())?;
                        let source = path.to_owned();
                        tauri::async_runtime::spawn_blocking(move || {
                            let bytes =
                                if crate::source::Kind::of(&source) == crate::source::Kind::Dng {
                                    let cancel = std::sync::atomic::AtomicBool::new(false);
                                    let info = crate::source::Info::read(&source, &cancel)?;
                                    crate::metadata::preview_orientation(
                                        x3f_dng::preview(&source, &cancel)?,
                                        info.orientation.unwrap_or(1),
                                    )?
                                } else {
                                    x3f_render::raw_preview(&source)?
                                };
                            Ok(Some(Arc::new(bytes)))
                        })
                        .await
                        .unwrap_or_else(|e| Err(e.to_string()))
                    };
                }
                if let (Ok(Some(bytes)), Some(ticket)) = (&result, ticket) {
                    let (disk, source, bytes) = (self.disk.clone(), path.to_owned(), bytes.clone());
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        disk.store(&source, &ticket, "jpg", &bytes)
                    })
                    .await;
                }
                result
            }
        };
        if let Ok(image) = &result {
            self.store(key.clone(), image.clone());
        }
        self.flights.lock().await.remove(&key);
        result
    }
}

pub fn cache_control(uri: &str, status: u16) -> &'static str {
    if status != 200 {
        return "no-store";
    }
    if url::Url::parse(uri).is_ok_and(|url| {
        url.query_pairs()
            .any(|(key, value)| key == "r" && !value.is_empty())
    }) {
        "private, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

pub fn protocol_path(uri: &str) -> Result<(std::path::PathBuf, bool), String> {
    let url = url::Url::parse(uri).map_err(|e| e.to_string())?;
    // convertFileSrc percent-encodes the entire native path into one URL component.
    let encoded = url.path().strip_prefix('/').ok_or("Missing preview path")?;
    let path = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let full = match url
        .query_pairs()
        .find(|(k, _)| k == "v")
        .as_ref()
        .map(|(_, v)| v.as_ref())
    {
        None | Some("preview") => false,
        Some("full") => true,
        _ => return Err("Invalid preview variant".into()),
    };
    let path = std::path::PathBuf::from(path.as_ref());
    source_path(&path)?;
    Ok((path, full))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ExifPair;
    use std::{future::Future, task::Poll, time::Duration};

    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xd9];

    /// Without an ExifTool binary in `exiftool`, only the caches can answer.
    fn previews(dir: &Path, exiftool: PathBuf, limit: u64) -> Previews {
        let logs = Arc::new(Logs::new(dir.join("logs")));
        let disk = DiskCache::new(dir.join("cache"), true, limit, logs.clone());
        Previews::new(
            Arc::new(ExifTool::new(exiftool, dir.join("x3i"), logs)),
            Arc::new(disk),
        )
    }

    fn source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn meta() -> DisplayMeta {
        DisplayMeta {
            orientation: Some(6),
            aspect_ratio: Some(1.5),
            preview: None,
            exif: vec![ExifPair {
                label: "Camera".into(),
                value: "SIGMA dp2 Quattro".into(),
            }],
        }
    }

    fn put(disk: &DiskCache, path: &Path, bytes: &[u8]) {
        let ticket = disk.ticket(path).unwrap();
        disk.store(path, &ticket, "jpg", bytes);
        disk.store(path, &ticket, "json", &serde_json::to_vec(&meta()).unwrap());
    }

    #[test]
    fn disk_entries_round_trip_and_a_changed_file_misses() {
        let dir = tempfile::tempdir().unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let disk = &previews.disk;
        let path = source(dir.path(), "写真.X3F", b"raw");
        put(disk, &path, JPEG);
        let hit = disk.metadata(&disk.ticket(&path).unwrap()).unwrap();
        assert_eq!(
            (
                hit.orientation,
                hit.aspect_ratio,
                hit.exif[0].value.as_str()
            ),
            (Some(6), Some(1.5), "SIGMA dp2 Quattro")
        );
        assert_eq!(hit.preview.as_deref(), Some(JPEG));
        let used = disk.size();
        // A second write of one key replaces the entry and its bytes.
        put(disk, &path, JPEG);
        assert_eq!(disk.size(), used);
        assert_eq!(fs::read_dir(dir.path().join("cache")).unwrap().count(), 2);

        // The same size with other content is another file: the stamp changes.
        std::thread::sleep(Duration::from_millis(5));
        fs::write(&path, b"RAW").unwrap();
        let ticket = disk.ticket(&path).unwrap();
        assert!(disk.metadata(&ticket).is_none());
        assert!(disk.preview(&ticket).is_none());

        // A file that changes during the read is not stored.
        fs::write(&path, b"changed raw").unwrap();
        disk.store(&path, &ticket, "jpg", JPEG);
        assert!(disk.preview(&disk.ticket(&path).unwrap()).is_none());
        assert_eq!(disk.size(), used);
    }

    #[test]
    fn corrupt_and_oversized_entries_are_misses_until_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let disk = &previews.disk;
        let path = source(dir.path(), "image.X3F", b"raw");
        let ticket = disk.ticket(&path).unwrap();
        disk.store(&path, &ticket, "jpg", b"not a jpeg");
        disk.store(&path, &ticket, "json", b"{");
        assert!(disk.metadata(&ticket).is_none());
        assert!(disk.preview(&ticket).is_none());
        // The next read from the source replaces them. The size counts each file once.
        put(disk, &path, JPEG);
        assert!(disk.metadata(&ticket).is_some());
        let json = serde_json::to_vec(&meta()).unwrap();
        assert_eq!(disk.size(), (JPEG.len() + json.len()) as u64);

        // Files over the entry limit are not stored, and are misses when found.
        let large = [JPEG, &vec![0; ENTRY_LIMIT as usize]].concat();
        disk.store(&path, &ticket, "jpg", &large);
        assert_eq!(disk.preview(&ticket).as_deref(), Some(JPEG));
        fs::write(disk.file(&ticket, "jpg"), &large).unwrap();
        assert!(disk.preview(&ticket).is_none());
    }

    #[test]
    fn eviction_removes_the_least_recently_used_files() {
        let dir = tempfile::tempdir().unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1000);
        let disk = &previews.disk;
        let image = [JPEG, &[0; 396]].concat();
        let [a, b, c] =
            ["a", "b", "c"].map(|name| source(dir.path(), &format!("{name}.X3F"), b"raw"));
        let store = |path: &Path| {
            disk.store(path, &disk.ticket(path).unwrap(), "jpg", &image);
            std::thread::sleep(Duration::from_millis(10));
        };
        store(&a);
        store(&b);
        assert!(disk.preview(&disk.ticket(&a).unwrap()).is_some());
        std::thread::sleep(Duration::from_millis(10));
        store(&c);
        assert_eq!(disk.size(), 800);
        assert!(disk.preview(&disk.ticket(&b).unwrap()).is_none());
        assert!(disk.preview(&disk.ticket(&a).unwrap()).is_some());

        // A lower limit evicts at once, and later writes keep to it.
        disk.configure(true, 500);
        assert_eq!(disk.size(), 400);
        store(&b);
        assert_eq!(disk.size(), 400);
        assert!(disk.preview(&disk.ticket(&b).unwrap()).is_some());

        // At startup, a cache over its limit is trimmed.
        let logs = Arc::new(Logs::new(dir.path().join("logs")));
        let restarted = DiskCache::new(dir.path().join("cache"), true, 200, logs);
        restarted.trim();
        assert_eq!(restarted.size(), 0);
    }

    #[test]
    fn disable_and_clear_stop_older_work() {
        let dir = tempfile::tempdir().unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let disk = &previews.disk;
        let path = source(dir.path(), "image.X3F", b"raw");
        put(disk, &path, JPEG);
        let used = disk.size();

        // Disabled: no reads and no writes. The files stay.
        let before = disk.ticket(&path).unwrap();
        disk.configure(false, 1 << 20);
        assert!(disk.ticket(&path).is_none());
        assert!(disk.metadata(&before).is_none());
        let other = source(dir.path(), "other.X3F", b"raw");
        let ticket = DiskCache::key(&other).map(|key| Ticket { key, generation: 0 });
        disk.store(&other, &ticket.unwrap(), "jpg", JPEG);
        assert_eq!(disk.size(), used);
        disk.configure(true, 1 << 20);
        assert!(disk.metadata(&disk.ticket(&path).unwrap()).is_some());
        // A read that started before Disable cannot store after it.
        disk.store(&path, &before, "jpg", &[JPEG, b"new"].concat());
        assert_eq!(disk.size(), used);

        // Clear during an extraction: the extraction does not store its result.
        // The previews in memory stay.
        let extracting = disk.ticket(&other).unwrap();
        previews.prime(&path, JPEG.to_vec());
        disk.clear().unwrap();
        assert_eq!(disk.size(), 0);
        assert!(previews
            .cached(&Previews::key(&path, false).unwrap())
            .is_some());
        disk.store(&other, &extracting, "jpg", JPEG);
        assert_eq!(disk.size(), 0);
        assert!(!dir.path().join("cache").exists());
        put(disk, &other, JPEG);
        assert!(disk.size() > 0);
    }

    #[tokio::test]
    async fn disk_hits_need_no_exiftool() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), "image.X3F", b"raw");
        put(
            &previews(dir.path(), dir.path().into(), 1 << 20).disk,
            &path,
            JPEG,
        );
        // A new instance has an empty memory cache.
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let missing = source(dir.path(), "missing.X3F", b"raw");
        let mut found = previews.import(&[missing.clone(), path.clone()]).await;
        assert!(!found.contains_key(&missing));
        let hit = found.remove(&path).unwrap();
        assert_eq!(hit.orientation, Some(6));
        // The preview goes to the memory cache.
        assert!(hit.preview.is_none());
        let key = Previews::key(&path, false).unwrap();
        assert_eq!(previews.cached(&key).unwrap().unwrap().as_slice(), JPEG);

        let previews = self::previews(dir.path(), dir.path().into(), 1 << 20);
        let image = previews.get(&path, false).await.unwrap().unwrap();
        assert_eq!(image.as_slice(), JPEG);
        assert!(previews.flights.lock().await.is_empty());
        // The full variant is not in the disk cache.
        assert!(previews.get(&path, true).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_full_jpeg_reuses_thumbnail_without_holding_slots() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("exiftool"), r#"if (grep { $_ eq "-PreviewImage" } @ARGV) { print pack("C*", 255, 216, 255, 217); }"#).unwrap();
        let path = source(dir.path(), "no-jpeg.X3F", b"raw");
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let occupied = previews.slots.acquire_many(3).await.unwrap();
        let image =
            tokio::time::timeout(std::time::Duration::from_secs(5), previews.get(&path, true))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        assert_eq!(image.as_slice(), JPEG);
        assert!(previews.flights.lock().await.is_empty());
        drop(occupied);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_raw_fallback_is_an_error_and_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("exiftool"), "exit 0;").unwrap();
        let path = source(dir.path(), "invalid.X3F", b"invalid raw");
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        assert!(previews.get(&path, false).await.is_err());
        assert!(previews
            .cached(&Previews::key(&path, false).unwrap())
            .is_none());
        assert!(previews
            .disk
            .preview(&previews.disk.ticket(&path).unwrap())
            .is_none());
        assert!(previews.flights.lock().await.is_empty());
    }

    #[tokio::test]
    #[ignore = "needs X3FUSE_TEST_NO_JPEG and bundled ExifTool"]
    async fn raw_without_jpeg_imports_and_reuses_disk_preview() {
        let path = PathBuf::from(std::env::var("X3FUSE_TEST_NO_JPEG").unwrap());
        let dir = tempfile::tempdir().unwrap();
        let exiftool = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool");
        let previews = previews(dir.path(), exiftool, 1 << 20);
        assert!(previews.exif.preview(&path, false).await.unwrap().is_none());
        assert!(previews
            .import(std::slice::from_ref(&path))
            .await
            .contains_key(&path));
        let small = previews.get(&path, false).await.unwrap().unwrap();
        assert!(is_jpeg(&small));
        assert_eq!(small, previews.get(&path, true).await.unwrap().unwrap());
        // A fresh service with no ExifTool must read the rendered JPEG from disk.
        let fresh = self::previews(dir.path(), dir.path().join("missing"), 1 << 20);
        assert_eq!(small, fresh.get(&path, false).await.unwrap().unwrap());
        assert_eq!(fresh.import(&[path]).await.len(), 1);
    }

    #[tokio::test]
    async fn waiting_thumbnails_leave_foreground_capacity_and_reuse_imported_previews() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.X3F");
        std::fs::write(&path, b"raw").unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let occupied = previews.thumbnail_slots.acquire_many(3).await.unwrap();
        let request = previews.get(&path, false);
        tokio::pin!(request);
        std::future::poll_fn(|cx| {
            assert!(request.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(previews.slots.available_permits(), 4);

        // No ExifTool binary exists: success requires checking the cache after the wait.
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        previews.prime(&path, jpeg.clone());
        drop(occupied);
        assert_eq!(request.await.unwrap().unwrap().as_ref(), &jpeg);
        assert!(previews.flights.lock().await.is_empty());

        let old_key = Previews::key(&path, false).unwrap();
        std::fs::write(&path, b"changed raw").unwrap();
        let new_key = Previews::key(&path, false).unwrap();
        assert_ne!(old_key, new_key);
        assert!(previews.cached(&new_key).is_none());
    }

    #[test]
    fn only_successful_revisioned_previews_are_reusable() {
        let url = "x3f-preview://localhost/%2Fimage.X3F?v=full&r=revision";
        assert_eq!(
            cache_control(url, 200),
            "private, max-age=31536000, immutable"
        );
        assert_eq!(cache_control(url, 404), "no-store");
        assert_eq!(cache_control(url, 400), "no-store");
        assert_eq!(
            cache_control("x3f-preview://localhost/image.X3F?v=full", 200),
            "no-cache"
        );
        assert_eq!(
            cache_control("x3f-preview://localhost/image.X3F?r=", 200),
            "no-cache"
        );
    }

    #[test]
    fn urls_roundtrip_spaces_unicode_and_literal_percent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("写真 100%.X3F");
        std::fs::write(&path, b"x").unwrap();
        let encoded = percent_encoding::utf8_percent_encode(
            path.to_str().unwrap(),
            percent_encoding::NON_ALPHANUMERIC,
        );
        for host in ["x3f-preview://localhost", "http://x3f-preview.localhost"] {
            let (decoded, full) = protocol_path(&format!("{host}/{encoded}?v=full&r=1")).unwrap();
            assert_eq!(decoded, path);
            assert!(full);
        }
        assert!(protocol_path("x3f-preview://localhost/%2Fetc%2Fpasswd").is_err());
    }

    /// X3FUSE_TEST_IMPORT_DIR=/absolute/dir cargo test --lib import_timing -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs X3FUSE_TEST_IMPORT_DIR and npm run sync:resources"]
    async fn import_timing() {
        let input = PathBuf::from(std::env::var("X3FUSE_TEST_IMPORT_DIR").unwrap());
        let mut paths: Vec<_> = fs::read_dir(input)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(crate::model::is_source_extension)
            })
            .collect();
        paths.sort();
        let dir = tempfile::tempdir().unwrap();
        let exiftool = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool");
        let run = |label: &str, previews: Previews| {
            let paths = paths.clone();
            let label = label.to_owned();
            async move {
                let start = std::time::Instant::now();
                let found = previews.import(&paths).await;
                let import = start.elapsed();
                let start = std::time::Instant::now();
                for path in &paths {
                    previews.get(path, false).await.unwrap();
                }
                eprintln!(
                    "{label}: import {} of {} files in {import:?}, then thumbnails in {:?}",
                    found.len(),
                    paths.len(),
                    start.elapsed()
                );
            }
        };
        // The first run also writes the X3I frame copy that later launches reuse.
        run(
            "cold, no X3I frame copy",
            previews(dir.path(), exiftool.clone(), 1 << 30),
        )
        .await;
        let previews_dir = dir.path().join("cache");
        fs::remove_dir_all(&previews_dir).unwrap();
        run(
            "cold (before this cache)",
            previews(dir.path(), exiftool.clone(), 1 << 30),
        )
        .await;
        run(
            "warm, disk cache",
            previews(dir.path(), exiftool.clone(), 1 << 30),
        )
        .await;
        // Thumbnails without import metadata: the protocol handler reads the disk cache.
        let fresh = previews(dir.path(), exiftool, 1 << 30);
        let start = std::time::Instant::now();
        for path in &paths {
            fresh.get(path, false).await.unwrap().unwrap();
        }
        eprintln!("warm thumbnails alone: {:?}", start.elapsed());
    }
}
