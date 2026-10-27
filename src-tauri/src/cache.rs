//! The shared preview cache: one disk store and one memory store for original
//! previews, edited previews and source metadata. Every entry is disposable. A
//! failed read or write is a miss, and Clear never touches edits or SFD RAWs.
use crate::storage::{write_bytes_atomic, Logs};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError, Weak,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The preview cache directory in the app cache directory.
pub const DIRECTORY: &str = "previews-v2";
/// The earlier embedded preview cache, beside `DIRECTORY`.
pub const LEGACY_PREVIEWS: &str = "previews-v1";
/// The earlier edited preview caches, in the app-data `edits` directory.
pub const LEGACY_THUMBNAILS: &str = "thumbnails-v1";
pub const LEGACY_MEDIUMS: &str = "mediums-v1";
/// The default disk limit in bytes, as the Settings window shows sizes.
pub const DEFAULT_LIMIT: u64 = 20_000_000_000;
/// The usual maximum entry size. Full-size JPEGs can use a larger bounded entry.
const ENTRY_LIMIT: u64 = 32 * 1024 * 1024;
fn entry_limit(name: &str) -> u64 {
    if name.ends_with(".native.jpg") {
        128 * 1024 * 1024
    } else {
        ENTRY_LIMIT
    }
}
const INDEX: &str = "index-v1.tsv";
const INDEX_LIMIT: u64 = 256 * 1024 * 1024;
const TRASH: &str = ".trash-";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Entries that one LRU position keeps together, such as the JPEG and metadata
/// of one original: the part of a name before its first dot.
fn group(name: &str) -> &str {
    let file = name.rsplit('/').next().unwrap_or(name);
    &name[..name.len() - file.len() + file.find('.').unwrap_or(file.len())]
}

/// Cache counters for debug logs and benchmarks.
#[derive(Default)]
pub struct Stats {
    pub memory_hits: AtomicU64,
    pub disk_hits: AtomicU64,
    pub misses: AtomicU64,
    pub adopted: AtomicU64,
    pub writes: AtomicU64,
    pub write_failures: AtomicU64,
    pub evicted: AtomicU64,
    pub derived_thumbnails: AtomicU64,
    pub renders: AtomicU64,
    pub dropped_persistence: AtomicU64,
}

impl Stats {
    pub fn add(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn summary(&self) -> String {
        let n = |c: &AtomicU64| c.load(Ordering::Relaxed);
        format!(
            "Preview cache: {} memory hits, {} disk hits, {} misses, {} adopted, {} writes, \
             {} write failures, {} evicted, {} derived thumbnails, {} renders, {} dropped",
            n(&self.memory_hits),
            n(&self.disk_hits),
            n(&self.misses),
            n(&self.adopted),
            n(&self.writes),
            n(&self.write_failures),
            n(&self.evicted),
            n(&self.derived_thumbnails),
            n(&self.renders),
            n(&self.dropped_persistence),
        )
    }
}

#[derive(Default)]
struct Group {
    tick: u64,
    files: Vec<(Arc<str>, u64)>,
}

struct State {
    enabled: bool,
    limit: u64,
    used: u64,
    groups: HashMap<Arc<str>, Group>,
    order: BTreeSet<(u64, Arc<str>)>,
    last_tick: u64,
    /// Files or sizes changed since the index was published.
    dirty: bool,
    /// Only the order changed. Order alone is published less often.
    touched: bool,
}

impl State {
    fn tick(&mut self) -> u64 {
        self.last_tick = now_ms().max(self.last_tick + 1);
        self.last_tick
    }

    /// Records `name` with `size` at `tick`.
    fn insert(&mut self, name: &str, size: u64, tick: u64) {
        let key: Arc<str> = group(name).into();
        let entry = self.groups.entry(key.clone()).or_default();
        match entry.files.iter_mut().find(|(n, _)| &**n == name) {
            Some((_, old)) => {
                self.dirty |= *old != size;
                self.used = self.used - *old + size;
                *old = size;
            }
            None => {
                entry.files.push((name.into(), size));
                self.used += size;
                self.dirty = true;
            }
        }
        let old = entry.tick;
        if tick > old {
            self.order.remove(&(old, key.clone()));
            self.groups.get_mut(&key).unwrap().tick = tick;
            self.touched = true;
        }
        let tick = self.groups[&key].tick;
        self.order.insert((tick, key));
    }

    fn remove(&mut self, name: &str) {
        let key = group(name);
        let Some(entry) = self.groups.get_mut(key) else {
            return;
        };
        if let Some(at) = entry.files.iter().position(|(n, _)| &**n == name) {
            self.used -= entry.files.swap_remove(at).1;
            self.dirty = true;
        }
        if entry.files.is_empty() {
            let (key, entry) = self.groups.remove_entry(key).unwrap();
            self.order.remove(&(entry.tick, key));
        }
    }

    /// Removes the least recently used groups, except `keep`, down to 90% of
    /// the limit. Returns their files for deletion outside the lock.
    fn evict(&mut self, keep: Option<&str>) -> Vec<Arc<str>> {
        let mut victims = vec![];
        if self.used <= self.limit {
            return victims;
        }
        let target = self.limit / 10 * 9;
        let mut kept = vec![];
        while self.used > target {
            let Some((tick, key)) = self.order.pop_first() else {
                break;
            };
            if Some(&*key) == keep {
                kept.push((tick, key));
                continue;
            }
            if let Some(entry) = self.groups.remove(&key) {
                for (name, size) in entry.files {
                    self.used -= size;
                    victims.push(name);
                }
            }
        }
        self.order.extend(kept);
        self.dirty |= !victims.is_empty();
        victims
    }
}

/// The disk store. Entries are files named by a hex key and an extension, in
/// two-character shard directories. An index keeps their sizes and their least
/// recently used order. Reads use the file system, not the index, so an entry
/// that the index lost is still a hit, and the index adopts it.
pub struct Store {
    root: PathBuf,
    legacy: Vec<(&'static str, PathBuf)>,
    state: Mutex<State>,
    /// Clear and Disable increment it. Work captures it when it starts, and
    /// cannot store entries after a later Clear or Disable.
    generation: AtomicU64,
    /// Serializes changes to the files: publication, adoption, deletion,
    /// Clear, reconciliation and the index. Reads do not take it.
    gate: Mutex<()>,
    pub logs: Arc<Logs>,
    pub stats: Stats,
}

impl Store {
    /// Opens the store and starts its maintenance thread: a reconciling scan,
    /// then index publication about once per second while entries change.
    pub fn open(
        root: PathBuf,
        legacy: Vec<(&'static str, PathBuf)>,
        enabled: bool,
        limit: u64,
        logs: Arc<Logs>,
    ) -> Arc<Self> {
        let store = Arc::new(Self::new(root, legacy, enabled, limit, logs));
        let weak = Arc::downgrade(&store);
        let _ = std::thread::Builder::new()
            .name("preview-cache".into())
            .spawn(move || maintain(weak));
        store
    }

    /// Opens the store from its index, without a maintenance thread.
    pub fn new(
        root: PathBuf,
        legacy: Vec<(&'static str, PathBuf)>,
        enabled: bool,
        limit: u64,
        logs: Arc<Logs>,
    ) -> Self {
        let mut state = State {
            enabled,
            limit,
            used: 0,
            groups: HashMap::new(),
            order: BTreeSet::new(),
            last_tick: 0,
            dirty: false,
            touched: false,
        };
        let store_legacy = legacy;
        let mut index = Vec::new();
        if let Ok(file) = fs::File::open(root.join(INDEX)) {
            let _ = file.take(INDEX_LIMIT).read_to_end(&mut index);
        }
        let valid = |name: &str| {
            name_valid(name)
                && (!name.contains('/')
                    || store_legacy
                        .iter()
                        .any(|(prefix, _)| name.split_once('/').unwrap().0 == *prefix))
        };
        for line in String::from_utf8_lossy(&index).lines() {
            let mut fields = line.splitn(3, '\t');
            let (Some(tick), Some(size), Some(name)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if let (Ok(tick), Ok(size)) = (tick.parse(), size.parse()) {
                if valid(name) {
                    state.insert(name, size, tick);
                    state.last_tick = state.last_tick.max(tick);
                }
            }
        }
        state.dirty = false;
        state.touched = false;
        Self {
            root,
            legacy: store_legacy,
            state: Mutex::new(state),
            generation: AtomicU64::new(0),
            gate: Mutex::new(()),
            logs,
            stats: Stats::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// The current generation. Capture it when work starts.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn current(&self, generation: u64) -> bool {
        self.generation() == generation
    }

    pub fn enabled(&self) -> bool {
        self.state().enabled
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        if !name_valid(name) {
            return None;
        }
        match name.split_once('/') {
            Some((prefix, file)) => self
                .legacy
                .iter()
                .find(|(p, _)| *p == prefix)
                .map(|(_, dir)| dir.join(file)),
            None => Some(self.root.join(&name[..2]).join(name)),
        }
    }

    /// Reads an entry. `valid` rejects a corrupt entry, which is removed. A
    /// valid legacy entry from `legacy` moves to `name`.
    pub fn get(
        &self,
        name: &str,
        legacy: &[String],
        valid: impl Fn(&[u8]) -> bool,
    ) -> Option<Vec<u8>> {
        let generation = self.generation();
        if !self.enabled() {
            return None;
        }
        for (index, candidate) in std::iter::once(name)
            .chain(legacy.iter().map(String::as_str))
            .enumerate()
        {
            let Some(path) = self.path(candidate) else {
                continue;
            };
            let started = self.state().last_tick;
            let bytes = match read_bounded(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        self.forget(candidate, started);
                    }
                    continue;
                }
            };
            if !valid(&bytes) {
                self.logs.write(
                    "error",
                    format!("Preview cache entry {}: invalid", path.display()),
                );
                // A repair can publish between the read and here; read again
                // under the gate, which publication also takes.
                let _gate = lock(&self.gate);
                if read_bounded(&path).is_ok_and(|bytes| !valid(&bytes)) {
                    let _ = fs::remove_file(&path);
                    self.state().remove(candidate);
                }
                continue;
            }
            let mut state = self.state();
            if !state.enabled || !self.current(generation) {
                return None;
            }
            let tick = state.tick();
            if index == 0 {
                // An eviction can delete the file after this read. Do not
                // record a file that is gone.
                if path.exists() {
                    state.insert(name, bytes.len() as u64, tick);
                }
                Stats::add(&self.stats.disk_hits);
                return Some(bytes);
            }
            drop(state);
            // Move the legacy file, so that it is not stored twice. A Clear
            // after this read removed it, and the bytes are only returned.
            let target = self.path(name)?;
            let _gate = lock(&self.gate);
            if self.current(generation) {
                let moved = target
                    .parent()
                    .is_some_and(|p| fs::create_dir_all(p).is_ok())
                    && fs::rename(&path, &target).is_ok();
                if !moved {
                    let _ = write_bytes_atomic(&target, &bytes, false);
                    let _ = fs::remove_file(&path);
                }
                let mut state = self.state();
                state.remove(candidate);
                if target.exists() {
                    state.insert(name, bytes.len() as u64, tick);
                }
            }
            Stats::add(&self.stats.adopted);
            Stats::add(&self.stats.disk_hits);
            return Some(bytes);
        }
        None
    }

    /// Removes the index record of a missing file that nothing wrote since `before`.
    fn forget(&self, name: &str, before: u64) {
        let mut state = self.state();
        if state
            .groups
            .get(group(name))
            .is_some_and(|g| g.tick <= before)
        {
            state.remove(name);
        }
    }

    /// Stores an entry for work that started at `generation`. Returns false when
    /// the cache is disabled, a Clear or Disable came later, or the write failed.
    pub fn put(&self, generation: u64, name: &str, bytes: &[u8]) -> bool {
        let Some(path) = self.path(name).filter(|_| !name.contains('/')) else {
            return false;
        };
        if bytes.len() as u64 > entry_limit(name) {
            return false;
        }
        {
            let state = self.state();
            if !state.enabled || !self.current(generation) {
                return false;
            }
        }
        // Write the bytes outside the gate, then publish them under it.
        let temp = (|| -> std::io::Result<tempfile::NamedTempFile> {
            let parent = path
                .parent()
                .ok_or_else(|| std::io::Error::other("No parent"))?;
            fs::create_dir_all(parent)?;
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            std::io::Write::write_all(&mut temp, bytes)?;
            Ok(temp)
        })();
        let temp = match temp {
            Ok(temp) => temp,
            Err(error) => {
                Stats::add(&self.stats.write_failures);
                self.logs.write(
                    "debug",
                    format!("Preview cache write {}: {error}", path.display()),
                );
                return false;
            }
        };
        let _gate = lock(&self.gate);
        if !self.enabled() || !self.current(generation) {
            return false;
        }
        if temp.persist(&path).is_err() {
            Stats::add(&self.stats.write_failures);
            return false;
        }
        let victims = {
            let mut state = self.state();
            let tick = state.tick();
            state.insert(name, bytes.len() as u64, tick);
            state.evict(Some(group(name)))
        };
        Stats::add(&self.stats.writes);
        self.delete(victims);
        true
    }

    /// Deletes evicted files. Call it with the gate, so that no write can
    /// store one of them again in between.
    fn delete(&self, victims: Vec<Arc<str>>) {
        for name in victims {
            if let Some(path) = self.path(&name) {
                let _ = fs::remove_file(path);
            }
            Stats::add(&self.stats.evicted);
        }
    }

    /// Disable keeps the files until Clear. A lower limit evicts at once.
    pub fn configure(&self, enabled: bool, limit: u64) {
        let _gate = lock(&self.gate);
        let mut state = self.state();
        if state.enabled && !enabled {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        state.enabled = enabled;
        state.limit = limit;
        let victims = state.evict(None);
        drop(state);
        self.delete(victims);
    }

    /// The bytes of all entries, legacy entries included.
    pub fn size(&self) -> u64 {
        self.state().used
    }

    /// Removes all preview entries: this store and the legacy preview
    /// directories only. Work that started before it cannot store entries.
    pub fn clear(&self) -> Result<(), String> {
        let mut directories = vec![self.root.clone()];
        directories.extend(self.legacy.iter().map(|(_, dir)| dir.clone()));
        let mut doomed = vec![];
        let mut result = Ok(());
        {
            let _gate = lock(&self.gate);
            for directory in directories {
                // A rename is quick. Work that starts after the generation
                // changes below writes to new directories.
                let trash = directory.with_file_name(format!(
                    "{}{}{}",
                    directory
                        .file_name()
                        .map_or_else(Default::default, |n| n.to_string_lossy()),
                    TRASH,
                    uuid::Uuid::new_v4()
                ));
                match fs::rename(&directory, &trash) {
                    Ok(()) => doomed.push(trash),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    // Remove in place, before new work can write there.
                    Err(_) => {
                        if let Err(error) = fs::remove_dir_all(&directory) {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                result = Err(error.to_string());
                            }
                        }
                    }
                }
            }
            let mut state = self.state();
            self.generation.fetch_add(1, Ordering::SeqCst);
            state.groups.clear();
            state.order.clear();
            state.used = 0;
            state.dirty = false;
            state.touched = false;
        }
        for trash in doomed {
            if let Err(error) = fs::remove_dir_all(&trash) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    result = Err(error.to_string());
                }
            }
        }
        result
    }

    /// Publishes the index when entries or their order changed.
    pub fn flush(&self) {
        self.publish(true);
    }

    /// Publishes the index when entries changed, or with `order`, when only
    /// their order changed.
    fn publish(&self, order: bool) {
        let _gate = lock(&self.gate);
        let (lines, generation) = {
            let mut state = self.state();
            if !(state.dirty || (order && state.touched)) {
                return;
            }
            state.dirty = false;
            state.touched = false;
            let lines: Vec<_> = state
                .order
                .iter()
                .flat_map(|(tick, key)| {
                    state.groups[key]
                        .files
                        .iter()
                        .map(move |(name, size)| (*tick, *size, name.clone()))
                })
                .collect();
            (lines, self.generation())
        };
        let mut text = String::with_capacity(lines.len() * 96);
        for (tick, size, name) in lines {
            text.push_str(&format!("{tick}\t{size}\t{name}\n"));
        }
        if !self.current(generation)
            || write_bytes_atomic(&self.root.join(INDEX), text.as_bytes(), false).is_err()
        {
            self.state().dirty = true;
        }
    }

    /// Counts unindexed files, legacy files included, and forgets index records
    /// of files that are gone. Then applies the limit. It runs once at startup,
    /// off the request path, and removes trash that an interrupted Clear left.
    pub fn reconcile(&self) {
        let scan = self.scan();
        self.merge(scan);
    }

    fn scan(&self) -> Scan {
        let generation = self.generation();
        let started = now_ms();
        let mut found = Vec::new();
        let mut trash = Vec::new();
        let mut directories = vec![self.root.clone()];
        directories.extend(self.legacy.iter().map(|(_, dir)| dir.clone()));
        for directory in &directories {
            if let Some(parent) = directory.parent() {
                for entry in fs::read_dir(parent).into_iter().flatten().flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if directory.file_name().is_some_and(|d| {
                        name.starts_with(&format!("{}{TRASH}", d.to_string_lossy()))
                    }) {
                        trash.push(entry.path());
                    }
                }
            }
        }
        for path in trash {
            let _ = fs::remove_dir_all(path);
        }
        let mut file = |prefix: Option<&str>, entry: fs::DirEntry| {
            let Ok(meta) = entry.metadata() else { return };
            let file = entry.file_name().to_string_lossy().into_owned();
            let name = prefix.map_or_else(|| file.clone(), |p| format!("{p}/{file}"));
            if meta.is_file() && name_valid(&name) {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                found.push((name, meta.len(), modified));
            }
        };
        for shard in fs::read_dir(&self.root).into_iter().flatten().flatten() {
            if shard.file_name().len() == 2 {
                for entry in fs::read_dir(shard.path()).into_iter().flatten().flatten() {
                    file(None, entry);
                }
            }
        }
        for (prefix, directory) in &self.legacy {
            for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
                file(Some(prefix), entry);
            }
        }
        Scan {
            generation,
            started,
            found,
        }
    }

    /// Merges a scan, unless a Clear came after it.
    fn merge(&self, scan: Scan) {
        let Scan {
            generation,
            started,
            found,
        } = scan;
        let _gate = lock(&self.gate);
        if !self.current(generation) {
            return;
        }
        let names: std::collections::HashSet<&str> =
            found.iter().map(|(name, _, _)| name.as_str()).collect();
        let mut state = self.state();
        let gone: Vec<Arc<str>> = state
            .groups
            .values()
            .filter(|g| g.tick < started)
            .flat_map(|g| g.files.iter().map(|(name, _)| name.clone()))
            .filter(|name| !names.contains(&**name))
            .collect();
        for name in gone {
            state.remove(&name);
        }
        // Short lock holds, so that reads during a large merge do not wait long.
        for (index, (name, size, modified)) in found.iter().enumerate() {
            if index % 4096 == 4095 {
                drop(state);
                state = self.state();
            }
            let known = state
                .groups
                .get(group(name))
                .and_then(|g| g.files.iter().find(|(n, _)| &**n == name).map(|_| g.tick));
            match known {
                Some(tick) if tick >= started => {}
                // Keep the index order and correct the size.
                Some(tick) => state.insert(name, *size, tick),
                None => state.insert(name, *size, (*modified).min(started)),
            }
        }
        let victims = state.evict(None);
        drop(state);
        self.delete(victims);
    }

    /// Writes `message()` to the debug log when debug logging is on.
    pub fn debug(&self, message: impl FnOnce() -> String) {
        if self.logs.debug.load(Ordering::Relaxed) {
            self.logs.write("debug", message());
        }
    }
}

struct Scan {
    generation: u64,
    started: u64,
    found: Vec<(String, u64, u64)>,
}

impl Drop for Store {
    fn drop(&mut self) {
        self.flush();
    }
}

fn maintain(store: Weak<Store>) {
    match store.upgrade() {
        Some(store) => store.reconcile(),
        None => return,
    }
    let mut last = String::new();
    let mut published = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(store) = store.upgrade() else {
            return;
        };
        // Writes and evictions publish within a second. Hits change only the
        // order: publish that every 30 seconds, not on each browsing second.
        let order = published.elapsed() >= Duration::from_secs(30);
        store.publish(order);
        if order {
            published = Instant::now();
        }
        if store.logs.debug.load(Ordering::Relaxed) {
            let summary = store.stats.summary();
            if summary != last {
                store.logs.write("debug", &summary);
                last = summary;
            }
        }
    }
}

/// A key and extension, or a legacy prefix and file name.
fn name_valid(name: &str) -> bool {
    let file = match name.split_once('/') {
        Some((prefix, file)) => {
            if prefix.is_empty()
                || !prefix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return false;
            }
            file
        }
        None => name,
    };
    file.len() >= 3
        && file.len() <= 160
        && !file.starts_with('.')
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        && file.bytes().take(2).all(|b| b.is_ascii_alphanumeric())
}

fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let limit = path
        .file_name()
        .and_then(|name| name.to_str())
        .map_or(ENTRY_LIMIT, entry_limit);
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::other("Preview cache entry is too large"));
    }
    Ok(bytes)
}

/// The total memory budget for retained image buffers: 10% of physical memory
/// from 512 MiB to 4 GiB, or 1 GiB when the physical memory is unknown. The
/// backend and the frontend each take half of it.
pub fn memory_budget() -> u64 {
    const MIB: u64 = 1024 * 1024;
    physical_memory().map_or(1024 * MIB, |bytes| {
        (bytes / 10).clamp(512 * MIB, 4096 * MIB)
    })
}

#[cfg(target_os = "macos")]
fn physical_memory() -> Option<u64> {
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            old: *mut std::ffi::c_void,
            old_length: *mut usize,
            new: *mut std::ffi::c_void,
            new_length: usize,
        ) -> i32;
    }
    let mut bytes = 0_u64;
    let mut length = std::mem::size_of::<u64>();
    let status = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && bytes > 0).then_some(bytes)
}

#[cfg(target_os = "linux")]
fn physical_memory() -> Option<u64> {
    let text = fs::read_to_string("/proc/meminfo").ok()?;
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

#[cfg(windows)]
fn physical_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status: MemoryStatus = unsafe { std::mem::zeroed() };
    status.length = std::mem::size_of::<MemoryStatus>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.total_physical)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn physical_memory() -> Option<u64> {
    None
}

struct Retained {
    tick: u64,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<String, Retained>,
    order: BTreeSet<(u64, String)>,
    /// Keys per buffer, so that one buffer under two keys counts once.
    buffers: HashMap<usize, usize>,
    bytes: usize,
    tick: u64,
}

/// Encoded originals, PNGs and raw frames in memory, least recently used out.
/// A buffer that a request still holds stays until it is released.
pub struct Memory {
    budget: usize,
    state: Mutex<MemoryState>,
}

impl Memory {
    pub fn new(budget: u64) -> Self {
        Self {
            budget: budget as usize,
            state: Mutex::new(MemoryState::default()),
        }
    }

    pub fn get(&self, key: &str) -> Option<Arc<Vec<u8>>> {
        let mut state = lock(&self.state);
        state.tick += 1;
        let tick = state.tick;
        let entry = state.entries.get_mut(key)?;
        let old = std::mem::replace(&mut entry.tick, tick);
        let bytes = entry.bytes.clone();
        state.order.remove(&(old, key.to_owned()));
        state.order.insert((tick, key.to_owned()));
        Some(bytes)
    }

    pub fn put(&self, key: String, bytes: Arc<Vec<u8>>) {
        self.put_if(key, bytes, || true);
    }

    /// Stores the buffer while `admit()` holds, checked under the memory lock.
    pub fn put_if(&self, key: String, bytes: Arc<Vec<u8>>, admit: impl FnOnce() -> bool) {
        if bytes.len() > self.budget / 4 {
            return;
        }
        let mut state = lock(&self.state);
        if !admit() {
            return;
        }
        Self::remove_locked(&mut state, &key);
        state.tick += 1;
        let tick = state.tick;
        let buffer = Arc::as_ptr(&bytes) as usize;
        let count = state.buffers.entry(buffer).or_default();
        *count += 1;
        if *count == 1 {
            state.bytes += bytes.len();
        }
        state.order.insert((tick, key.clone()));
        state.entries.insert(key, Retained { tick, bytes });
        if state.bytes > self.budget {
            // Oldest first, until enough bytes are free. A buffer in use costs
            // memory anyway, so evicting it frees nothing. A buffer under more
            // keys is free only after all its keys go.
            let excess = state.bytes - self.budget;
            let (mut freed, mut victims) = (0, vec![]);
            let mut aliases: HashMap<usize, usize> = HashMap::new();
            for (_, key) in &state.order {
                if freed >= excess {
                    break;
                }
                let bytes = &state.entries[key].bytes;
                let buffer = Arc::as_ptr(bytes) as usize;
                let keys = state.buffers[&buffer];
                if Arc::strong_count(bytes) > keys {
                    continue;
                }
                victims.push(key.clone());
                let removed = aliases.entry(buffer).or_default();
                *removed += 1;
                if *removed == keys {
                    freed += bytes.len();
                }
            }
            for victim in victims {
                Self::remove_locked(&mut state, &victim);
            }
        }
    }

    fn remove_locked(state: &mut MemoryState, key: &str) {
        let Some(old) = state.entries.remove(key) else {
            return;
        };
        state.order.remove(&(old.tick, key.to_owned()));
        let buffer = Arc::as_ptr(&old.bytes) as usize;
        if let Some(count) = state.buffers.get_mut(&buffer) {
            *count -= 1;
            if *count == 0 {
                state.buffers.remove(&buffer);
                state.bytes -= old.bytes.len();
            }
        }
    }

    pub fn clear(&self) {
        *lock(&self.state) = MemoryState::default();
    }

    pub fn bytes(&self) -> usize {
        lock(&self.state).bytes
    }
}

/// The stable identity of a source file's current contents for previews: the
/// SHA-256 of its canonical path and `SourceStamp`, and the decoder identity.
/// On Unix the stamp has the device, inode and change time, so a replaced file
/// gets another key. On Windows it has only the size and the modified and
/// created times. It is not a content fingerprint.
pub fn source_key(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let canonical = path.canonicalize().ok()?;
    let stamp = crate::edits::SourceStamp::new(&fs::metadata(&canonical).ok()?).ok()?;
    let mut bytes = serde_json::to_vec(&(&canonical, stamp)).ok()?;
    bytes.extend(crate::source::decoder_identity(&canonical).as_bytes());
    Some(format!("{:x}", Sha256::digest(bytes)))
}

/// Elapsed milliseconds, for debug timing.
pub fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path, limit: u64) -> Store {
        Store::new(
            dir.join(DIRECTORY),
            vec![(LEGACY_MEDIUMS, dir.join("edits").join(LEGACY_MEDIUMS))],
            true,
            limit,
            Arc::new(Logs::new(dir.join("logs"))),
        )
    }

    fn name(n: u8, extension: &str) -> String {
        format!("{}.{extension}", format!("{n:02x}").repeat(32))
    }

    fn any(_: &[u8]) -> bool {
        true
    }

    #[test]
    fn native_jpegs_can_exceed_the_normal_entry_limit() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), DEFAULT_LIMIT);
        let bytes = vec![0; ENTRY_LIMIT as usize + 1];
        assert!(!cache.put(cache.generation(), &name(1, "png"), &bytes));
        let native = name(1, "native.jpg");
        assert!(cache.put(cache.generation(), &native, &bytes));
        assert_eq!(cache.get(&native, &[], any).unwrap().len(), bytes.len());
        cache.clear().unwrap();
        assert!(cache.get(&native, &[], any).is_none());
    }

    #[test]
    fn eviction_is_least_recently_used_by_group_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), 1000);
        let g = cache.generation();
        // One group: the JPEG and metadata of an original go together.
        assert!(cache.put(g, &name(1, "jpg"), &[1; 300]));
        assert!(cache.put(g, &name(1, "json"), &[1; 100]));
        assert!(cache.put(g, &name(2, "jpg"), &[2; 300]));
        assert_eq!(cache.size(), 700);
        // A read renews the group.
        assert!(cache.get(&name(1, "json"), &[], any).is_some());
        assert!(cache.put(g, &name(3, "jpg"), &[3; 400]));
        assert_eq!(cache.size(), 800);
        assert!(cache.get(&name(2, "jpg"), &[], any).is_none());
        assert!(cache.get(&name(1, "jpg"), &[], any).is_some());
        // Replacing an entry counts its bytes once.
        assert!(cache.put(g, &name(3, "jpg"), &[3; 400]));
        assert_eq!(cache.size(), 800);
        cache.flush();
        drop(cache);

        let reopened = store(dir.path(), 1000);
        assert_eq!(reopened.size(), 800);
        reopened.reconcile();
        assert_eq!(reopened.size(), 800);
        // The order survives too: group 1 was used before group 3.
        reopened.configure(true, 500);
        assert_eq!(reopened.size(), 400);
        assert!(reopened.get(&name(3, "jpg"), &[], any).is_some());
        assert!(reopened.get(&name(1, "jpg"), &[], any).is_none());
    }

    #[test]
    fn reconcile_counts_lost_and_legacy_files_and_forgets_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), 1 << 20);
        let g = cache.generation();
        cache.put(g, &name(1, "png"), &[1; 10]);
        cache.put(g, &name(2, "png"), &[2; 20]);
        cache.flush();
        drop(cache);
        // A write after the last index publication, a removed file, and a legacy file.
        let lost = dir.path().join(DIRECTORY).join("03").join(name(3, "png"));
        fs::create_dir_all(lost.parent().unwrap()).unwrap();
        fs::write(&lost, [3; 30]).unwrap();
        fs::remove_file(dir.path().join(DIRECTORY).join("01").join(name(1, "png"))).unwrap();
        let legacy = dir.path().join("edits").join(LEGACY_MEDIUMS);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(name(4, "png")), [4; 40]).unwrap();
        let cache = store(dir.path(), 1 << 20);
        cache.reconcile();
        assert_eq!(cache.size(), 20 + 30 + 40);
        // Adoption moves the legacy file and keeps one count.
        let old = vec![format!("{LEGACY_MEDIUMS}/{}", name(4, "png"))];
        assert_eq!(cache.get(&name(4, "png"), &old, any).unwrap(), [4; 40]);
        assert_eq!(cache.size(), 90);
        assert!(!legacy.join(name(4, "png")).exists());
        // Names outside the store are never paths.
        for bad in ["../x.png", "a/b.png", "mediums-v1/../x.png", ".hidden"] {
            assert!(cache.path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn clear_removes_only_preview_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), 1 << 20);
        let edits = dir.path().join("edits");
        let legacy = edits.join(LEGACY_MEDIUMS);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(name(4, "png")), [4]).unwrap();
        fs::create_dir_all(edits.join("x3i-v1")).unwrap();
        fs::write(edits.join("x3i-v1").join("scene"), b"SFD RAW").unwrap();
        fs::write(edits.join("backup.json"), b"saved edits").unwrap();
        cache.put(cache.generation(), &name(1, "png"), &[1]);
        cache.clear().unwrap();
        assert_eq!(cache.size(), 0);
        assert!(!dir.path().join(DIRECTORY).exists() && !legacy.exists());
        assert_eq!(fs::read(edits.join("backup.json")).unwrap(), b"saved edits");
        assert_eq!(fs::read(edits.join("x3i-v1/scene")).unwrap(), b"SFD RAW");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(TRASH)));
    }

    #[test]
    fn work_from_before_clear_cannot_replace_or_count_newer_entries() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), 1 << 20);
        let old = cache.generation();
        cache.put(old, &name(1, "png"), b"old");
        // A scan from before Clear does not come back after it.
        let scan = cache.scan();
        cache.clear().unwrap();
        let new = cache.generation();
        assert!(cache.put(new, &name(1, "png"), b"new"));
        cache.merge(scan);
        assert_eq!(cache.size(), 3);
        // A writer that started before Clear cannot replace the newer entry.
        assert!(!cache.put(old, &name(1, "png"), b"stale"));
        assert_eq!(cache.get(&name(1, "png"), &[], any).unwrap(), b"new");
        assert_eq!(cache.size(), 3);
        // Disable stops older and current work; Enable allows new work only.
        cache.configure(false, 1 << 20);
        assert!(!cache.put(new, &name(2, "png"), b"x"));
        assert!(cache.get(&name(1, "png"), &[], any).is_none());
        cache.configure(true, 1 << 20);
        assert!(!cache.put(new, &name(2, "png"), b"x"));
        assert!(cache.put(cache.generation(), &name(2, "png"), b"x"));
    }

    #[test]
    fn corrupt_entries_and_write_failures_are_misses() {
        let dir = tempfile::tempdir().unwrap();
        let cache = store(dir.path(), 1 << 20);
        let g = cache.generation();
        cache.put(g, &name(1, "png"), b"corrupt");
        assert!(cache.get(&name(1, "png"), &[], |b| b == b"valid").is_none());
        assert_eq!(cache.size(), 0);
        assert!(cache.put(g, &name(1, "png"), b"valid"));
        assert!(cache.get(&name(1, "png"), &[], |b| b == b"valid").is_some());
        // A file where a shard directory must go: the write fails, nothing counts.
        fs::write(dir.path().join(DIRECTORY).join("02"), b"blocker").unwrap();
        assert!(!cache.put(g, &name(2, "png"), b"lost"));
        assert_eq!(cache.size(), 5);
        assert_eq!(cache.stats.write_failures.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn memory_counts_shared_buffers_once_and_keeps_buffers_in_use() {
        let memory = Memory::new(400);
        let shared = Arc::new(vec![0; 100]);
        memory.put("preview".into(), shared.clone());
        memory.put("full".into(), shared.clone());
        assert_eq!(memory.bytes(), 100);
        drop(shared);
        let held = Arc::new(vec![1; 100]);
        memory.put("held".into(), held.clone());
        for n in 0..4 {
            memory.put(format!("idle-{n}"), Arc::new(vec![2; 100]));
        }
        assert!(memory.bytes() <= 400 + 100);
        assert!(memory.get("held").is_some(), "A buffer in use stays");
        assert!(memory.get("preview").is_none() && memory.get("full").is_none());
        assert!(memory.get("idle-3").is_some());
        // An entry over a quarter of the budget is not kept.
        memory.put("large".into(), Arc::new(vec![0; 101]));
        assert!(memory.get("large").is_none());
        // `put_if` checks under the memory lock.
        memory.put_if("late".into(), Arc::new(vec![0; 1]), || false);
        assert!(memory.get("late").is_none());
        memory.clear();
        assert_eq!(memory.bytes(), 0);
        let budget = memory_budget();
        assert!((512 << 20..=4096 << 20).contains(&budget));
    }
}
