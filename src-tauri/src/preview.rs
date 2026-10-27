use crate::{
    cache::{source_key, Memory, Stats, Store},
    metadata::{is_jpeg, DisplayMeta, ExifTool},
    model::source_path,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

type Image = Option<Arc<Vec<u8>>>;

/// The disk names of an original: `<key>.jpg` is the embedded or rendered
/// preview, `<key>.full.jpg` the full JPEG (empty when the photo has none, so
/// that the full view reuses the preview), and `<key>.json` import metadata.
fn name(key: &str, kind: &str) -> String {
    format!("{key}.{kind}")
}

/// The legacy `previews-v1` names had the same keys, without the full JPEG.
fn legacy(key: &str, kind: &str) -> Vec<String> {
    match kind {
        "jpg" | "json" => vec![format!("{}/{key}.{kind}", crate::cache::LEGACY_PREVIEWS)],
        _ => vec![],
    }
}

/// The cache key of a source file, taken before the file is read.
#[derive(Clone)]
pub struct Ticket {
    key: String,
    generation: u64,
}

impl Ticket {
    fn new(store: &Store, path: &Path) -> Option<Self> {
        let generation = store.generation();
        Some(Self {
            key: source_key(path)?,
            generation,
        })
    }

    /// Stores data read from `path`. It does nothing when the file changed after
    /// the ticket, or when a Clear or Disable came after it.
    fn store(&self, store: &Store, path: &Path, kind: &str, bytes: &[u8]) {
        if source_key(path).as_ref() == Some(&self.key) {
            store.put(self.generation, &name(&self.key, kind), bytes);
        }
    }
}

fn read_jpeg(store: &Store, key: &str, kind: &str) -> Option<Vec<u8>> {
    store.get(&name(key, kind), &legacy(key, kind), |bytes| {
        is_jpeg(bytes) || (kind == "full.jpg" && bytes.is_empty())
    })
}

/// The cached import metadata, with the cached preview when there is one.
fn read_metadata(store: &Store, key: &str) -> Option<DisplayMeta> {
    let bytes = store.get(&name(key, "json"), &legacy(key, "json"), |bytes| {
        serde_json::from_slice::<DisplayMeta>(bytes).is_ok()
    })?;
    let mut meta = serde_json::from_slice::<DisplayMeta>(&bytes).ok()?;
    meta.preview = read_jpeg(store, key, "jpg");
    Some(meta)
}

/// A disk lookup for `get`. The full JPEG falls back to the preview when the
/// photo has none. Outer None: no entry.
fn read_preview(store: &Store, key: &str, full: bool) -> Option<Vec<u8>> {
    if full {
        let bytes = read_jpeg(store, key, "full.jpg")?;
        if !bytes.is_empty() {
            return Some(bytes);
        }
    }
    read_jpeg(store, key, "jpg")
}

pub struct Previews {
    memory: Arc<Memory>,
    flights: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    slots: Semaphore,
    thumbnail_slots: Semaphore,
    raw_slot: Semaphore,
    exif: Arc<ExifTool>,
    pub store: Arc<Store>,
}

impl Previews {
    pub fn new(exif: Arc<ExifTool>, store: Arc<Store>, memory: Arc<Memory>) -> Self {
        Self {
            memory,
            flights: AsyncMutex::new(HashMap::new()),
            slots: Semaphore::new(4),
            thumbnail_slots: Semaphore::new(3),
            raw_slot: Semaphore::new(1),
            exif,
            store,
        }
    }

    /// Import metadata and previews for `paths`. The disk cache gives what it has, and one
    /// ExifTool call reads the rest. Missing JPEGs are rendered from RAW.
    /// The previews go to the memory cache, not the result.
    pub async fn import(&self, paths: &[PathBuf]) -> HashMap<PathBuf, DisplayMeta> {
        let generation = self.store.generation();
        let (store, inputs) = (self.store.clone(), paths.to_vec());
        let lookups = tauri::async_runtime::spawn_blocking(move || {
            inputs
                .into_iter()
                .map(|path| {
                    let ticket = Ticket::new(&store, &path);
                    let hit = ticket
                        .as_ref()
                        .and_then(|ticket| read_metadata(&store, &ticket.key));
                    (path, ticket, hit)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut result = HashMap::new();
        let mut tickets = HashMap::new();
        let mut keys = HashMap::new();
        for (path, ticket, hit) in lookups {
            if let Some(ticket) = &ticket {
                keys.insert(path.clone(), ticket.key.clone());
            }
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
        let mut read = HashMap::new();
        if !misses.is_empty() {
            read = self.exif.display(&misses).await;
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
            let store = self.store.clone();
            // Writes are not on the import path.
            tauri::async_runtime::spawn_blocking(move || {
                for (path, ticket, json, preview) in writes {
                    // Without a preview, keep a JPEG that `get` may have stored.
                    if let Some(jpeg) = preview {
                        ticket.store(&store, &path, "jpg", &jpeg);
                    }
                    ticket.store(&store, &path, "json", &json);
                }
            });
        }
        let fresh: std::collections::HashSet<_> = read.keys().cloned().collect();
        result.extend(read);
        for (path, meta) in &mut result {
            let Some(key) = keys.get(path) else { continue };
            if let Some(bytes) = meta.preview.take() {
                self.prime(key, bytes, generation);
            } else if fresh.contains(path) {
                // A photo without an embedded JPEG gets its rendered preview now.
                // A cache hit without one renders on its first request instead.
                if let Err(error) = self.get(path, false, false).await {
                    self.store
                        .logs
                        .write("error", format!("Preview {}: {error}", path.display()));
                }
            }
        }
        result
    }

    fn memory_key(key: &str, full: bool) -> String {
        format!("original:{key}:{}", if full { "full" } else { "preview" })
    }

    fn cached(&self, key: &str) -> Option<Arc<Vec<u8>>> {
        let hit = self.memory.get(key);
        if hit.is_some() {
            Stats::add(&self.store.stats.memory_hits);
        }
        hit
    }

    fn prime(&self, key: &str, bytes: Vec<u8>, generation: u64) {
        if is_jpeg(&bytes) {
            self.store_memory(
                &Self::memory_key(key, false),
                &Some(Arc::new(bytes)),
                generation,
            );
        }
    }

    /// The preview or full JPEG of `path`. With `cache_only`, only the memory
    /// and disk caches answer: no ExifTool, RAW or wait for other work, and a
    /// miss is Ok(None).
    pub async fn get(&self, path: &Path, full: bool, cache_only: bool) -> Result<Image, String> {
        source_path(path)?;
        // Work that starts before a Clear or Disable cannot store after it.
        let generation = self.store.generation();
        let source = path.to_owned();
        let key = tauri::async_runtime::spawn_blocking(move || source_key(&source))
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Preview source unavailable")?;
        let memory_key = Self::memory_key(&key, full);
        if let Some(hit) = self.cached(&memory_key) {
            return Ok(Some(hit));
        }
        if cache_only {
            let (store, disk_key) = (self.store.clone(), key.clone());
            let hit =
                tauri::async_runtime::spawn_blocking(move || read_preview(&store, &disk_key, full))
                    .await
                    .map_err(|e| e.to_string())?;
            let Some(bytes) = hit else {
                Stats::add(&self.store.stats.misses);
                return Ok(None);
            };
            let image = Arc::new(bytes);
            self.store_memory(&memory_key, &Some(image.clone()), generation);
            return Ok(Some(image));
        }
        let flight = self
            .flights
            .lock()
            .await
            .entry(memory_key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let ticket = Ticket { key, generation };
        let result = self
            .generate(path, full, ticket, &memory_key, &flight)
            .await;
        self.flights.lock().await.remove(&memory_key);
        result
    }

    async fn generate(
        &self,
        path: &Path,
        full: bool,
        ticket: Ticket,
        memory_key: &str,
        flight: &AsyncMutex<()>,
    ) -> Result<Image, String> {
        let generation = ticket.generation;
        let _guard = flight.lock().await;
        if let Some(hit) = self.cached(memory_key) {
            return Ok(Some(hit));
        }
        // A disk hit needs no ExifTool slot.
        let (store, disk_key) = (self.store.clone(), ticket.key.clone());
        let hit =
            tauri::async_runtime::spawn_blocking(move || read_preview(&store, &disk_key, full))
                .await
                .unwrap_or(None);
        if let Some(bytes) = hit {
            let image = Some(Arc::new(bytes));
            self.store_memory(memory_key, &image, ticket.generation);
            return Ok(image);
        }
        Stats::add(&self.store.stats.misses);
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
        if let Some(hit) = self.cached(memory_key) {
            return Ok(Some(hit));
        }
        let mut result = self.exif.preview(path, full).await.map(|b| b.map(Arc::new));
        let mut kind = if full { "full.jpg" } else { "jpg" };
        if matches!(result, Ok(None)) {
            // Release extraction slots before the full view requests its thumbnail.
            drop(_slot);
            drop(_thumbnail_slot);
            result = if full {
                // An empty full entry records that the photo has no full JPEG.
                let (store, source, marker) = (self.store.clone(), path.to_owned(), ticket.clone());
                tauri::async_runtime::spawn_blocking(move || {
                    marker.store(&store, &source, "full.jpg", &[])
                });
                kind = "";
                Box::pin(self.get(path, false, false)).await
            } else {
                let _raw_slot = self.raw_slot.acquire().await.map_err(|e| e.to_string())?;
                let source = path.to_owned();
                Stats::add(&self.store.stats.renders);
                tauri::async_runtime::spawn_blocking(move || {
                    let bytes = if crate::source::Kind::of(&source) == crate::source::Kind::Dng {
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
        if let (Ok(Some(bytes)), false) = (&result, kind.is_empty()) {
            let (store, source, bytes) = (self.store.clone(), path.to_owned(), bytes.clone());
            // The response does not wait for the disk.
            tauri::async_runtime::spawn_blocking(move || {
                ticket.store(&store, &source, kind, &bytes)
            });
        }
        if let Ok(image) = &result {
            self.store_memory(memory_key, image, generation);
        }
        result
    }

    /// Keeps an image in memory, unless a Clear came after `generation`. The
    /// check runs under the memory lock, and Clear changes the generation
    /// before it empties memory, so late work cannot fill it again.
    fn store_memory(&self, key: &str, image: &Image, generation: u64) {
        if let Some(bytes) = image {
            self.memory.put_if(key.to_owned(), bytes.clone(), || {
                self.store.current(generation)
            });
        }
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

/// The source path, whether the request is for the full JPEG, and whether it
/// is cache-only (`cacheOnly=1`).
pub fn protocol_path(uri: &str) -> Result<(std::path::PathBuf, bool, bool), String> {
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
    let cache_only = cache_only(&url)?;
    let path = std::path::PathBuf::from(path.as_ref());
    source_path(&path)?;
    Ok((path, full, cache_only))
}

/// `cacheOnly=1` asks for a cache hit only: 200, or 204 on a miss.
pub fn cache_only(url: &url::Url) -> Result<bool, String> {
    match url.query_pairs().find(|(k, _)| k == "cacheOnly") {
        None => Ok(false),
        Some((_, v)) if v == "1" => Ok(true),
        _ => Err("Invalid cacheOnly value".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::ExifPair, storage::Logs};
    use std::{fs, future::Future, task::Poll, time::Duration};

    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xd9];

    fn store(dir: &Path, limit: u64) -> Arc<Store> {
        let logs = Arc::new(Logs::new(dir.join("logs")));
        let cache = dir.join("cache");
        Arc::new(Store::new(
            cache.join(crate::cache::DIRECTORY),
            vec![(
                crate::cache::LEGACY_PREVIEWS,
                cache.join(crate::cache::LEGACY_PREVIEWS),
            )],
            true,
            limit,
            logs,
        ))
    }

    /// Without an ExifTool binary in `exiftool`, only the caches can answer.
    fn previews(dir: &Path, exiftool: PathBuf, limit: u64) -> Previews {
        let store = store(dir, limit);
        Previews::new(
            Arc::new(ExifTool::new(exiftool, dir.join("x3i"), store.logs.clone())),
            store,
            Arc::new(Memory::new(1 << 30)),
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

    fn put(store: &Store, path: &Path, bytes: &[u8]) {
        let ticket = Ticket::new(store, path).unwrap();
        ticket.store(store, path, "jpg", bytes);
        ticket.store(store, path, "json", &serde_json::to_vec(&meta()).unwrap());
    }

    fn key(path: &Path) -> String {
        source_key(path).unwrap()
    }

    #[test]
    fn disk_entries_round_trip_and_a_changed_file_misses() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path(), 1 << 20);
        let path = source(dir.path(), "写真.X3F", b"raw");
        put(&store, &path, JPEG);
        let hit = read_metadata(&store, &key(&path)).unwrap();
        assert_eq!(
            (
                hit.orientation,
                hit.aspect_ratio,
                hit.exif[0].value.as_str()
            ),
            (Some(6), Some(1.5), "SIGMA dp2 Quattro")
        );
        assert_eq!(hit.preview.as_deref(), Some(JPEG));
        let used = store.size();
        // A second write of one key replaces the entry and its bytes.
        put(&store, &path, JPEG);
        assert_eq!(store.size(), used);

        // The same size with other content is another file: the stamp changes.
        std::thread::sleep(Duration::from_millis(5));
        let ticket = Ticket::new(&store, &path).unwrap();
        fs::write(&path, b"RAW").unwrap();
        assert!(read_metadata(&store, &key(&path)).is_none());
        // A file that changes during the read is not stored.
        ticket.store(&store, &path, "jpg", JPEG);
        assert!(read_jpeg(&store, &key(&path), "jpg").is_none());
        assert_eq!(store.size(), used);
        // A symbolic link has the key of its target.
        #[cfg(unix)]
        {
            let link = dir.path().join("link.X3F");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert_eq!(key(&link), key(&path));
        }
    }

    #[test]
    fn corrupt_entries_are_misses_until_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path(), 1 << 20);
        let path = source(dir.path(), "image.X3F", b"raw");
        let ticket = Ticket::new(&store, &path).unwrap();
        ticket.store(&store, &path, "jpg", b"not a jpeg");
        ticket.store(&store, &path, "json", b"{");
        assert!(read_metadata(&store, &ticket.key).is_none());
        assert!(read_jpeg(&store, &ticket.key, "jpg").is_none());
        assert_eq!(store.size(), 0);
        put(&store, &path, JPEG);
        assert!(read_metadata(&store, &ticket.key).is_some());
        let json = serde_json::to_vec(&meta()).unwrap();
        assert_eq!(store.size(), (JPEG.len() + json.len()) as u64);
    }

    #[test]
    fn legacy_entries_move_once_and_disable_and_clear_stop_older_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), "image.X3F", b"raw");
        let legacy = dir.path().join("cache").join(crate::cache::LEGACY_PREVIEWS);
        fs::create_dir_all(&legacy).unwrap();
        let k = key(&path);
        fs::write(legacy.join(format!("{k}.jpg")), JPEG).unwrap();
        fs::write(
            legacy.join(format!("{k}.json")),
            serde_json::to_vec(&meta()).unwrap(),
        )
        .unwrap();
        let store = store(dir.path(), 1 << 20);
        store.reconcile();
        let used = store.size();
        assert!(used > 0, "Legacy entries count until adopted or evicted");
        assert_eq!(
            read_metadata(&store, &k).unwrap().preview.as_deref(),
            Some(JPEG)
        );
        assert_eq!(store.size(), used, "Adoption moves, it does not copy");
        assert!(fs::read_dir(&legacy).unwrap().next().is_none());

        // Disabled: no reads and no writes. The files stay.
        let before = Ticket::new(&store, &path).unwrap();
        store.configure(false, 1 << 20);
        assert!(read_metadata(&store, &k).is_none());
        let other = source(dir.path(), "other.X3F", b"raw");
        put(&store, &other, JPEG);
        assert_eq!(store.size(), used);
        store.configure(true, 1 << 20);
        assert!(read_metadata(&store, &k).is_some());
        // A read that started before Disable cannot store after it.
        before.store(&store, &path, "jpg", &[JPEG, b"new"].concat());
        assert_eq!(read_jpeg(&store, &k, "jpg").as_deref(), Some(JPEG));

        // Clear during an extraction: the extraction does not store its result.
        let extracting = Ticket::new(&store, &other).unwrap();
        store.clear().unwrap();
        assert_eq!(store.size(), 0);
        extracting.store(&store, &other, "jpg", JPEG);
        assert_eq!(store.size(), 0);
        assert!(!dir
            .path()
            .join("cache")
            .join(crate::cache::DIRECTORY)
            .exists());
        put(&store, &other, JPEG);
        assert!(store.size() > 0);
    }

    #[tokio::test]
    async fn disk_hits_need_no_exiftool_and_cache_only_never_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), "image.X3F", b"raw");
        put(&store(dir.path(), 1 << 20), &path, JPEG);
        // A new instance has an empty memory cache.
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let missing = source(dir.path(), "missing.X3F", b"raw");
        let mut found = previews.import(&[missing.clone(), path.clone()]).await;
        assert!(!found.contains_key(&missing));
        let hit = found.remove(&path).unwrap();
        assert_eq!(hit.orientation, Some(6));
        // The preview goes to the memory cache.
        assert!(hit.preview.is_none());
        let memory_key = Previews::memory_key(&key(&path), false);
        assert_eq!(previews.cached(&memory_key).unwrap().as_slice(), JPEG);

        let previews = self::previews(dir.path(), dir.path().into(), 1 << 20);
        // Cache-only requests do not wait for a flight or an extraction slot.
        let flight = Arc::new(AsyncMutex::new(()));
        let held = flight.clone().lock_owned().await;
        previews
            .flights
            .lock()
            .await
            .insert(memory_key.clone(), flight);
        let slots = previews.slots.acquire_many(4).await.unwrap();
        let get = |path: PathBuf, full| {
            let previews = &previews;
            async move {
                tokio::time::timeout(Duration::from_secs(5), previews.get(&path, full, true))
                    .await
                    .unwrap()
                    .unwrap()
            }
        };
        assert_eq!(get(path.clone(), false).await.unwrap().as_slice(), JPEG);
        // No full entry and no other photo entry: misses, without ExifTool.
        assert!(get(path.clone(), true).await.is_none());
        assert!(get(missing.clone(), false).await.is_none());
        drop((held, slots));
        previews.flights.lock().await.clear();
        // The full variant has no disk entry: a normal request needs ExifTool.
        assert!(previews.get(&path, true, false).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_full_jpeg_reuses_thumbnail_and_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("exiftool"), r#"if (grep { $_ eq "-PreviewImage" } @ARGV) { print pack("C*", 255, 216, 255, 217); }"#).unwrap();
        let path = source(dir.path(), "no-jpeg.X3F", b"raw");
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let occupied = previews.slots.acquire_many(3).await.unwrap();
        let image = tokio::time::timeout(Duration::from_secs(5), previews.get(&path, true, false))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(image.as_slice(), JPEG);
        assert!(previews.flights.lock().await.is_empty());
        drop(occupied);
        // Disk writes run after the response.
        for _ in 0..100 {
            if read_jpeg(&previews.store, &key(&path), "full.jpg").is_some()
                && read_jpeg(&previews.store, &key(&path), "jpg").is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // After a restart, without ExifTool, the full view is a cache hit.
        let fresh = self::previews(dir.path(), dir.path().join("missing"), 1 << 20);
        let full = fresh.get(&path, true, true).await.unwrap().unwrap();
        assert_eq!(full.as_slice(), JPEG);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_raw_fallback_is_an_error_and_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("exiftool"), "exit 0;").unwrap();
        let path = source(dir.path(), "invalid.X3F", b"invalid raw");
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        assert!(previews.get(&path, false, false).await.is_err());
        assert!(previews
            .cached(&Previews::memory_key(&key(&path), false))
            .is_none());
        assert!(read_jpeg(&previews.store, &key(&path), "jpg").is_none());
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
        let small = previews.get(&path, false, false).await.unwrap().unwrap();
        assert!(is_jpeg(&small));
        assert_eq!(
            small,
            previews.get(&path, true, false).await.unwrap().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        // A fresh service with no ExifTool must read the rendered JPEG from disk.
        let fresh = self::previews(dir.path(), dir.path().join("missing"), 1 << 20);
        assert_eq!(small, fresh.get(&path, false, true).await.unwrap().unwrap());
        assert_eq!(fresh.import(&[path]).await.len(), 1);
    }

    #[tokio::test]
    async fn waiting_thumbnails_leave_foreground_capacity_and_reuse_imported_previews() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.X3F");
        fs::write(&path, b"raw").unwrap();
        let previews = previews(dir.path(), dir.path().into(), 1 << 20);
        let occupied = previews.thumbnail_slots.acquire_many(3).await.unwrap();
        let request = previews.get(&path, false, false);
        tokio::pin!(request);
        for _ in 0..50 {
            std::future::poll_fn(|cx| {
                assert!(request.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert_eq!(previews.slots.available_permits(), 4);

        // No ExifTool binary exists: success requires checking the cache after the wait.
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        previews.prime(&key(&path), jpeg.clone(), previews.store.generation());
        drop(occupied);
        assert_eq!(request.await.unwrap().unwrap().as_ref(), &jpeg);
        assert!(previews.flights.lock().await.is_empty());

        let old_key = key(&path);
        fs::write(&path, b"changed raw").unwrap();
        assert_ne!(old_key, key(&path));
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
            let (decoded, full, cache_only) =
                protocol_path(&format!("{host}/{encoded}?v=full&r=1")).unwrap();
            assert_eq!(decoded, path);
            assert!(full && !cache_only);
            let (_, full, cache_only) =
                protocol_path(&format!("{host}/{encoded}?cacheOnly=1")).unwrap();
            assert!(!full && cache_only);
            assert!(protocol_path(&format!("{host}/{encoded}?cacheOnly=yes")).is_err());
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
                    previews.get(path, false, false).await.unwrap();
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
        let previews_dir = dir.path().join("cache").join(crate::cache::DIRECTORY);
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
            fresh.get(path, false, false).await.unwrap().unwrap();
        }
        eprintln!("warm thumbnails alone: {:?}", start.elapsed());
    }
}
