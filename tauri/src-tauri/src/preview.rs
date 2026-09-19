use crate::{
    metadata::{is_jpeg, ExifTool},
    model::source_path,
};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const BUDGET: usize = 128 * 1024 * 1024;
type Image = Option<Arc<Vec<u8>>>;
#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Image)>,
    bytes: usize,
}

pub struct Previews {
    cache: Mutex<Cache>,
    flights: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    slots: Semaphore,
    thumbnail_slots: Semaphore,
    exif: Arc<ExifTool>,
}

impl Previews {
    pub fn new(exif: Arc<ExifTool>) -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            flights: AsyncMutex::new(HashMap::new()),
            slots: Semaphore::new(4),
            thumbnail_slots: Semaphore::new(3),
            exif,
        }
    }
    fn key(path: &Path, full: bool) -> Result<String, String> {
        source_path(path)?;
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        Ok(format!(
            "{full}:{}:{:?}:{}",
            meta.len(),
            meta.modified().map_err(|e| e.to_string())?,
            path.display()
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
            None => self.exif.preview(path, full).await.map(|b| b.map(Arc::new)),
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
    use crate::storage::Logs;
    use std::{future::Future, task::Poll};

    #[tokio::test]
    async fn waiting_thumbnails_leave_foreground_capacity_and_reuse_imported_previews() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.X3F");
        std::fs::write(&path, b"raw").unwrap();
        let previews = Previews::new(Arc::new(ExifTool::new(
            dir.path().into(),
            Arc::new(Logs::new(dir.path().join("logs"))),
        )));
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
}
