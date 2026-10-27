//! One RAW preparation/GPU worker shared by interactive previews and edited exports.
pub use crate::edits::EditRecord;
use crate::{
    cache::{ms, Memory, Stats, Store},
    edits::Edits,
    model::{source_path, BatchSettings, ColorProfile, OutputFormat},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Reverse,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
};
use x3f_core::{SceneLinearImage, SceneLinearOptions};
use x3f_render::{Crop, DngDemosaic, EditRecipe, PreparedImage, RenderOptions, Renderer};

/// Runs RAW preparation. On macOS it runs in a pool at utility QoS. At the
/// default QoS it takes the cores that WebKit needs to draw frames, and the
/// developing cloud skips frames. Batch conversion keeps the global pool.
fn prepare_in_background<R: Send>(work: impl FnOnce() -> R + Send) -> R {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
        }
        const QOS_CLASS_UTILITY: u32 = 0x11;
        static POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
        let pool = POOL.get_or_init(|| {
            rayon::ThreadPoolBuilder::new()
                .thread_name(|index| format!("raw-prepare-{index}"))
                .start_handler(|_| unsafe {
                    pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
                })
                .build()
                .ok()
        });
        if let Some(pool) = pool {
            return pool.install(work);
        }
    }
    work()
}

#[derive(Clone)]
struct Session {
    id: String,
    path: PathBuf,
    source_revision: String,
    cancelled_revision: Option<u64>,
}
struct Prepared {
    path: PathBuf,
    source_revision: String,
    denoise: u8,
    denoise_options: x3f_core::DenoiseOptions,
    dng_demosaic: Option<DngDemosaic>,
    /// Denoise settings do not change this source, as for a merged X3I.
    denoise_free: bool,
    x3i_source: x3f_core::X3iSource,
    image: PreparedImage,
}
impl Prepared {
    fn matches_preparation(&self, recipe: &EditRecipe) -> bool {
        self.dng_demosaic == recipe.dng_demosaic
            && (self.denoise_free
                || (self.denoise == recipe.denoise
                    && self.denoise_options == recipe.denoise_options))
    }
    fn matches_source(&self, path: &Path, source_revision: &str, recipe: &EditRecipe) -> bool {
        self.path == path
            && self.source_revision == source_revision
            && self.x3i_source == recipe.x3i_source
    }
}
#[derive(Default)]
struct Worker {
    renderer: Option<Renderer>,
    prepared: Option<Prepared>,
}
#[derive(Default)]
struct PreviewWork {
    foreground: usize,
    background_cancel: Arc<AtomicBool>,
    background_request: Option<String>,
    /// The priority of the running background render.
    background_priority: Option<u8>,
    /// Background requests that wait for the worker: the highest priority
    /// first, then the oldest.
    waiting: BTreeSet<(Reverse<u8>, u64)>,
    next_waiter: u64,
}
/// A background request's place in `PreviewWork::waiting`, until it drops.
struct Waiter<'a> {
    gate: &'a PreviewGate,
    place: (Reverse<u8>, u64),
}
impl<'a> Waiter<'a> {
    fn new(gate: &'a PreviewGate, priority: u8) -> Result<Self, String> {
        let mut work = gate.0.lock().map_err(|_| "Renderer unavailable")?;
        let place = (Reverse(priority), work.next_waiter);
        work.next_waiter += 1;
        work.waiting.insert(place);
        Ok(Self { gate, place })
    }
    fn first(&self, work: &PreviewWork) -> bool {
        work.waiting.first() == Some(&self.place)
    }
}
impl Drop for Waiter<'_> {
    fn drop(&mut self) {
        if let Ok(mut work) = self.gate.0.lock() {
            work.waiting.remove(&self.place);
            self.gate.1.notify_all();
        }
    }
}
/// Background request priorities, from the `priority` query parameter.
pub const PRIORITY_LOW: u8 = 0;
pub const PRIORITY_NORMAL: u8 = 1;
pub const PRIORITY_HIGH: u8 = 2;
type PreviewGate = Arc<(Mutex<PreviewWork>, Condvar)>;
struct ForegroundRequest {
    gate: PreviewGate,
}
impl Drop for ForegroundRequest {
    fn drop(&mut self) {
        if let Ok(mut work) = self.gate.0.lock() {
            work.foreground -= 1;
            self.gate.1.notify_all();
        }
    }
}
#[derive(Clone)]
struct Asset {
    path: PathBuf,
    source_revision: String,
    recipe: EditRecipe,
    max_edge: u32,
    region: Option<Crop>,
}
#[derive(Default)]
struct Assets {
    recipes: HashMap<String, Asset>,
    recipe_order: VecDeque<String>,
    /// IDs that rendered as drafts. Their pixels are not persisted.
    drafts: HashSet<String>,
}
impl Assets {
    fn insert(&mut self, id: String, asset: Asset) {
        if self.recipes.contains_key(&id) {
            return;
        }
        self.recipes.insert(id.clone(), asset);
        self.recipe_order.push_back(id);
        // shortcut: snapshots expire at this limit, renew URLs through editor:preview.
        while self.recipes.len() > 16384 {
            if let Some(old) = self.recipe_order.pop_front() {
                self.recipes.remove(&old);
                self.drafts.remove(&old);
            }
        }
    }
}
/// A final frame whose large preview and thumbnail are not yet on disk.
struct Persist {
    id: String,
    frame: Arc<Vec<u8>>,
    /// The PNG of the frame, when a request encoded it already.
    png: Option<Arc<Vec<u8>>>,
    generation: u64,
    path: PathBuf,
    source_revision: String,
}
/// A disk write: the generation it started at, the entry name and the bytes.
type DiskWrite = (u64, String, Arc<Vec<u8>>);
impl Persist {
    fn bytes(&self) -> usize {
        self.frame.len() + self.png.as_ref().map_or(0, |png| png.len())
    }
}
/// The edge of a browsing thumbnail, derived from a final preview.
const THUMBNAIL_EDGE: u32 = 640;
/// Marks a full-size preview. GPU work still uses tiles.
const NATIVE_EDGE: u32 = u32::MAX;

fn native_id(id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("native:{id}")))
}

fn frame_key(id: &str) -> String {
    format!("edit-frame:{id}")
}
fn png_key(id: &str) -> String {
    format!("edit-png:{id}")
}
fn thumbnail_key(id: &str) -> String {
    format!("edit-thumbnail:{id}")
}
/// The disk name of the PNG of a final preview.
fn medium_name(id: &str) -> String {
    format!("{id}.png")
}
fn native_name(id: &str) -> String {
    format!("{id}.native.jpg")
}
/// The disk name of the thumbnail derived from the final preview `id`. Direct
/// 640-pixel renders have other IDs and are not persisted.
fn thumbnail_name(id: &str) -> String {
    format!("{id}-t{THUMBNAIL_EDGE}.png")
}
/// Large previews of earlier builds had the same IDs. Earlier thumbnails mixed
/// direct and derived renders under one ID, so they are not adopted.
fn legacy_medium(id: &str) -> Vec<String> {
    vec![format!("{}/{id}.png", crate::cache::LEGACY_MEDIUMS)]
}
fn png_valid(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE) && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82")
}
fn jpeg_valid(bytes: &[u8]) -> bool {
    crate::metadata::is_jpeg(bytes) && bytes.ends_with(&[0xff, 0xd9])
}
/// A decoded `x3f-edit` URL.
struct ImageQuery {
    id: String,
    native_of: Option<String>,
    region: Option<Crop>,
    thumbnail: bool,
    raw: bool,
    cache_only: bool,
    priority: u8,
}
pub struct Editor {
    pub edits: Edits,
    session: Mutex<Option<Session>>,
    worker: Mutex<Worker>,
    preview_work: PreviewGate,
    preview_cancel: Mutex<Arc<AtomicBool>>,
    /// The photo that `warm` prepares or prepared last, and its cancellation.
    warm: Mutex<Option<(PathBuf, Arc<AtomicBool>)>>,
    opening: AtomicU64,
    render_revision: AtomicU64,
    assets: Mutex<Assets>,
    /// Frames whose large previews and thumbnails are not yet persisted.
    pending: Mutex<VecDeque<Persist>>,
    /// Derived thumbnails and encoded PNGs that wait for a disk write.
    writes: Mutex<Vec<DiskWrite>>,
    image_requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub store: Arc<Store>,
    memory: Arc<Memory>,
    /// Cached X3I frame copies and merged scenes.
    x3i: PathBuf,
    /// The last merge that `x3i_process` started for each X3I.
    x3i_jobs: Mutex<HashMap<PathBuf, Arc<X3iJob>>>,
    pub paused: AtomicBool,
    close_allowed: AtomicBool,
    close_gate: Mutex<()>,
    pub saving: AtomicUsize,
    pub has_edit_activity: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSession {
    pub session_id: String,
    pub path: PathBuf,
    pub recipe: EditRecipe,
    pub as_shot_crop: Option<Crop>,
    pub camera_profiles: Vec<x3f_render::CameraProfile>,
    pub as_shot_camera_profile: Option<String>,
    pub source_kind: crate::source::Kind,
    pub capabilities: crate::source::Capabilities,
    pub revision: u64,
    pub source_revision: String,
    pub storage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    /// For an X3I photo, whether it can render yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x3i: Option<X3iStatus>,
}

/// The merge state of an X3I. The editor renders it only after a merge.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct X3iStatus {
    pub frames: u32,
    /// The merged scene is in the cache.
    pub processed: bool,
    /// The file name of the cached merged scene.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The size of the cached merged scene.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// 0 through 1 while a merge runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
    /// Why the last merge failed. A cancelled merge has no error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A registered X3I merge. See `Editor::x3i_begin`.
pub struct X3iMerge {
    path: PathBuf,
    job: Arc<X3iJob>,
}

/// A merge that `Editor::x3i_process` runs.
#[derive(Default)]
struct X3iJob {
    cancel: AtomicBool,
    /// Core stage events so far, of `stages`.
    done: AtomicU32,
    stages: u32,
    /// None while the merge runs.
    result: Mutex<Option<Result<(), String>>>,
}
impl X3iJob {
    /// The progress, while the merge runs.
    fn progress(&self) -> Option<f32> {
        let running = self.result.lock().is_ok_and(|result| result.is_none());
        let done = self.done.load(Ordering::Relaxed) as f32 / self.stages.max(1) as f32;
        running.then_some(done.min(0.99))
    }
    fn error(&self) -> Option<String> {
        if self.cancel.load(Ordering::SeqCst) {
            return None;
        }
        self.result.lock().ok()?.clone()?.err()
    }
}

/// Sensor preparation for a recipe. The editor always recovers highlights.
fn scene_options(recipe: &EditRecipe) -> SceneLinearOptions {
    SceneLinearOptions {
        denoise_intensity: recipe.denoise,
        denoise_options: recipe.denoise_options,
        highlight_recovery: true,
        x3i_source: recipe.x3i_source,
        ..Default::default()
    }
}

/// The options of the merged scene of an X3I, whichever frames `recipe` uses.
fn merge_options(recipe: &EditRecipe) -> SceneLinearOptions {
    SceneLinearOptions {
        x3i_source: x3f_core::X3iSource::Merge,
        ..scene_options(recipe)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub session_id: String,
    pub recipe: EditRecipe,
    pub revision: u64,
    pub max_edge: u32,
    pub region: Option<Crop>,
    /// Reuse the current source, or skip BM3D for a first frame. Refinement is exact.
    #[serde(default)]
    pub interactive: bool,
}
pub(crate) struct RenderJob {
    request: RenderRequest,
    session: Session,
    cancel: Arc<AtomicBool>,
    priority: ForegroundRequest,
}

/// An `x3f-edit` response: 200 with an edited preview, which never changes
/// for its URL, or 400 with an error message.
pub struct Body {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPreview {
    session_id: String,
    revision: u64,
    url: String,
    width: u32,
    height: u32,
    full_width: u32,
    full_height: u32,
    source_width: u32,
    source_height: u32,
    region: Option<Crop>,
    draft: bool,
    as_shot_temperature: Option<f32>,
    as_shot_tint: Option<f32>,
    /// Raw color layer gains for the camera's own white balance.
    as_shot_gains: Option<[f32; 3]>,
    white_balance: Option<x3f_render::WhiteBalance>,
}

impl Editor {
    /// An editor with its own preview cache in `directory`, as for tests.
    pub fn new(directory: PathBuf) -> Self {
        let logs = Arc::new(crate::storage::Logs::new(directory.join("logs")));
        let store = Store::open(
            directory.join(crate::cache::DIRECTORY),
            vec![
                (
                    crate::cache::LEGACY_THUMBNAILS,
                    directory.join(crate::cache::LEGACY_THUMBNAILS),
                ),
                (
                    crate::cache::LEGACY_MEDIUMS,
                    directory.join(crate::cache::LEGACY_MEDIUMS),
                ),
            ],
            true,
            crate::cache::DEFAULT_LIMIT,
            logs,
        );
        let memory = Arc::new(Memory::new(crate::cache::memory_budget() / 2));
        Self::with_cache(directory, store, memory)
    }

    /// An editor with edits in `directory` and the shared preview caches.
    pub fn with_cache(directory: PathBuf, store: Arc<Store>, memory: Arc<Memory>) -> Self {
        crate::x3i::prune(&directory.join(crate::x3i::DIRECTORY));
        Self {
            x3i: directory.join(crate::x3i::DIRECTORY),
            x3i_jobs: Mutex::new(HashMap::new()),
            edits: Edits::with_store(directory, Some(store.clone())),
            store,
            memory,
            session: Mutex::new(None),
            worker: Mutex::new(Worker::default()),
            preview_work: Arc::new((Mutex::new(PreviewWork::default()), Condvar::new())),
            preview_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            warm: Mutex::new(None),
            opening: AtomicU64::new(0),
            render_revision: AtomicU64::new(u64::MAX),
            assets: Mutex::new(Assets::default()),
            pending: Mutex::new(VecDeque::new()),
            writes: Mutex::new(Vec::new()),
            image_requests: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            close_allowed: AtomicBool::new(false),
            close_gate: Mutex::new(()),
            saving: AtomicUsize::new(0),
            has_edit_activity: AtomicBool::new(false),
        }
    }

    pub fn cancel_preview(&self) {
        self.cancel_work(None);
    }

    /// Cancels preview work. A warm-up of `keep` continues, so that the
    /// editor can use it.
    fn cancel_work(&self, keep: Option<&Path>) {
        if let Ok(work) = self.preview_work.0.lock() {
            work.background_cancel.store(true, Ordering::SeqCst);
        }
        if let Ok(cancel) = self.preview_cancel.lock() {
            cancel.store(true, Ordering::SeqCst);
        }
        if let Ok(warm) = self.warm.lock() {
            if let Some((_, cancel)) = warm
                .as_ref()
                .filter(|(path, _)| Some(path.as_path()) != keep)
            {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }

    fn foreground_request(&self) -> Result<ForegroundRequest, String> {
        let mut work = self
            .preview_work
            .0
            .lock()
            .map_err(|_| "Renderer unavailable")?;
        work.foreground += 1;
        work.background_cancel.store(true, Ordering::SeqCst);
        Ok(ForegroundRequest {
            gate: self.preview_work.clone(),
        })
    }

    pub fn cancel_render(&self, id: &str, revision: u64) -> Result<(), String> {
        let mut active = self.session.lock().map_err(|_| "Editor unavailable")?;
        if let Some(session) = active.as_mut().filter(|session| session.id == id) {
            // Async command admission can trail this synchronous cancellation.
            session.cancelled_revision =
                Some(session.cancelled_revision.unwrap_or(0).max(revision));
            if self.render_revision.load(Ordering::SeqCst) == revision {
                self.cancel_work(Some(&session.path));
            }
        }
        Ok(())
    }

    pub fn begin_open(&self) -> Result<(), String> {
        let _gate = self.close_gate.lock().map_err(|_| "Editor unavailable")?;
        if self.close_allowed.load(Ordering::SeqCst) {
            return Err("The window is closing".into());
        }
        self.has_edit_activity.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn begin_save(&self) -> Result<(), String> {
        let _gate = self.close_gate.lock().map_err(|_| "Editor unavailable")?;
        if self.close_allowed.load(Ordering::SeqCst) {
            return Err("The window is closing".into());
        }
        self.has_edit_activity.store(true, Ordering::SeqCst);
        self.saving.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn finish_close(&self) -> Result<(), String> {
        let _gate = self.close_gate.lock().map_err(|_| "Editor unavailable")?;
        self.edits.flush()?;
        if self.saving.load(Ordering::SeqCst) > 0 {
            return Err("Edits are still saving; try closing again".into());
        }
        self.opening.fetch_add(1, Ordering::SeqCst);
        self.cancel_preview();
        self.close_allowed.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn reopen(&self) {
        if let Ok(_gate) = self.close_gate.lock() {
            self.close_allowed.store(false, Ordering::SeqCst);
            self.resume_previews();
        }
    }

    pub fn close_allowed(&self) -> bool {
        self.close_allowed.load(Ordering::SeqCst)
    }

    pub fn needs_close_flush(&self) -> bool {
        !self.close_allowed.load(Ordering::SeqCst)
            && (self.has_edit_activity.load(Ordering::SeqCst)
                || self.saving.load(Ordering::SeqCst) > 0
                || self.session.lock().map_or(true, |s| s.is_some())
                || self.edits.has_pending())
    }

    pub fn resume_previews(&self) {
        let _ = self.fresh_request();
        self.paused.store(false, Ordering::SeqCst);
    }

    fn fresh_request(&self) -> Result<Arc<AtomicBool>, String> {
        self.render_revision.store(u64::MAX, Ordering::SeqCst);
        let mut current = self
            .preview_cancel
            .lock()
            .map_err(|_| "Editor cancellation unavailable")?;
        current.store(true, Ordering::SeqCst);
        *current = Arc::new(AtomicBool::new(false));
        Ok(current.clone())
    }

    pub fn open(&self, path: PathBuf) -> Result<EditorSession, String> {
        self.begin_open()?;
        source_path(&path)?;
        let generation = self.opening.fetch_add(1, Ordering::SeqCst) + 1;
        let requested_path = path.clone();
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        self.cancel_work(Some(&path));
        self.edits.flush()?;
        let saved = self.load(&path)?;
        let source_revision = self.edits.source_revision(&path)?;
        let (source, as_shot_crop, camera_profiles) =
            camera_defaults(&path, &AtomicBool::new(false))?;
        if self.edits.source_revision(&path)? != source_revision {
            return Err("Source changed while reading camera framing; reopen the photo".into());
        }
        if saved
            .as_ref()
            .is_some_and(|s| s.source_revision != source_revision)
        {
            return Err("Source changed while opening; reopen the photo".into());
        }
        let recipe = saved.as_ref().map(|r| r.recipe.clone()).unwrap_or_else(|| {
            source_recipe(
                source,
                as_shot_crop,
                &camera_profiles.as_shot,
                &source_revision,
            )
        });
        source.validate_recipe(&recipe)?;
        let x3i = self.x3i_status(&path, &recipe)?;
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.clone(),
            source_revision: source_revision.clone(),
            cancelled_revision: None,
        };
        if self.opening.load(Ordering::SeqCst) != generation {
            return Err("Photo opening superseded".into());
        }
        let _gate = self.close_gate.lock().map_err(|_| "Editor unavailable")?;
        if self.close_allowed.load(Ordering::SeqCst) {
            return Err("The window is closing".into());
        }
        let mut active = self
            .session
            .lock()
            .map_err(|_| "Editor session unavailable")?;
        if self.opening.load(Ordering::SeqCst) != generation {
            return Err("Photo opening superseded".into());
        }
        *active = Some(session.clone());
        Ok(EditorSession {
            session_id: session.id,
            path: requested_path,
            source_revision,
            recipe,
            as_shot_crop,
            camera_profiles: camera_profiles.available,
            as_shot_camera_profile: source
                .capabilities
                .foveon
                .then_some(camera_profiles.as_shot),
            source_kind: source.kind,
            capabilities: source.capabilities,
            revision: saved.as_ref().map_or(0, |s| s.revision),
            storage: saved
                .as_ref()
                .filter(|s| s.edited)
                .map_or_else(|| "none".into(), |s| s.storage.clone()),
            storage_path: saved.as_ref().map(|s| s.storage_path.clone()),
            preview_url: saved.and_then(|s| s.preview_url),
            x3i,
        })
    }

    /// The merge state of an X3I for `recipe`, else None.
    pub fn x3i_status(
        &self,
        path: &Path,
        recipe: &EditRecipe,
    ) -> Result<Option<X3iStatus>, String> {
        source_path(path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let Some(frames) = crate::x3i::frames(&path) else {
            return Ok(None);
        };
        let job = self
            .x3i_jobs
            .lock()
            .map_err(|_| "Editor unavailable")?
            .get(&path)
            .cloned();
        let source_revision = self.edits.source_revision(&path)?;
        let options = merge_options(recipe);
        let scene = crate::x3i::scene_info(&self.x3i, &path, &source_revision, &options);
        Ok(Some(X3iStatus {
            frames,
            processed: scene.is_some(),
            bytes: scene.as_ref().map(|(_, bytes)| *bytes),
            name: scene.map(|(name, _)| name),
            progress: job.as_ref().and_then(|job| job.progress()),
            error: job.and_then(|job| job.error()),
        }))
    }

    /// Merges an X3I into the scene cache for `recipe`, and reports progress
    /// to `x3i_status`. It returns when the merge ends. A call while the same
    /// photo merges returns at once.
    pub fn x3i_process(&self, path: &Path, recipe: &EditRecipe) -> Result<(), String> {
        match self.x3i_begin(path)? {
            Some(merge) => self.x3i_run(merge, recipe),
            None => Ok(()),
        }
    }

    /// Registers the merge of an X3I, so that `x3i_cancel` can stop it before
    /// `x3i_run` starts. None when the photo merges already.
    pub fn x3i_begin(&self, path: &Path) -> Result<Option<X3iMerge>, String> {
        source_path(path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let frames = crate::x3i::frames(&path).ok_or("The photo is not an X3I")?;
        let mut jobs = self.x3i_jobs.lock().map_err(|_| "Editor unavailable")?;
        if self.close_allowed.load(Ordering::SeqCst) {
            return Err("The window is closing".into());
        }
        if let Some(job) = jobs.get(&path).filter(|job| job.progress().is_some()) {
            if job.cancel.load(Ordering::SeqCst) {
                return Err("The cancelled merge is stopping. Try again.".into());
            }
            return Ok(None);
        }
        let job = Arc::new(X3iJob {
            // Core reports Read, then Decode for each frame, then Process
            // for each frame in the second merge pass.
            stages: 2 * frames + 1,
            ..Default::default()
        });
        jobs.insert(path.clone(), job.clone());
        Ok(Some(X3iMerge { path, job }))
    }

    /// Runs a merge that `x3i_begin` registered. It returns when the merge ends.
    pub fn x3i_run(&self, merge: X3iMerge, recipe: &EditRecipe) -> Result<(), String> {
        let X3iMerge { path, job } = merge;
        let options = merge_options(recipe);
        let result = (|| {
            let source_revision = self.edits.source_revision(&path)?;
            if crate::x3i::processed(&self.x3i, &path, &source_revision, &options) {
                return Ok(());
            }
            prepare_in_background(|| {
                crate::x3i::prepare_scene(
                    &self.x3i,
                    &path,
                    &source_revision,
                    &options,
                    &job.cancel,
                    Some(|| self.edits.source_revision(&path).as_ref() == Ok(&source_revision)),
                    |_| {
                        job.done.fetch_add(1, Ordering::Relaxed);
                    },
                )
            })?;
            // A merge without its cached scene would ask for a merge again.
            if self.edits.source_revision(&path)? != source_revision {
                return Err("Source contents changed during the merge; try again".into());
            }
            if !crate::x3i::processed(&self.x3i, &path, &source_revision, &options) {
                return Err(
                    "Cannot keep the merged image. Check the free disk space and try again.".into(),
                );
            }
            Ok(())
        })();
        if let Ok(mut finished) = job.result.lock() {
            *finished = Some(result.clone());
        }
        result
    }

    /// Removes the merged scene of an X3I from the cache. The photo then needs
    /// a merge again, unless `recipe` uses the middle exposure.
    pub fn x3i_delete(&self, path: &Path, recipe: &EditRecipe) -> Result<(), String> {
        source_path(path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let source_revision = self.edits.source_revision(&path)?;
        crate::x3i::remove_scene(&self.x3i, &path, &source_revision, &merge_options(recipe))
    }

    pub fn sfd_cache_size(&self) -> Result<u64, String> {
        crate::x3i::cache_size(&self.x3i)
    }

    pub fn clear_sfd_cache(&self) -> Result<(), String> {
        // Keep registration blocked until clear ends, including the final merge checks.
        let jobs = self.x3i_jobs.lock().map_err(|_| "Editor unavailable")?;
        for job in jobs.values() {
            if job
                .result
                .lock()
                .map_err(|_| "Editor unavailable")?
                .is_none()
            {
                return Err("SFD merge in progress".into());
            }
        }
        crate::x3i::clear_cache(&self.x3i)
    }

    /// Stops the merge of an X3I. `x3i_status` then reports no error.
    pub fn x3i_cancel(&self, path: &Path) -> Result<(), String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if let Some(job) = self
            .x3i_jobs
            .lock()
            .map_err(|_| "Editor unavailable")?
            .get(&path)
        {
            job.cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Stops editor work when the main window closes. Warm-ups that start
    /// later fail. `reopen` allows work again.
    pub fn close_window(&self) {
        let _gate = self.close_gate.lock();
        // Under the job lock, so that no X3I merge starts after the cancellation.
        let jobs = self.x3i_jobs.lock();
        self.close_allowed.store(true, Ordering::SeqCst);
        for job in jobs.iter().flat_map(|jobs| jobs.values()) {
            job.cancel.store(true, Ordering::SeqCst);
        }
        drop(jobs);
        self.cancel_preview();
    }

    /// Frees the session and the prepared RAW after `close_window`, so that
    /// they do not stay in memory while the app runs without a window.
    pub fn release_source(&self) {
        let Ok(mut worker) = self.worker.lock() else {
            return;
        };
        // `reopen` and `open` use the gate, so a reopened window keeps its work.
        let _gate = self.close_gate.lock();
        if self.close_allowed.load(Ordering::SeqCst) {
            worker.prepared = None;
            if let Ok(mut session) = self.session.lock() {
                *session = None;
            }
        }
    }

    /// Prepares a photo and uploads it to the GPU before it opens, so that its
    /// first preview needs no RAW decode. A newer warm-up, `cancel_preview` or
    /// opening another photo cancels it. It never replaces the source of
    /// another open photo.
    pub fn warm(&self, path: PathBuf) -> Result<(), String> {
        source_path(&path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some((_, previous)) = self
            .warm
            .lock()
            .map_err(|_| "Editor unavailable")?
            .replace((path.clone(), cancel.clone()))
        {
            previous.store(true, Ordering::SeqCst);
        }
        if self.close_allowed.load(Ordering::SeqCst) {
            return Err("The window is closing".into());
        }
        check_cancel(&cancel)?;
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "Renderer unavailable; restart the app")?;
        if self
            .session
            .lock()
            .map_err(|_| "Editor unavailable")?
            .as_ref()
            .is_some_and(|session| session.path != path)
        {
            return Ok(());
        }
        let source_revision = self.edits.source_revision(&path)?;
        let recipe = match self.edits.load(&path)? {
            Some(saved) => saved.recipe,
            None => self.default_recipe(&path, &source_revision, &cancel)?,
        };
        let asset = Asset {
            path,
            source_revision,
            recipe,
            max_edge: 2048,
            region: None,
        };
        self.ready(&mut worker, &asset, &cancel)?;
        if let (Some(renderer), Some(prepared)) = (&worker.renderer, &worker.prepared) {
            renderer
                .upload_prepared(&prepared.image, &cancel)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The photo whose prepared RAW background renders keep: the open photo,
    /// else the warmed photo.
    fn kept_source(&self) -> Result<Option<PathBuf>, String> {
        let session = self.session.lock().map_err(|_| "Editor unavailable")?;
        if let Some(session) = session.as_ref() {
            return Ok(Some(session.path.clone()));
        }
        let warm = self.warm.lock().map_err(|_| "Editor unavailable")?;
        Ok(warm.as_ref().map(|(path, _)| path.clone()))
    }

    fn session(&self, id: &str) -> Result<Session, String> {
        self.session
            .lock()
            .map_err(|_| "Editor session unavailable")?
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "Editor session expired".into())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        self.edits.flush()?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Editor session unavailable")?;
        if session.as_ref().is_some_and(|s| s.id == id) {
            let _priority = self.foreground_request()?;
            self.opening.fetch_add(1, Ordering::SeqCst);
            self.cancel_preview();
            *session = None;
            drop(session);
            self.worker
                .lock()
                .map_err(|_| "Renderer unavailable")?
                .prepared = None;
            self.resume_previews();
        }
        Ok(())
    }

    pub fn save(
        &self,
        path: &Path,
        recipe: EditRecipe,
        revision: u64,
        expected_source: Option<&str>,
    ) -> Result<EditRecord, String> {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let session_source = self
            .session
            .lock()
            .map_err(|_| "Editor unavailable")?
            .as_ref()
            .filter(|s| s.path == canonical)
            .map(|s| s.source_revision.clone());
        let expected = expected_source
            .or(session_source.as_deref())
            .ok_or("Load the photo's current edit record before saving")?;
        let mut record = self.edits.save(path, recipe, revision, Some(expected))?;
        // Undo or Reset back to the defaults is not an edit. The file stays until
        // the next load, so the revision order still holds for slower saves.
        record.edited = self
            .unedited(path, &record.recipe, &record.source_revision, false)
            .is_none();
        record.preview_url =
            Some(self.register(path, &record.source_revision, &record.recipe, 2048, None)?);
        Ok(record)
    }

    pub fn load(&self, path: &Path) -> Result<Option<EditRecord>, String> {
        let Some(mut record) = self.edits.load(path)? else {
            return Ok(None);
        };
        // Stored defaults are not edits. Earlier builds also saved them for each
        // opened photo. Remove them. If that fails, they still count as unedited.
        if let Some(defaults) =
            self.unedited(path, &record.recipe, &record.source_revision, record.legacy)
        {
            match self.edits.clear(path, &record) {
                Ok(true) => return Ok(None),
                // A newer save replaced the document or waits to publish. Load
                // the stored one once more, without a second removal.
                Ok(false) => match self.edits.load(path)? {
                    Some(current) => record = current,
                    None => return Ok(None),
                },
                Err(error) => {
                    eprintln!("{error}");
                    record.edited = false;
                    record.recipe = defaults;
                }
            }
        }
        record.preview_url =
            Some(self.register(path, &record.source_revision, &record.recipe, 2048, None)?);
        Ok(Some(record))
    }

    pub fn preview(
        &self,
        path: &Path,
        recipe: &EditRecipe,
        source_revision: Option<&str>,
    ) -> Result<String, String> {
        let actual = self.edits.source_revision(path)?;
        if source_revision.is_some_and(|expected| expected != actual) {
            return Err("Source changed since the export was reviewed".into());
        }
        self.register(path, &actual, recipe, 2048, None)
    }

    /// Renders original RAW detail without opening a session or writing edits.
    pub fn original_native(&self, path: &Path, uri: &str) -> Result<Option<Arc<Vec<u8>>>, String> {
        source_path(path)?;
        let key = crate::cache::source_key(path).ok_or("Preview source unavailable")?;
        // Change this cache version when camera defaults change.
        let base = format!(
            "{:x}",
            Sha256::digest(format!(
                "original-native-v1:{key}:{}",
                x3f_render::RENDER_VERSION
            ))
        );
        let original = url::Url::parse(uri).map_err(|e| e.to_string())?;
        let region = crate::preview::protocol_region(&original)?;
        let mut url = url::Url::parse(&asset_url(&base)).map_err(|e| e.to_string())?;
        for (name, value) in original.query_pairs().filter(|(name, _)| name != "v") {
            url.query_pairs_mut().append_pair(&name, &value);
        }
        url.query_pairs_mut()
            .append_pair("v", if region.is_some() { "region" } else { "native" });
        let query = parse_image_uri(url.as_str())?;
        if query.cache_only {
            return Ok(self.lookup(&query.id, false, query.raw));
        }
        if self.lookup(&query.id, false, query.raw).is_none()
            && !self
                .assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?
                .recipes
                .contains_key(&base)
        {
            let source_revision = self.edits.source_revision(path)?;
            let recipe = self.default_recipe(path, &source_revision, &AtomicBool::new(false))?;
            let registered = self.register(path, &source_revision, &recipe, 2048, None)?;
            if crate::cache::source_key(path).as_ref() != Some(&key) {
                return Err("Preview source changed".into());
            }
            let mut assets = self
                .assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?;
            let asset = assets
                .recipes
                .get(&protocol_id(&registered)?)
                .cloned()
                .ok_or("Preview expired")?;
            assets.insert(base, asset);
        }
        self.image_query(url.as_str(), &query).map(Some)
    }

    /// Returns camera defaults without writing a sidecar or backup.
    pub fn default_recipe(
        &self,
        path: &Path,
        source_revision: &str,
        cancel: &AtomicBool,
    ) -> Result<EditRecipe, String> {
        check_cancel(cancel)?;
        let (source, crop, profiles) = camera_defaults(path, cancel)?;
        if self.edits.source_revision(path)? != source_revision {
            return Err("Source changed while reading camera defaults".into());
        }
        Ok(source_recipe(
            source,
            crop,
            &profiles.as_shot,
            source_revision,
        ))
    }

    /// The photo's defaults when `recipe` is one of them (see `matches_defaults`).
    /// An error while reading them counts as an edit.
    fn unedited(
        &self,
        path: &Path,
        recipe: &EditRecipe,
        source_revision: &str,
        legacy: bool,
    ) -> Option<EditRecipe> {
        // Read the X3F metadata only for a recipe that can be a default.
        if !near_default(recipe) {
            return None;
        }
        let defaults = self
            .default_recipe(path, source_revision, &AtomicBool::new(false))
            .ok()?;
        matches_defaults(recipe, &defaults, legacy).then_some(defaults)
    }

    fn register(
        &self,
        path: &Path,
        source_revision: &str,
        recipe: &EditRecipe,
        max_edge: u32,
        region: Option<Crop>,
    ) -> Result<String, String> {
        let source = crate::source::Info::read(path, &AtomicBool::new(false))?;
        source.validate_recipe(recipe)?;
        let mut recipe = recipe.clone();
        recipe.dng_demosaic = source.resolve_demosaic(recipe.dng_demosaic);
        if !(1..=4096).contains(&max_edge) {
            return Err("Invalid preview dimensions".into());
        }
        if let Some(region) = region {
            region.validate()?;
        }
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let id = asset_id(&canonical, source_revision, &recipe, max_edge, region)?;
        let mut assets = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?;
        assets.insert(
            id.clone(),
            Asset {
                path: canonical,
                source_revision: source_revision.into(),
                recipe,
                max_edge,
                region,
            },
        );
        Ok(asset_url(&id))
    }

    /// Prepares the RAW of `asset`. Only with `merge` can an X3I without a
    /// cached scene merge here; else it fails with `x3i::UNPROCESSED`.
    fn prepare<'a>(
        &self,
        worker: &'a mut Worker,
        asset: &Asset,
        cancel: &AtomicBool,
        merge: bool,
    ) -> Result<&'a SceneLinearImage, String> {
        check_cancel(cancel)?;
        if self.edits.source_revision(&asset.path)? != asset.source_revision {
            return Err("Source contents changed; reopen the photo".into());
        }
        let source = crate::source::Info::read(&asset.path, cancel)?;
        source.validate_recipe(&asset.recipe)?;
        let mut recipe = asset.recipe.clone();
        recipe.dng_demosaic = source.resolve_demosaic(recipe.dng_demosaic);
        let same_source = worker
            .prepared
            .as_ref()
            .is_some_and(|p| p.matches_source(&asset.path, &asset.source_revision, &asset.recipe));
        let reuse = same_source
            && worker
                .prepared
                .as_ref()
                .is_some_and(|p| p.matches_preparation(&recipe));
        if !reuse {
            // Keep the responsive source if refinement is interrupted. A different
            // photo releases it first to bound memory while browsing.
            if !same_source {
                worker.prepared = None;
            }
            let options = scene_options(&recipe);
            let (image, denoise_free) = if source.kind == crate::source::Kind::Dng {
                let method = recipe.dng_demosaic.map(dng_method).transpose()?;
                (
                    prepare_in_background(|| {
                        x3f_dng::prepare_with_method(&asset.path, method, cancel)
                    })?,
                    true,
                )
            } else {
                prepare_in_background(|| {
                    crate::x3i::prepare_scene(
                        &self.x3i,
                        &asset.path,
                        &asset.source_revision,
                        &options,
                        cancel,
                        merge.then_some(|| {
                            self.edits.source_revision(&asset.path).as_ref()
                                == Ok(&asset.source_revision)
                        }),
                        |_| (),
                    )
                })?
            };
            let mut image = PreparedImage::new(image, cancel).map_err(|e| e.to_string())?;
            if source.kind == crate::source::Kind::Dng {
                image = image.with_dng_source(!source.white_balance_available(&asset.recipe));
            } else {
                image = image.with_camera_profiles(
                    x3f_render::read_camera_profiles(&asset.path, cancel)
                        .map_err(|e| e.to_string())?,
                );
            }
            check_cancel(cancel)?;
            if self.edits.source_revision(&asset.path)? != asset.source_revision {
                return Err("Source contents changed during RAW preparation".into());
            }
            worker.prepared = Some(Prepared {
                path: asset.path.clone(),
                source_revision: asset.source_revision.clone(),
                denoise: asset.recipe.denoise,
                denoise_options: asset.recipe.denoise_options,
                dng_demosaic: recipe.dng_demosaic,
                denoise_free,
                x3i_source: asset.recipe.x3i_source,
                image,
            });
        }
        Ok(worker
            .prepared
            .as_ref()
            .ok_or("RAW preparation unavailable")?
            .image
            .image())
    }

    pub fn render(&self, request: RenderRequest) -> Result<RenderedPreview, String> {
        let preview = self.render_job(self.begin_render(request)?);
        self.persist_previews();
        preview
    }

    // Register cancellation before dispatching to the blocking worker, so queued
    // refinements can be interrupted without cancelling a newer interactive frame.
    pub(crate) fn begin_render(&self, request: RenderRequest) -> Result<RenderJob, String> {
        if self.paused.load(Ordering::SeqCst) {
            return Err("Preview rendering pauses during export".into());
        }
        let active = self.session.lock().map_err(|_| "Editor unavailable")?;
        let session = active
            .as_ref()
            .filter(|s| s.id == request.session_id)
            .cloned()
            .ok_or("Editor session expired")?;
        if session
            .cancelled_revision
            .is_some_and(|revision| request.revision <= revision)
        {
            return Err("Rendering cancelled".into());
        }
        let priority = self.foreground_request()?;
        let cancel = self.fresh_request()?;
        self.render_revision
            .store(request.revision, Ordering::SeqCst);
        Ok(RenderJob {
            request,
            session,
            cancel,
            priority,
        })
    }

    /// The recipe a request renders: an interactive frame reuses the prepared
    /// source. A cold Bayer DNG starts with Fast; a Foveon source skips BM3D.
    /// The saved recipe stays unchanged. Returns the recipe and whether it is a draft.
    fn effective_recipe(
        worker: &Worker,
        request: &RenderRequest,
        session: &Session,
        source: crate::source::Info,
    ) -> (EditRecipe, bool) {
        let mut recipe = request.recipe.clone();
        let requested_demosaic = source.resolve_demosaic(recipe.dng_demosaic);
        recipe.dng_demosaic = requested_demosaic;
        if request.interactive {
            if let Some(prepared) = worker
                .prepared
                .as_ref()
                .filter(|p| p.matches_source(&session.path, &session.source_revision, &recipe))
            {
                if !prepared.denoise_free {
                    recipe.denoise = prepared.denoise;
                    recipe.denoise_options = prepared.denoise_options;
                }
                // A Mono transition changes calibration. Render its requested source.
                if prepared.dng_demosaic != Some(DngDemosaic::Mono)
                    && recipe.dng_demosaic != Some(DngDemosaic::Mono)
                {
                    recipe.dng_demosaic = prepared.dng_demosaic;
                }
            } else {
                if source.capabilities.bayer && requested_demosaic != Some(DngDemosaic::Mono) {
                    recipe.dng_demosaic = Some(DngDemosaic::Fast);
                }
                if recipe.denoise_options.algorithm == x3f_core::DenoiseAlgorithm::Bm3d {
                    recipe.denoise = 0;
                }
            }
        }
        let draft = recipe.denoise != request.recipe.denoise
            || recipe.denoise_options != request.recipe.denoise_options
            || recipe.dng_demosaic != requested_demosaic;
        (recipe, draft)
    }

    pub(crate) fn render_job(&self, job: RenderJob) -> Result<RenderedPreview, String> {
        let RenderJob {
            request,
            session,
            cancel,
            priority: _priority,
        } = job;
        check_cancel(&cancel)?;
        let generation = self.store.generation();
        let source = crate::source::Info::read(&session.path, &cancel)?;
        source.validate_recipe(&request.recipe)?;
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "Renderer unavailable; restart the app")?;
        let (recipe, draft) = Self::effective_recipe(&worker, &request, &session, source);
        let url = self.register(
            &session.path,
            &session.source_revision,
            &recipe,
            request.max_edge,
            request.region,
        )?;
        let id = protocol_id(&url)?;
        let asset = Asset {
            path: session.path,
            source_revision: session.source_revision,
            recipe,
            max_edge: request.max_edge,
            region: request.region,
        };
        let (rendered, (source_width, source_height)) =
            self.render_with_worker(&mut worker, &asset, &cancel)?;
        let white_balance_available =
            crate::source::Info::read(&asset.path, &cancel)?.white_balance_available(&asset.recipe);
        let as_shot = worker
            .prepared
            .as_ref()
            .filter(|_| white_balance_available)
            .map(|p| {
                (
                    p.image.as_shot_white_balance(),
                    x3f_render::as_shot_channel_gains(&p.image.image().white_balance),
                )
            });
        let calibration = worker
            .prepared
            .as_ref()
            .filter(|_| white_balance_available)
            .map(|p| p.image.image().white_balance);
        drop(worker);
        let white_balance = calibration.and_then(|cal| {
            if asset.recipe.raw_color.is_none()
                && asset.recipe.white_balance_gains.is_none()
                && asset.recipe.temperature.is_none()
                && asset.recipe.tint == 0.
            {
                let ((temperature, tint), _) = as_shot?;
                let n = cal.as_shot_neutral;
                Some(x3f_render::WhiteBalance {
                    temperature,
                    tint,
                    gains: [(n[1] / n[0]) as f32, 1., (n[1] / n[2]) as f32],
                })
            } else {
                x3f_render::recipe_white_balance(&cal, &asset.recipe).ok()
            }
        });
        let preview = RenderedPreview {
            session_id: request.session_id,
            revision: request.revision,
            url,
            width: rendered.width,
            height: rendered.height,
            full_width: rendered.full_width,
            full_height: rendered.full_height,
            source_width,
            source_height,
            region: rendered.region,
            draft,
            as_shot_temperature: as_shot.map(|((k, _), _)| k),
            as_shot_tint: as_shot.map(|((_, t), _)| t),
            as_shot_gains: as_shot.map(|(_, gains)| gains),
            white_balance,
        };
        let frame = Arc::new(frame_body(rendered)?);
        check_cancel(&cancel)?;
        self.session(&preview.session_id)?;
        Stats::add(&self.store.stats.renders);
        if let Ok(mut assets) = self.assets.lock() {
            if draft {
                assets.drafts.insert(id.clone());
            } else {
                assets.drafts.remove(&id);
            }
        }
        // PNGs are encoded on demand. Only a refined large preview is
        // persisted, by `persist_previews` after the frame is returned.
        self.publish_frame(&id, &frame, generation, (!draft).then_some(&asset), None);
        Ok(preview)
    }

    /// Keeps a rendered frame in memory. With `asset`, a final 2048-pixel
    /// preview without a region also goes to disk later, with its thumbnail.
    fn publish_frame(
        &self,
        id: &str,
        frame: &Arc<Vec<u8>>,
        generation: u64,
        asset: Option<&Asset>,
        png: Option<Arc<Vec<u8>>>,
    ) {
        self.memory.put_if(frame_key(id), frame.clone(), || {
            self.store.current(generation)
        });
        let Some(asset) = asset.filter(|asset| persistable(asset)) else {
            return;
        };
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        pending.retain(|queued| queued.id != id);
        pending.push_back(Persist {
            id: id.into(),
            frame: frame.clone(),
            png,
            generation,
            path: asset.path.clone(),
            source_revision: asset.source_revision.clone(),
        });
        // Queued frames are outside the memory budget: keep at most an eighth
        // of it, and always the newest frame. A drain follows each render, so
        // an older frame drops only in a burst, and the counter records it.
        let budget = crate::cache::memory_budget() as usize / 8;
        while pending.len() > 1 && pending.iter().map(Persist::bytes).sum::<usize>() > budget {
            pending.pop_front();
            Stats::add(&self.store.stats.dropped_persistence);
        }
    }

    /// Encodes and persists queued large previews and thumbnails. Call it off
    /// the critical path, after the response went to the webview.
    pub fn persist_previews(&self) {
        let writes = self
            .writes
            .lock()
            .map(|mut writes| std::mem::take(&mut *writes))
            .unwrap_or_default();
        for (generation, name, bytes) in writes {
            self.store.put(generation, &name, &bytes);
        }
        while let Some(job) = self.pending.lock().ok().and_then(|mut p| p.pop_front()) {
            let started = std::time::Instant::now();
            // The frame must be current: no later Clear or Disable, and the
            // same source contents.
            if !self.store.enabled()
                || !self.store.current(job.generation)
                || self.edits.source_revision(&job.path).ok().as_deref()
                    != Some(job.source_revision.as_str())
            {
                continue;
            }
            let thumbnail = match self.memory.get(&thumbnail_key(&job.id)) {
                Some(thumbnail) => Some(thumbnail),
                None => self.derive_thumbnail(&job.id, &job.frame, job.generation, false),
            };
            if let Some(thumbnail) = thumbnail {
                self.store
                    .put(job.generation, &thumbnail_name(&job.id), &thumbnail);
            }
            let png = match job.png.or_else(|| self.memory.get(&png_key(&job.id))) {
                Some(png) => Some(png),
                None => frame_image(&job.frame)
                    .ok()
                    .and_then(|image| image.png().ok())
                    .map(Arc::new),
            };
            if let Some(png) = png {
                self.store.put(job.generation, &medium_name(&job.id), &png);
            }
            self.store.debug(|| {
                format!(
                    "Edited preview {} persisted in {:.1} ms",
                    job.id,
                    ms(started)
                )
            });
        }
    }

    /// Drops queued disk work after Clear. Memory goes with the shared cache.
    pub fn cache_cleared(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        if let Ok(mut writes) = self.writes.lock() {
            writes.clear();
        }
    }

    /// Checks admission, starts the GPU renderer and prepares the RAW.
    fn ready(&self, worker: &mut Worker, asset: &Asset, cancel: &AtomicBool) -> Result<(), String> {
        check_cancel(cancel)?;
        if self.paused.load(Ordering::SeqCst) {
            return Err("Preview rendering pauses during export".into());
        }
        if worker.renderer.is_none() {
            worker.renderer = Some(Renderer::new().map_err(|e| e.to_string())?);
        }
        self.prepare(worker, asset, cancel, false)?;
        Ok(())
    }

    fn render_with_worker(
        &self,
        worker: &mut Worker,
        asset: &Asset,
        cancel: &AtomicBool,
    ) -> Result<(x3f_render::RenderedImage, (u32, u32)), String> {
        let started = std::time::Instant::now();
        self.ready(worker, asset, cancel)?;
        let prepared_at = std::time::Instant::now();
        let Worker { renderer, prepared } = worker;
        let prepared = prepared.as_ref().ok_or("RAW preparation unavailable")?;
        let mut recipe = asset.recipe.clone();
        recipe.dng_demosaic = prepared.dng_demosaic;
        let rendered = renderer
            .as_mut()
            .ok_or("GPU renderer unavailable")?
            .render_prepared(&prepared.image, &recipe, preview_options(asset), cancel)
            .map_err(|e| e.to_string())?;
        check_cancel(cancel)?;
        self.store.debug(|| {
            format!(
                "Edited render {} px: RAW preparation {:.1} ms, render {:.1} ms",
                asset.max_edge,
                (prepared_at - started).as_secs_f64() * 1000.,
                ms(prepared_at)
            )
        });
        Ok((rendered, oriented_size(prepared.image.image())))
    }

    pub fn begin_image_request(&self) -> Result<String, String> {
        let mut requests = self
            .image_requests
            .lock()
            .map_err(|_| "Preview requests unavailable")?;
        if requests.len() >= 128 {
            return Err("Too many pending image requests".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        requests.insert(id.clone(), Arc::new(AtomicBool::new(false)));
        Ok(id)
    }

    pub fn end_image_request(&self, id: &str) -> Result<(), String> {
        if let Some(cancel) = self
            .image_requests
            .lock()
            .map_err(|_| "Preview requests unavailable")?
            .remove(id)
        {
            cancel.store(true, Ordering::SeqCst);
        }
        let work = self
            .preview_work
            .0
            .lock()
            .map_err(|_| "Renderer unavailable")?;
        if work.background_request.as_deref() == Some(id) {
            work.background_cancel.store(true, Ordering::SeqCst);
        }
        self.preview_work.1.notify_all();
        Ok(())
    }

    /// Serves an `x3f-edit` request: an edited preview as an RGBA8 frame or a
    /// PNG or native JPEG. A cache-only request (`cacheOnly=1`) gets 204 on a miss.
    pub fn respond(&self, uri: &str) -> Body {
        let octets = "application/octet-stream";
        let result = match parse_image_uri(uri) {
            Ok(query) if query.cache_only => Ok(self.lookup(&query.id, query.thumbnail, query.raw)),
            Ok(query) => self.image_query(uri, &query).map(Some),
            Err(error) => Err(error),
        };
        match result {
            Ok(Some(bytes)) => {
                let bytes = Arc::unwrap_or_clone(bytes);
                let png = bytes.starts_with(PNG_SIGNATURE);
                Body {
                    status: 200,
                    content_type: if png {
                        "image/png"
                    } else if crate::metadata::is_jpeg(&bytes) {
                        "image/jpeg"
                    } else {
                        octets
                    },
                    bytes,
                }
            }
            Ok(None) => Body {
                status: 204,
                bytes: vec![],
                content_type: "text/plain",
            },
            Err(error) => Body {
                status: 400,
                bytes: error.into_bytes(),
                content_type: "text/plain",
            },
        }
    }

    pub fn image_uri(&self, uri: &str) -> Result<Arc<Vec<u8>>, String> {
        let query = parse_image_uri(uri)?;
        if query.cache_only {
            return self
                .lookup(&query.id, query.thumbnail, query.raw)
                .ok_or_else(|| "Preview is not cached".into());
        }
        self.image_query(uri, &query)
    }

    fn image_query(&self, uri: &str, query: &ImageQuery) -> Result<Arc<Vec<u8>>, String> {
        let url = url::Url::parse(uri).map_err(|e| e.to_string())?;
        let request = url
            .query_pairs()
            .find(|(key, _)| key == "requestId")
            .map(|(_, id)| -> Result<_, String> {
                let cancel = self
                    .image_requests
                    .lock()
                    .map_err(|_| "Preview requests unavailable")?
                    .get(id.as_ref())
                    .cloned()
                    .ok_or("Image request expired")?;
                check_cancel(&cancel)?;
                Ok((id.into_owned(), cancel))
            })
            .transpose()?;
        if let Some(base) = &query.native_of {
            // Stored native pixels do not need a live snapshot or the GPU.
            if let Some(image) = self.lookup(&query.id, false, query.raw) {
                if let Some((_, cancel)) = &request {
                    check_cancel(cancel)?;
                }
                return Ok(image);
            }
            let mut assets = self
                .assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?;
            if !assets.recipes.contains_key(&query.id) {
                let mut asset = assets
                    .recipes
                    .get(base)
                    .cloned()
                    .ok_or("Preview expired; reopen the photo")?;
                if asset.max_edge != 2048 || asset.region.is_some() {
                    return Err("Native previews require a whole-image snapshot".into());
                }
                // Use the same region limit as the edit canvas until the native image is ready.
                asset.max_edge = if query.region.is_some() {
                    4096
                } else {
                    NATIVE_EDGE
                };
                asset.region = query.region;
                assets.insert(query.id.clone(), asset);
            }
        }
        self.image_request(
            &query.id,
            query.thumbnail,
            query.raw,
            request
                .as_ref()
                .map(|(id, cancel)| (id.as_str(), cancel.as_ref())),
            query.priority,
        )
    }

    /// A cached image by ID alone, with no registration, RAW or GPU work, and
    /// no wait for other work. A thumbnail can come from the final preview in
    /// memory or on disk. With `raw`, a frame, else a PNG; the frame layer
    /// decodes either.
    fn lookup(&self, id: &str, thumbnail: bool, raw: bool) -> Option<Arc<Vec<u8>>> {
        let generation = self.store.generation();
        if let Some(hit) = self.memory_hit(id, thumbnail, raw) {
            Stats::add(&self.store.stats.memory_hits);
            return Some(hit);
        }
        if thumbnail {
            if let Some(bytes) = self.store.get(&thumbnail_name(id), &[], png_valid) {
                let bytes = Arc::new(bytes);
                self.memory.put_if(thumbnail_key(id), bytes.clone(), || {
                    self.store.current(generation)
                });
                return Some(bytes);
            }
            let (source, persist) = match self.memory.get(&frame_key(id)) {
                Some(frame) => (frame, self.persistable_id(id)),
                None => match self.memory.get(&png_key(id)) {
                    Some(png) => (png, self.persistable_id(id)),
                    // Only final previews are on disk.
                    None => (self.disk_medium(id, generation)?, true),
                },
            };
            return self.derive_thumbnail(id, &source, generation, persist);
        }
        if let Some(png) = self.disk_medium(id, generation) {
            return Some(png);
        }
        if raw {
            Stats::add(&self.store.stats.misses);
            return None;
        }
        let Some(frame) = self.memory.get(&frame_key(id)) else {
            Stats::add(&self.store.stats.misses);
            return None;
        };
        let png = Arc::new(frame_image(&frame).ok()?.png().ok()?);
        self.memory
            .put_if(png_key(id), png.clone(), || self.store.current(generation));
        if self.persistable_id(id) {
            if let Ok(mut writes) = self.writes.lock() {
                writes.push((generation, medium_name(id), png.clone()));
            }
        }
        Some(png)
    }

    fn memory_hit(&self, id: &str, thumbnail: bool, raw: bool) -> Option<Arc<Vec<u8>>> {
        if thumbnail {
            self.memory.get(&thumbnail_key(id))
        } else if raw {
            self.memory
                .get(&frame_key(id))
                .or_else(|| self.memory.get(&png_key(id)))
        } else {
            self.memory.get(&png_key(id))
        }
    }

    /// The encoded medium or native preview on disk.
    fn disk_medium(&self, id: &str, generation: u64) -> Option<Arc<Vec<u8>>> {
        let bytes = Arc::new(
            self.store
                .get(&medium_name(id), &legacy_medium(id), png_valid)
                .or_else(|| self.store.get(&native_name(id), &[], jpeg_valid))?,
        );
        self.memory.put_if(png_key(id), bytes.clone(), || {
            self.store.current(generation)
        });
        Some(bytes)
    }

    /// Whether the registered `id` is a final preview whose pixels persist.
    fn persistable_id(&self, id: &str) -> bool {
        self.assets.lock().is_ok_and(|assets| {
            !assets.drafts.contains(id) && assets.recipes.get(id).is_some_and(persistable)
        })
    }

    /// The thumbnail of the preview `id`, from its frame or PNG, without GPU work.
    fn derive_thumbnail(
        &self,
        id: &str,
        source: &[u8],
        generation: u64,
        persist: bool,
    ) -> Option<Arc<Vec<u8>>> {
        let image = if source.starts_with(PNG_SIGNATURE) {
            x3f_render::RenderedImage::from_png(source).ok()?
        } else {
            frame_image(source).ok()?
        };
        let png = Arc::new(image.png_preview(THUMBNAIL_EDGE).ok()?);
        Stats::add(&self.store.stats.derived_thumbnails);
        self.memory.put_if(thumbnail_key(id), png.clone(), || {
            self.store.current(generation)
        });
        if persist {
            if let Ok(mut writes) = self.writes.lock() {
                writes.push((generation, thumbnail_name(id), png.clone()));
            }
        }
        Some(png)
    }

    fn cache_native(
        &self,
        id: &str,
        asset: &Asset,
        rendered: x3f_render::RenderedImage,
        generation: u64,
    ) -> Result<Arc<Vec<u8>>, String> {
        // JPEG keeps full-size film grain within the preview cache entry budget.
        let jpeg = Arc::new(rendered.jpeg(92).map_err(|error| error.to_string())?);
        self.memory
            .put_if(png_key(id), jpeg.clone(), || self.store.current(generation));
        if self.edits.source_revision(&asset.path).ok().as_deref() == Some(&asset.source_revision) {
            self.store.put(generation, &native_name(id), &jpeg);
        }
        Ok(jpeg)
    }

    pub fn image(&self, id: &str) -> Result<Arc<Vec<u8>>, String> {
        self.image_request(id, false, false, None, PRIORITY_NORMAL)
    }

    fn image_request(
        &self,
        id: &str,
        thumbnail: bool,
        raw: bool,
        request: Option<(&str, &AtomicBool)>,
        priority: u8,
    ) -> Result<Arc<Vec<u8>>, String> {
        let started = std::time::Instant::now();
        // Work that starts before a Clear or Disable cannot store after it.
        let generation = self.store.generation();
        let uncancellable = AtomicBool::new(false);
        let request_cancel = request.map_or(&uncancellable, |(_, cancel)| cancel);
        check_cancel(request_cancel)?;
        if let Some(image) = self.lookup(id, thumbnail, raw) {
            check_cancel(request_cancel)?;
            return Ok(image);
        }
        let asset = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?
            .recipes
            .get(id)
            .cloned()
            .ok_or("Preview expired; reopen the photo")?;
        let looked_up = ms(started);
        let waiter = Waiter::new(&self.preview_work, priority)?;
        loop {
            check_cancel(request_cancel)?;
            // A duplicate request or an editor refinement can make this image.
            // Memory only: disk was checked, and is checked again before a render.
            if let Some(image) = self.memory_hit(id, thumbnail, raw).or_else(|| {
                self.memory
                    .get(&frame_key(id))
                    .and_then(|_| self.lookup(id, thumbnail, raw))
            }) {
                check_cancel(request_cancel)?;
                return Ok(image);
            }
            let mut work = self
                .preview_work
                .0
                .lock()
                .map_err(|_| "Renderer unavailable")?;
            check_cancel(request_cancel)?;
            let wait = |work| -> Result<(), String> {
                // ponytail: poll availability every 10 ms; releases notify too.
                // Cancellation wakes this wait immediately.
                drop(
                    self.preview_work
                        .1
                        .wait_timeout(work, std::time::Duration::from_millis(10))
                        .map_err(|_| "Renderer unavailable")?,
                );
                Ok(())
            };
            if work.foreground > 0 {
                drop(
                    self.preview_work
                        .1
                        .wait_while(work, |work| {
                            work.foreground > 0 && !request_cancel.load(Ordering::SeqCst)
                        })
                        .map_err(|_| "Renderer unavailable")?,
                );
                continue;
            }
            if !waiter.first(&work) {
                wait(work)?;
                continue;
            }
            let mut worker = match self.worker.try_lock() {
                Ok(worker) => worker,
                Err(std::sync::TryLockError::WouldBlock) => {
                    // A more urgent request interrupts a background render,
                    // which then waits and retries.
                    if work
                        .background_priority
                        .is_some_and(|running| running < priority)
                    {
                        work.background_cancel.store(true, Ordering::SeqCst);
                    }
                    wait(work)?;
                    continue;
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Renderer unavailable; restart the app".into());
                }
            };
            let cancel = Arc::new(AtomicBool::new(false));
            work.background_cancel = cancel.clone();
            work.background_request = request.map(|(id, _)| id.to_owned());
            work.background_priority = Some(priority);
            drop(work);
            let release = || {
                if let Ok(mut work) = self.preview_work.0.lock() {
                    work.background_priority = None;
                    self.preview_work.1.notify_all();
                }
            };
            // Recheck the disk too: another request may have stored it.
            if let Some(image) = self.lookup(id, thumbnail, raw) {
                drop(worker);
                release();
                check_cancel(request_cancel)?;
                return Ok(image);
            }
            let queued = ms(started);
            // A background photo must not evict the active editor's prepared RAW;
            // otherwise every preemption would make the next slider change decode again.
            let active = self.kept_source()?;
            let preserve = worker.prepared.as_ref().is_some_and(|prepared| {
                active.as_ref() == Some(&prepared.path)
                    && (!prepared.matches_source(
                        &asset.path,
                        &asset.source_revision,
                        &asset.recipe,
                    ) || !prepared.matches_preparation(&asset.recipe))
            });
            let previous = if preserve {
                worker.prepared.take()
            } else {
                None
            };
            let result = self.render_with_worker(&mut worker, &asset, &cancel);
            if previous.is_some() {
                worker.prepared = previous;
            }
            drop(worker);
            release();
            check_cancel(request_cancel)?;
            let rendered = match result {
                Ok((rendered, _)) => rendered,
                Err(_)
                    if cancel.load(Ordering::SeqCst)
                        && !self.paused.load(Ordering::SeqCst)
                        && !self.close_allowed.load(Ordering::SeqCst) =>
                {
                    // Let more urgent work run first, then retry this immutable
                    // snapshot instead of returning a broken thumbnail to WebKit.
                    continue;
                }
                Err(error) => return Err(error),
            };
            Stats::add(&self.store.stats.renders);
            let rendered_at = std::time::Instant::now();
            if asset.max_edge == NATIVE_EDGE {
                return self.cache_native(id, &asset, rendered, generation);
            }
            let frame = Arc::new(frame_body(rendered)?);
            let image = if thumbnail {
                self.publish_frame(id, &frame, generation, Some(&asset), None);
                self.derive_thumbnail(id, &frame, generation, false)
                    .ok_or("Could not make the thumbnail")?
            } else if raw {
                self.publish_frame(id, &frame, generation, Some(&asset), None);
                frame
            } else {
                let png = Arc::new(frame_image(&frame)?.png().map_err(|e| e.to_string())?);
                self.memory
                    .put_if(png_key(id), png.clone(), || self.store.current(generation));
                self.publish_frame(id, &frame, generation, Some(&asset), Some(png.clone()));
                png
            };
            self.store.debug(|| {
                format!(
                    "Edited preview {id}: lookup {looked_up:.1} ms, queue {:.1} ms, \
                     render {:.1} ms, encode {:.1} ms",
                    queued - looked_up,
                    (rendered_at - started).as_secs_f64() * 1000. - queued,
                    ms(rendered_at)
                )
            });
            check_cancel(request_cancel)?;
            return Ok(image);
        }
    }

    /// Read calibration without preparing RAW data or changing the recipe.
    pub fn white_balance(
        &self,
        id: &str,
        recipe: EditRecipe,
    ) -> Result<x3f_render::WhiteBalance, String> {
        let session = self.session(id)?;
        let source = crate::source::Info::read(&session.path, &AtomicBool::new(false))?;
        source.validate_recipe(&recipe)?;
        if !source.white_balance_available(&recipe) {
            return Err("White balance is unavailable for monochrome DNG inputs".into());
        }
        let worker = self.worker.lock().map_err(|_| "Renderer unavailable")?;
        let prepared = worker
            .prepared
            .as_ref()
            .filter(|p| {
                p.matches_source(&session.path, &session.source_revision, &recipe)
                    && (p.dng_demosaic == Some(DngDemosaic::Mono))
                        == (source.resolve_demosaic(recipe.dng_demosaic) == Some(DngDemosaic::Mono))
            })
            .ok_or("White balance calibration is not ready")?;
        x3f_render::recipe_white_balance(&prepared.image.image().white_balance, &recipe)
    }

    /// Return channel gains for raw or extended white balance, else Kelvin and tint.
    pub fn pick_white_balance(
        &self,
        id: &str,
        recipe: EditRecipe,
        x: f32,
        y: f32,
        gains: bool,
    ) -> Result<serde_json::Value, String> {
        if self.paused.load(Ordering::SeqCst) {
            return Err("White balance sampling pauses during export".into());
        }
        recipe.validate()?;
        let session = self.session(id)?;
        let source = crate::source::Info::read(&session.path, &AtomicBool::new(false))?;
        source.validate_recipe(&recipe)?;
        if !source.white_balance_available(&recipe) {
            return Err("White balance is unavailable for monochrome DNG inputs".into());
        }
        let _priority = self.foreground_request()?;
        let cancel = self.fresh_request()?;
        let asset = Asset {
            path: session.path,
            source_revision: session.source_revision,
            recipe,
            max_edge: 2048,
            region: None,
        };
        let mut worker = self.worker.lock().map_err(|_| "Renderer unavailable")?;
        if self.paused.load(Ordering::SeqCst) {
            return Err("White balance sampling pauses during export".into());
        }
        let image = self.prepare(&mut worker, &asset, &cancel, false)?;
        let result = match asset.recipe.raw_color {
            Some(raw) => x3f_render::pick_channel_gains(image, &asset.recipe, x, y).map(|gains| {
                serde_json::json!({ "rawColor": x3f_render::RawColor { gains, ..raw } })
            }),
            None if gains => x3f_render::pick_channel_gains(image, &asset.recipe, x, y)
                .map(|gains| serde_json::json!({ "whiteBalanceGains": gains })),
            None => x3f_render::pick_white_balance(image, &asset.recipe, x, y)
                .map(|(temperature, tint)| serde_json::json!({ "temperature": temperature, "tint": tint })),
        }?;
        check_cancel(&cancel)?;
        self.session(id)?;
        Ok(result)
    }

    pub fn export(
        &self,
        path: &Path,
        expected_source: Option<&str>,
        recipe: &EditRecipe,
        settings: &BatchSettings,
        output: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        crate::source::validate_recipe(path, recipe)?;
        crate::source::Kind::of(path).validate_export(settings)?;
        crate::source::protect_output(output, [path.to_owned()])?;
        self.edits.protect_backup(output)?;
        let expected_source = expected_source.ok_or("Review the source before edited export")?;
        let source_revision = self.edits.source_revision(path)?;
        if expected_source != source_revision {
            return Err("Source changed since the export was reviewed".into());
        }
        let asset = Asset {
            path: path.canonicalize().map_err(|e| e.to_string())?,
            source_revision,
            recipe: recipe.clone(),
            max_edge: 2048,
            region: None,
        };
        let mut worker = self.worker.lock().map_err(|_| "Renderer unavailable")?;
        check_cancel(cancel)?;
        if worker.renderer.is_none() {
            worker.renderer = Some(Renderer::new().map_err(|e| e.to_string())?);
        }
        // An export merges an unprocessed X3I: the user asked for its pixels.
        self.prepare(&mut worker, &asset, cancel, true)?;
        let color_profile = match settings.color_profile {
            ColorProfile::Srgb => x3f_render::ColorProfile::Srgb,
            ColorProfile::AdobeRgb => x3f_render::ColorProfile::AdobeRgb,
            ColorProfile::ProPhotoRgb => x3f_render::ColorProfile::ProPhotoRgb,
            ColorProfile::None => return Err("Edited export requires a color profile".into()),
        };
        let Worker { renderer, prepared } = &mut *worker;
        let prepared = prepared.as_ref().ok_or("RAW preparation unavailable")?;
        let mut recipe = recipe.clone();
        recipe.dng_demosaic = prepared.dng_demosaic;
        let result = renderer
            .as_mut()
            .ok_or("GPU renderer unavailable")?
            .render_prepared(
                &prepared.image,
                &recipe,
                RenderOptions {
                    max_dimension: None,
                    region: None,
                    color_profile,
                    rgba8: false,
                },
                cancel,
            )
            .map_err(|e| e.to_string())?;
        drop(worker);
        check_cancel(cancel)?;
        let result = match settings.resize {
            Some(resize) => result
                .resize_for_export(resize, cancel)
                .map_err(|e| e.to_string())?,
            None => result,
        };
        match settings.output_format {
            OutputFormat::RenderedJpeg => {
                use std::io::Write;
                let bytes = result
                    .jpeg(settings.jpeg_quality)
                    .map_err(|e| e.to_string())?;
                check_cancel(cancel)?;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(output)
                    .map_err(|e| e.to_string())?;
                file.write_all(&bytes).map_err(|e| e.to_string())?;
            }
            OutputFormat::Tiff => result
                .write_tiff(output, settings.compress, cancel)
                .map_err(|e| e.to_string())?,
            _ => return Err("Edited export supports JPEG and TIFF".into()),
        }
        check_cancel(cancel)
    }
}

fn camera_defaults(
    path: &Path,
    cancel: &AtomicBool,
) -> Result<
    (
        crate::source::Info,
        Option<Crop>,
        x3f_render::CameraProfiles,
    ),
    String,
> {
    let source = crate::source::Info::read(path, cancel)?;
    let (crop, profiles) = if source.kind == crate::source::Kind::Dng {
        (source.crop, x3f_render::CameraProfiles::default())
    } else {
        (
            x3f_core::read_as_shot_crop(path).map_err(|e| e.to_string())?,
            x3f_render::read_camera_profiles(path, cancel).map_err(|e| e.to_string())?,
        )
    };
    Ok((
        source,
        crop.map(|[x, y, width, height]| Crop {
            x,
            y,
            width,
            height,
        }),
        profiles,
    ))
}

fn dng_method(method: DngDemosaic) -> Result<x3f_dng::DemosaicMethod, String> {
    use x3f_dng::DemosaicMethod as Native;
    Ok(match method {
        DngDemosaic::Default => {
            return Err("Default demosaic must resolve before preparation".into())
        }
        DngDemosaic::Amaze => Native::Amaze,
        DngDemosaic::Dcb => Native::Dcb,
        DngDemosaic::Ahd => Native::Ahd,
        DngDemosaic::Eahd => Native::Eahd,
        DngDemosaic::Hphd => Native::Hphd,
        DngDemosaic::Igv => Native::Igv,
        DngDemosaic::Lmmse => Native::Lmmse,
        DngDemosaic::Vng4 => Native::Vng4,
        DngDemosaic::Mono => Native::Mono,
        DngDemosaic::Fast => Native::Fast,
    })
}

fn source_recipe(
    source: crate::source::Info,
    crop: Option<Crop>,
    profile: &str,
    revision: &str,
) -> EditRecipe {
    let mut recipe = as_shot_recipe(crop, profile, revision);
    if source.kind == crate::source::Kind::Dng {
        recipe.camera_profile = None;
        recipe.denoise = 0;
        recipe.dng_demosaic = source.supports_demosaic().then_some(DngDemosaic::Default);
    }
    recipe
}

fn as_shot_recipe(crop: Option<Crop>, profile: &str, source_revision: &str) -> EditRecipe {
    EditRecipe {
        camera_profile: Some(profile.into()),
        film: None,
        monochrome: (profile == "Monochrome").then(x3f_render::MonochromeSettings::default),
        crop,
        // `defaultRecipe` in the renderer uses the same value.
        sharpen: 50.,
        seed: source_revision
            .get(..8)
            .and_then(|value| u32::from_str_radix(value, 16).ok())
            .unwrap_or(0),
        ..Default::default()
    }
}
/// True when only the fields that defaults set differ from `EditRecipe::default()`.
fn near_default(recipe: &EditRecipe) -> bool {
    let base = EditRecipe::default();
    let probe = EditRecipe {
        camera_profile: base.camera_profile.clone(),
        film: base.film.clone(),
        monochrome: base.monochrome,
        denoise: base.denoise,
        dng_demosaic: base.dng_demosaic,
        crop: base.crop,
        seed: base.seed,
        sharpen: base.sharpen,
        ..recipe.pixels()
    };
    probe == base
}

/// True when `recipe` is the photo's `defaults`. With `legacy` (a document from
/// an earlier build), also the default film with the as-shot crop and seed: those
/// builds saved it for every opened photo.
fn matches_defaults(recipe: &EditRecipe, defaults: &EditRecipe, legacy: bool) -> bool {
    // A hue that a wheel keeps at zero strength is not an edit.
    let recipe = recipe.pixels();
    recipe == *defaults
        || legacy
            && recipe
                == EditRecipe {
                    film: Some(x3f_render::FilmSettings {
                        grain_params: None,
                        halation_params: None,
                        ..Default::default()
                    }),
                    crop: defaults.crop,
                    seed: defaults.seed,
                    ..Default::default()
                }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Rendering cancelled".into())
    } else {
        Ok(())
    }
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn preview_options(asset: &Asset) -> RenderOptions {
    RenderOptions {
        max_dimension: (asset.max_edge != NATIVE_EDGE).then_some(asset.max_edge),
        region: asset.region,
        color_profile: x3f_render::ColorProfile::Srgb,
        rgba8: asset.max_edge != NATIVE_EDGE,
    }
}

/// Source dimensions after EXIF orientation.
fn oriented_size(image: &SceneLinearImage) -> (u32, u32) {
    if (5..=8).contains(&image.orientation) {
        (image.height, image.width)
    } else {
        (image.width, image.height)
    }
}

/// The frame body of an RGBA8 render. The renderer already wrote the `X3F8`
/// header before the rows. Flag 1 adds the snapped region as four trailing f32 values.
fn frame_body(rendered: x3f_render::RenderedImage) -> Result<Vec<u8>, String> {
    match rendered.data {
        x3f_render::Pixels::Rgba8(mut frame) => {
            if let Some(region) = rendered.region {
                frame[12..16].copy_from_slice(&1u32.to_le_bytes());
                for value in [region.x, region.y, region.width, region.height] {
                    frame.extend_from_slice(&value.to_le_bytes());
                }
            }
            Ok(frame)
        }
        x3f_render::Pixels::Rgb16(_) => Err("Previews must render RGBA8".into()),
    }
}

/// The sRGB image in a frame body, for PNG encoding.
fn frame_image(frame: &[u8]) -> Result<x3f_render::RenderedImage, String> {
    let word = |at: usize| u32::from_le_bytes(frame[at..at + 4].try_into().unwrap());
    if frame.len() < 16 || &frame[..4] != b"X3F8" {
        return Err("Invalid preview frame".into());
    }
    let (width, height) = (word(4), word(8));
    let pixels_end = 16 + width as usize * height as usize * 4;
    let trailer = match word(12) {
        0 => 0,
        1 => 16,
        _ => return Err("Invalid preview frame".into()),
    };
    if frame.len() != pixels_end + trailer {
        return Err("Invalid preview frame".into());
    }
    let mut pixels = frame[..pixels_end].to_vec();
    pixels[12..16].fill(0);
    Ok(x3f_render::RenderedImage {
        width,
        height,
        data: x3f_render::Pixels::Rgba8(pixels),
        color_profile: x3f_render::ColorProfile::Srgb,
        full_width: width,
        full_height: height,
        region: None,
    })
}

fn asset_url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://x3f-edit.localhost/{id}")
    } else {
        format!("x3f-edit://localhost/{id}")
    }
}

/// Whether the frame of `asset` persists: a final medium whole image.
fn persistable(asset: &Asset) -> bool {
    asset.max_edge == 2048 && asset.region.is_none()
}

/// The ID of a preview. The renderer version is part of the key: an unchanged
/// recipe renders differently after the renderer changes. `recipe` has its
/// demosaicing method resolved.
fn asset_id(
    canonical: &Path,
    source_revision: &str,
    recipe: &EditRecipe,
    max_edge: u32,
    region: Option<Crop>,
) -> Result<String, String> {
    let mut key = serde_json::to_vec(&(
        canonical,
        source_revision,
        recipe.pixels(),
        max_edge,
        region,
        x3f_render::RENDER_VERSION,
    ))
    .map_err(|e| e.to_string())?;
    // An X3I renders differently after its merge changes. X3F keys stay as they were.
    if let Some(identity) = crate::x3i::identity(canonical) {
        key.extend(identity.as_bytes());
    }
    key.extend(crate::source::decoder_identity(canonical).as_bytes());
    Ok(format!("{:x}", Sha256::digest(key)))
}

/// Decodes an `x3f-edit` URL: `v=thumbnail|native|region`, `format=rgba8`, `cacheOnly=1`
/// and `priority=high|normal|low`.
fn parse_image_uri(uri: &str) -> Result<ImageQuery, String> {
    let id = protocol_id(uri)?;
    let url = url::Url::parse(uri).map_err(|e| e.to_string())?;
    let value = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let variant = value("v");
    let (thumbnail, native) = match variant.as_deref() {
        None => (false, false),
        Some("thumbnail") => (true, false),
        Some("native" | "region") => (false, true),
        _ => return Err("Invalid rendered preview variant".into()),
    };
    let region = crate::preview::protocol_region(&url)?;
    if (variant.as_deref() == Some("region")) != region.is_some() {
        return Err("Region previews require a region and v=region".into());
    }
    let raw = match value("format").as_deref() {
        None => false,
        Some("rgba8") => true,
        _ => return Err("Invalid rendered preview format".into()),
    };
    let priority = match value("priority").as_deref() {
        Some("low") => PRIORITY_LOW,
        None | Some("normal") => PRIORITY_NORMAL,
        Some("high") => PRIORITY_HIGH,
        _ => return Err("Invalid rendered preview priority".into()),
    };
    Ok(ImageQuery {
        id: if let Some(region) = region {
            format!(
                "{:x}",
                Sha256::digest(format!(
                    "region:{id}:{}",
                    serde_json::to_string(&region).map_err(|e| e.to_string())?
                ))
            )
        } else if native {
            native_id(&id)
        } else {
            id.clone()
        },
        native_of: native.then_some(id),
        region,
        thumbnail,
        raw,
        cache_only: crate::preview::cache_only(&url)?,
        priority,
    })
}

pub fn protocol_id(uri: &str) -> Result<String, String> {
    let url = url::Url::parse(uri).map_err(|e| e.to_string())?;
    if !((url.scheme() == "x3f-edit" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("x3f-edit.localhost")))
    {
        return Err("Invalid rendered preview URL".into());
    }
    let id = url.path().strip_prefix('/').ok_or("Missing preview ID")?;
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid preview ID".into());
    }
    Ok(id.into())
}

#[cfg(test)]
mod tests {
    fn bayer_source() -> crate::source::Info {
        crate::source::Info {
            kind: crate::source::Kind::Dng,
            native_dimensions: None,
            capabilities: crate::source::Capabilities {
                bayer: true,
                ..crate::source::Capabilities::for_kind(crate::source::Kind::Dng, false)
            },
            crop: None,
            orientation: Some(1),
            iso: None,
        }
    }

    #[test]
    fn sfd_cache_clear_waits_for_registered_jobs_to_finish() {
        let temporary = tempfile::tempdir().unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let job = Arc::new(X3iJob::default());
        editor
            .x3i_jobs
            .lock()
            .unwrap()
            .insert(PathBuf::from("photo.X3I"), job.clone());
        assert!(editor.clear_sfd_cache().is_err());
        *job.result.lock().unwrap() = Some(Ok(()));
        assert!(editor.clear_sfd_cache().is_ok());
    }

    #[test]
    fn white_balance_reads_only_matching_prepared_calibration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let path = path.canonicalize().unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let revision = editor.edits.source_revision(&path).unwrap();
        let recipe = EditRecipe::default();
        assert!(editor.white_balance("missing", recipe.clone()).is_err());
        *editor.session.lock().unwrap() = Some(Session {
            id: "active".into(),
            path: path.clone(),
            source_revision: revision.clone(),
            cancelled_revision: None,
        });
        assert!(editor.white_balance("active", recipe.clone()).is_err());
        editor.worker.lock().unwrap().prepared = Some(Prepared {
            path,
            source_revision: revision.clone(),
            denoise: recipe.denoise,
            denoise_options: recipe.denoise_options,
            denoise_free: false,
            dng_demosaic: None,
            x3i_source: recipe.x3i_source,
            image: PreparedImage::new(
                SceneLinearImage {
                    width: 1,
                    height: 1,
                    orientation: 1,
                    data: vec![0.18; 3],
                    white_balance: x3f_core::WhiteBalanceCalibration {
                        camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        as_shot_neutral: [0.5, 1., 2.],
                    },
                    color_mode_calibration: None,
                },
                &AtomicBool::new(false),
            )
            .unwrap(),
        });
        assert_eq!(
            editor
                .white_balance("active", recipe.clone())
                .unwrap()
                .gains,
            [2., 1., 0.5]
        );
        let changed = EditRecipe {
            white_balance_gains: Some([3., 1., 2.]),
            ..recipe.clone()
        };
        assert_eq!(
            editor.white_balance("active", changed).unwrap().gains,
            [3., 1., 2.]
        );
        assert_eq!(
            editor
                .white_balance("active", recipe.clone())
                .unwrap()
                .gains,
            [2., 1., 0.5]
        );
        let physical = editor
            .pick_white_balance("active", recipe.clone(), 0.5, 0.5, false)
            .unwrap();
        assert!(physical.get("temperature").is_some());
        assert!(physical.get("whiteBalanceGains").is_none());
        let gains = editor
            .pick_white_balance("active", recipe.clone(), 0.5, 0.5, true)
            .unwrap();
        assert!(gains.get("whiteBalanceGains").is_some());
        assert!(gains.get("temperature").is_none());
        let extended = EditRecipe {
            white_balance_gains: Some([1.; 3]),
            ..recipe.clone()
        };
        assert!(editor
            .pick_white_balance("active", extended, 0.5, 0.5, false)
            .unwrap()
            .get("temperature")
            .is_some());
        let raw = EditRecipe {
            raw_color: Some(x3f_render::RawColor {
                gains: [1.; 3],
                matrix: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            }),
            ..recipe.clone()
        };
        for gains in [false, true] {
            let result = editor
                .pick_white_balance("active", raw.clone(), 0.5, 0.5, gains)
                .unwrap();
            assert!(result.get("rawColor").is_some());
            assert!(result.get("whiteBalanceGains").is_none());
        }
        assert!(editor.worker.lock().unwrap().renderer.is_none());
        editor
            .worker
            .lock()
            .unwrap()
            .prepared
            .as_mut()
            .unwrap()
            .source_revision = "b".repeat(64);
        assert!(editor.white_balance("active", recipe).is_err());
    }

    #[test]
    #[ignore = "set X3F_CAMERA_PROFILE_INPUT to a real file with FCBlue calibration"]
    fn real_camera_defaults_do_not_save_and_existing_recipes_are_preserved() {
        use std::io::{Read, Seek, SeekFrom, Write};
        let input = std::env::var_os("X3F_CAMERA_PROFILE_INPUT").expect("X3F_CAMERA_PROFILE_INPUT");
        let temporary = tempfile::tempdir().unwrap();
        let photo = temporary.path().join("photo.X3F");
        fs::copy(input, &photo).unwrap();
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&photo)
            .unwrap();
        let mut header = [0; 8];
        file.read_exact(&mut header).unwrap();
        let version = u32::from_le_bytes(header[4..].try_into().unwrap());
        assert!((0x0002_0003..0x0004_0000).contains(&version));
        file.seek(SeekFrom::Start(72)).unwrap();
        let mut mode = [0; 32];
        mode[..6].copy_from_slice(b"FCBlue");
        file.write_all(&mode).unwrap();
        drop(file);
        let editor = Editor::new(temporary.path().join("edits"));
        let session = editor.open(photo.clone()).unwrap();
        assert_eq!(session.as_shot_camera_profile.as_deref(), Some("FCBlue"));
        assert_eq!(session.recipe.camera_profile.as_deref(), Some("FCBlue"));
        assert_eq!(session.recipe.film, None);
        assert_eq!(session.revision, 0);
        assert_eq!(session.storage, "none");
        assert!(!crate::edits::sidecar(&photo).exists());
        assert_eq!(
            editor
                .default_recipe(&photo, &session.source_revision, &AtomicBool::new(false))
                .unwrap(),
            session.recipe
        );
        let legacy = EditRecipe {
            exposure: 1.,
            ..Default::default()
        };
        editor
            .save(&photo, legacy.clone(), 1, Some(&session.source_revision))
            .unwrap();
        assert_eq!(editor.open(photo).unwrap().recipe, legacy);
    }
    #[test]
    fn defaults_and_earlier_untouched_recipes_are_not_edits() {
        let crop = Some(x3f_render::Crop {
            x: 0.,
            y: 0.1,
            width: 1.,
            height: 0.8,
        });
        let defaults = super::as_shot_recipe(crop, "FCBlue", "12345678abcdef");
        let earlier = EditRecipe {
            crop,
            seed: defaults.seed,
            ..serde_json::from_str(r#"{"version":1,"film":{}}"#).unwrap()
        };
        let exposed = EditRecipe {
            exposure: 0.5,
            ..defaults.clone()
        };
        let cropped = EditRecipe {
            crop: None,
            ..earlier.clone()
        };
        for recipe in [&defaults, &earlier, &cropped] {
            assert!(super::near_default(recipe));
        }
        assert!(!super::near_default(&exposed));
        assert!(super::matches_defaults(&defaults, &defaults, false));
        // Only documents from earlier builds can hold their untouched film default.
        assert!(super::matches_defaults(&earlier, &defaults, true));
        assert!(!super::matches_defaults(&earlier, &defaults, false));
        assert!(!super::matches_defaults(&cropped, &defaults, true));
        assert!(!super::matches_defaults(&exposed, &defaults, true));
        // A hue that a wheel keeps at zero strength changes no pixels, so it is no edit.
        let mut kept = defaults.clone();
        kept.wheels.midtones.hue = 1.5;
        assert!(super::near_default(&kept));
        assert!(super::matches_defaults(&kept, &defaults, false));
        let mono = super::as_shot_recipe(crop, "Monochrome", "12345678abcdef");
        assert!(super::near_default(&mono));
        assert!(!super::matches_defaults(&mono, &defaults, true));
    }
    #[test]
    fn fresh_camera_defaults_are_clean_and_saved_recipes_remain_legacy() {
        let crop = Some(x3f_render::Crop {
            x: 0.,
            y: 0.1,
            width: 1.,
            height: 0.8,
        });
        let color = super::as_shot_recipe(crop, "FCBlue", "12345678abcdef");
        assert_eq!(color.camera_profile.as_deref(), Some("FCBlue"));
        assert_eq!(color.film, None);
        assert_eq!(color.crop, crop);
        assert_eq!(color.seed, 0x12345678);
        assert_eq!(color.monochrome, None);
        let mono = super::as_shot_recipe(crop, "Monochrome", "12345678abcdef");
        assert_eq!(
            mono.monochrome,
            Some(x3f_render::MonochromeSettings::default())
        );
        let legacy: x3f_render::EditRecipe =
            serde_json::from_str(r#"{"version":1,"exposure":1}"#).unwrap();
        assert_eq!(legacy.camera_profile, None);
        assert_eq!(legacy.film, Some(x3f_render::FilmSettings::default()));
        assert_eq!(legacy.exposure, 1.);
    }
    use super::*;
    use std::fs;

    #[test]
    fn bayer_defaults_do_not_migrate_legacy_demosaicing() {
        let source = bayer_source();
        let defaults = source_recipe(source, None, "Standard", "12345678abcdef");
        assert_eq!(defaults.dng_demosaic, Some(DngDemosaic::Default));
        assert!(near_default(&defaults));
        assert!(matches_defaults(&defaults, &defaults, false));
        for method in [None, Some(DngDemosaic::Fast), Some(DngDemosaic::Mono)] {
            let recipe = EditRecipe {
                dng_demosaic: method,
                ..defaults.clone()
            };
            assert!(!matches_defaults(&recipe, &defaults, false));
            assert!(!matches_defaults(&recipe, &defaults, true));
        }
        let linear = crate::source::Info {
            capabilities: crate::source::Capabilities::for_kind(crate::source::Kind::Dng, false),
            ..source
        };
        assert_eq!(
            source_recipe(linear, None, "Standard", "12345678abcdef").dng_demosaic,
            None
        );
    }

    #[test]
    fn a_cold_bayer_preview_uses_fast_then_resolves_the_selected_method() {
        let session = Session {
            id: "photo".into(),
            path: "/photo.dng".into(),
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        };
        for iso in [None, Some(1600.)] {
            let source = crate::source::Info {
                iso,
                ..bayer_source()
            };
            for method in [
                None,
                Some(DngDemosaic::Default),
                Some(DngDemosaic::Amaze),
                Some(DngDemosaic::Fast),
                Some(DngDemosaic::Mono),
            ] {
                let mut request = RenderRequest {
                    session_id: session.id.clone(),
                    recipe: EditRecipe {
                        dng_demosaic: method,
                        denoise: 0,
                        ..Default::default()
                    },
                    revision: 1,
                    max_edge: 1024,
                    region: None,
                    interactive: true,
                };
                let target = source.resolve_demosaic(method);
                let (first, draft) =
                    Editor::effective_recipe(&Worker::default(), &request, &session, source);
                assert_eq!(
                    first.dng_demosaic,
                    if target == Some(DngDemosaic::Mono) {
                        target
                    } else {
                        Some(DngDemosaic::Fast)
                    }
                );
                assert_eq!(draft, first.dng_demosaic != target);
                request.interactive = false;
                let (final_recipe, draft) =
                    Editor::effective_recipe(&Worker::default(), &request, &session, source);
                assert!(!draft);
                assert_eq!(final_recipe.dng_demosaic, target);
                assert_eq!(request.recipe.dng_demosaic, method);
            }
        }
        let mono = crate::source::Info {
            capabilities: crate::source::Capabilities::for_kind(crate::source::Kind::Dng, true),
            ..bayer_source()
        };
        let request = RenderRequest {
            session_id: session.id.clone(),
            recipe: EditRecipe {
                dng_demosaic: Some(DngDemosaic::Default),
                denoise: 0,
                ..Default::default()
            },
            revision: 1,
            max_edge: 1024,
            region: None,
            interactive: true,
        };
        let (recipe, draft) =
            Editor::effective_recipe(&Worker::default(), &request, &session, mono);
        assert_eq!(recipe.dng_demosaic, Some(DngDemosaic::Mono));
        assert!(!draft);
    }

    #[test]
    fn interactive_demosaic_reuses_color_preparation_but_not_mono_calibration() {
        let source = bayer_source();
        let directory = tempfile::tempdir().unwrap();
        let editor = Editor::new(directory.path().join("edits"));
        let path = directory.path().join("photo.dng");
        set_prepared(&editor, &path);
        let mut worker = editor.worker.lock().unwrap();
        let prepared = worker.prepared.as_mut().unwrap();
        prepared.denoise_free = true;
        prepared.dng_demosaic = Some(DngDemosaic::Amaze);
        let session = Session {
            id: "photo".into(),
            path,
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        };
        let mut request = RenderRequest {
            session_id: session.id.clone(),
            recipe: EditRecipe {
                denoise: 0,
                dng_demosaic: Some(DngDemosaic::Igv),
                ..Default::default()
            },
            revision: 1,
            max_edge: 512,
            region: None,
            interactive: true,
        };
        assert!(prepared.matches_source(&session.path, &session.source_revision, &request.recipe));
        assert!(!prepared.matches_preparation(&request.recipe));
        let (draft, is_draft) = Editor::effective_recipe(&worker, &request, &session, source);
        assert!(is_draft);
        assert_eq!(draft.dng_demosaic, Some(DngDemosaic::Amaze));
        assert!(worker
            .prepared
            .as_ref()
            .unwrap()
            .matches_preparation(&draft));
        request.recipe.dng_demosaic = Some(DngDemosaic::Default);
        let (warmed, draft) = Editor::effective_recipe(&worker, &request, &session, source);
        assert_eq!(warmed.dng_demosaic, Some(DngDemosaic::Amaze));
        assert!(!draft);
        request.recipe.dng_demosaic = Some(DngDemosaic::Igv);
        request.interactive = false;
        assert_eq!(
            Editor::effective_recipe(&worker, &request, &session, source),
            (request.recipe.clone(), false)
        );
        request.interactive = true;
        request.recipe.dng_demosaic = Some(DngDemosaic::Mono);
        assert_eq!(
            Editor::effective_recipe(&worker, &request, &session, source),
            (request.recipe.clone(), false)
        );
        worker.prepared.as_mut().unwrap().dng_demosaic = Some(DngDemosaic::Mono);
        request.recipe.dng_demosaic = Some(DngDemosaic::Amaze);
        request.recipe.temperature = Some(5000.);
        assert_eq!(
            Editor::effective_recipe(&worker, &request, &session, source),
            (request.recipe.clone(), false)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn raw_preparation_runs_at_utility_qos() {
        unsafe extern "C" {
            fn qos_class_self() -> u32;
        }
        const QOS_CLASS_UTILITY: u32 = 0x11;
        let classes: Vec<u32> = prepare_in_background(|| {
            use rayon::prelude::*;
            (0..64)
                .into_par_iter()
                .map(|_| unsafe { qos_class_self() })
                .collect()
        });
        assert!(classes.iter().all(|&class| class == QOS_CLASS_UTILITY));
    }

    /// Gives the worker a 1 px source of `path`.
    fn set_prepared(editor: &Editor, path: &Path) {
        editor.worker.lock().unwrap().prepared = Some(Prepared {
            path: path.into(),
            source_revision: "a".repeat(64),
            denoise: 0,
            denoise_options: Default::default(),
            denoise_free: false,
            dng_demosaic: None,
            x3i_source: EditRecipe::default().x3i_source,
            image: PreparedImage::new(
                SceneLinearImage {
                    width: 1,
                    height: 1,
                    orientation: 1,
                    data: vec![0.18; 3],
                    white_balance: x3f_core::WhiteBalanceCalibration {
                        camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        as_shot_neutral: [1.; 3],
                    },
                    color_mode_calibration: None,
                },
                &AtomicBool::new(false),
            )
            .unwrap(),
        });
    }
    #[test]
    fn failed_refinement_keeps_the_previous_source_but_a_new_photo_releases_it() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"invalid RAW forces a preparation failure").unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let source_revision = editor.edits.source_revision(&path).unwrap();
        let cancel = AtomicBool::new(false);
        let mut worker = Worker {
            renderer: None,
            prepared: Some(Prepared {
                path: path.clone(),
                source_revision: source_revision.clone(),
                denoise: 0,
                denoise_options: Default::default(),
                denoise_free: false,
                dng_demosaic: None,
                x3i_source: EditRecipe::default().x3i_source,
                image: PreparedImage::new(
                    SceneLinearImage {
                        width: 1,
                        height: 1,
                        orientation: 1,
                        data: vec![0.18; 3],
                        white_balance: x3f_core::WhiteBalanceCalibration {
                            camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                            xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                            as_shot_neutral: [1.; 3],
                        },
                        color_mode_calibration: None,
                    },
                    &cancel,
                )
                .unwrap(),
            }),
        };
        let mut asset = Asset {
            path,
            source_revision,
            recipe: EditRecipe::default(),
            max_edge: 2048,
            region: None,
        };
        asset.recipe.denoise = 0;
        assert!(editor.prepare(&mut worker, &asset, &cancel, false).is_ok());
        for options in [
            x3f_core::DenoiseOptions {
                algorithm: x3f_core::DenoiseAlgorithm::Bm3d,
                ..Default::default()
            },
            x3f_core::DenoiseOptions {
                luminance: true,
                ..Default::default()
            },
            x3f_core::DenoiseOptions {
                strength: 1.5,
                ..Default::default()
            },
        ] {
            asset.recipe.denoise_options = options;
            assert!(editor.prepare(&mut worker, &asset, &cancel, false).is_err());
            assert_eq!(
                worker.prepared.as_ref().unwrap().denoise_options,
                x3f_core::DenoiseOptions::default()
            );
        }
        asset.recipe = EditRecipe::default();
        assert!(editor.prepare(&mut worker, &asset, &cancel, false).is_err());
        assert_eq!(worker.prepared.as_ref().unwrap().denoise, 0);
        assert_eq!(
            worker.prepared.as_ref().unwrap().image.image().data,
            vec![0.18; 3]
        );
        asset.path = temporary.path().join("next.X3F");
        fs::write(&asset.path, b"another invalid RAW").unwrap();
        asset.source_revision = editor.edits.source_revision(&asset.path).unwrap();
        assert!(editor.prepare(&mut worker, &asset, &cancel, false).is_err());
        assert!(worker.prepared.is_none());
    }

    #[test]
    fn a_first_interactive_frame_skips_only_bm3d() {
        let session = Session {
            id: "photo".into(),
            path: "/photo.X3F".into(),
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        };
        let request = |algorithm| RenderRequest {
            session_id: "photo".into(),
            recipe: EditRecipe {
                denoise_options: x3f_core::DenoiseOptions {
                    algorithm,
                    ..Default::default()
                },
                ..Default::default()
            },
            revision: 1,
            max_edge: 1024,
            region: None,
            interactive: true,
        };
        let source = crate::source::Info {
            kind: crate::source::Kind::X3f,
            capabilities: crate::source::Capabilities::for_kind(crate::source::Kind::X3f, false),
            ..bayer_source()
        };
        let worker = Worker::default();
        let nlm = request(x3f_core::DenoiseAlgorithm::Nlm);
        assert_eq!(
            Editor::effective_recipe(&worker, &nlm, &session, source),
            (nlm.recipe.clone(), false)
        );
        let bm3d = request(x3f_core::DenoiseAlgorithm::Bm3d);
        let (recipe, draft) = Editor::effective_recipe(&worker, &bm3d, &session, source);
        assert_eq!((recipe.denoise, draft), (0, true));
    }

    #[test]
    fn warm_up_yields_to_another_photo_and_survives_its_own_open_and_edits() {
        let temporary = tempfile::tempdir().unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let path = |name: &str| {
            let path = temporary.path().join(name);
            fs::write(&path, b"invalid RAW").unwrap();
            path.canonicalize().unwrap()
        };
        let (photo, other) = (path("photo.X3F"), path("other.X3F"));
        let warm = || editor.warm.lock().unwrap().clone().unwrap();
        let open = |path: &PathBuf| {
            *editor.session.lock().unwrap() = Some(Session {
                id: "open".into(),
                path: path.clone(),
                source_revision: "a".repeat(64),
                cancelled_revision: None,
            });
        };
        // Another open photo keeps its source; no RAW or GPU work runs.
        open(&other);
        editor.warm(photo.clone()).unwrap();
        assert!(editor.worker.lock().unwrap().prepared.is_none());
        let (warmed, first) = warm();
        assert_eq!(warmed, photo);
        editor.warm(photo.clone()).unwrap();
        assert!(first.load(Ordering::SeqCst), "A newer warm-up cancels");
        let (_, cancel) = warm();
        open(&photo);
        editor.render_revision.store(5, Ordering::SeqCst);
        editor.cancel_render("open", 5).unwrap();
        assert!(editor.preview_cancel.lock().unwrap().load(Ordering::SeqCst));
        assert!(
            !cancel.load(Ordering::SeqCst),
            "Edits keep their photo's warm-up"
        );
        assert!(editor.open(photo.clone()).is_err());
        assert!(!cancel.load(Ordering::SeqCst), "Opening the photo keeps it");
        assert!(editor.open(other.clone()).is_err());
        assert!(
            cancel.load(Ordering::SeqCst),
            "Opening another photo cancels"
        );
        open(&other);
        editor.warm(photo.clone()).unwrap();
        let (_, cancel) = warm();
        editor.cancel_preview();
        assert!(cancel.load(Ordering::SeqCst));
        // Background renders keep the open photo's source, else the warmed one.
        assert_eq!(editor.kept_source().unwrap(), Some(other.clone()));
        *editor.session.lock().unwrap() = None;
        assert_eq!(editor.kept_source().unwrap(), Some(photo.clone()));
        // A closed window frees the session and source, and stops later warm-ups.
        let prepared = |editor: &Editor| editor.worker.lock().unwrap().prepared.is_some();
        set_prepared(&editor, &other);
        open(&other);
        editor.release_source();
        assert!(prepared(&editor), "An open window keeps its source");
        editor.close_window();
        assert!(editor.warm(photo).is_err());
        editor.reopen();
        editor.release_source();
        assert!(prepared(&editor), "A reopened window keeps its source");
        editor.close_window();
        editor.release_source();
        assert!(!prepared(&editor));
        assert!(editor.session.lock().unwrap().is_none());
    }

    #[test]
    fn cancellation_covers_queued_refinement_but_not_a_newer_frame() {
        let temporary = tempfile::tempdir().unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        *editor.session.lock().unwrap() = Some(Session {
            id: "photo".into(),
            path: temporary.path().join("photo.X3F"),
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        });
        let request = |revision| RenderRequest {
            session_id: "photo".into(),
            recipe: EditRecipe::default(),
            revision,
            max_edge: 512,
            region: None,
            interactive: false,
        };
        let queued = editor.begin_render(request(1)).unwrap();
        editor.cancel_render("photo", 1).unwrap();
        assert!(queued.cancel.load(Ordering::SeqCst));
        assert!(editor.render_job(queued).is_err()); // no file I/O or GPU needed
        let latest = editor.begin_render(request(2)).unwrap();
        editor.cancel_render("photo", 1).unwrap();
        editor.cancel_render("another photo", 2).unwrap();
        assert!(!latest.cancel.load(Ordering::SeqCst));
        editor.cancel_render("photo", 2).unwrap();
        assert!(latest.cancel.load(Ordering::SeqCst));
        editor.cancel_render("photo", 3).unwrap();
        assert!(editor.begin_render(request(3)).is_err());
        assert!(editor.begin_render(request(4)).is_ok());
    }

    #[test]
    fn close_serializes_save_admission_and_reopen_restores_previews() {
        let directory = tempfile::tempdir().unwrap();
        let editor = Editor::new(directory.path().join("edits"));
        editor.begin_open().unwrap();
        assert!(editor.needs_close_flush());
        editor.begin_save().unwrap();
        assert!(editor.finish_close().is_err());
        editor.saving.fetch_sub(1, Ordering::SeqCst);
        editor.finish_close().unwrap();
        assert!(!editor.needs_close_flush());
        assert!(editor.begin_save().is_err());
        assert!(editor.begin_open().is_err());
        assert!(editor.preview_cancel.lock().unwrap().load(Ordering::SeqCst));
        editor.reopen();
        assert!(!editor.preview_cancel.lock().unwrap().load(Ordering::SeqCst));
        editor.begin_save().unwrap();
        assert!(editor.needs_close_flush());
        editor.saving.fetch_sub(1, Ordering::SeqCst);
    }

    #[test]
    fn preview_urls_parse_their_options() {
        let id = "a".repeat(64);
        assert_eq!(protocol_id(&asset_url(&id)).unwrap(), id);
        assert!(protocol_id("x3f-edit://localhost/../../etc/passwd").is_err());
        assert!(protocol_id(&format!("https://example.com/{id}")).is_err());
        let url = asset_url(&id);
        let query =
            parse_image_uri(&format!("{url}?v=thumbnail&cacheOnly=1&priority=high")).unwrap();
        assert!(query.thumbnail && query.cache_only && !query.raw);
        assert_eq!(query.priority, PRIORITY_HIGH);
        let query = parse_image_uri(&format!("{url}?format=rgba8")).unwrap();
        assert!(query.raw && !query.cache_only && !query.thumbnail);
        assert_eq!(query.priority, PRIORITY_NORMAL);
        let query = parse_image_uri(&format!("{url}?v=native&cacheOnly=1")).unwrap();
        assert_eq!(query.native_of.as_deref(), Some(id.as_str()));
        assert_eq!(query.id, native_id(&id));
        assert!(!query.thumbnail && query.cache_only);
        let query = parse_image_uri(&format!(
            "{url}?v=region&region=0.2,0.3,0.25,0.4&format=rgba8"
        ))
        .unwrap();
        assert_eq!(query.native_of.as_deref(), Some(id.as_str()));
        assert_ne!(query.id, native_id(&id));
        assert_eq!(query.region.unwrap().width, 0.25);
        for bad in [
            "v=region",
            "region=0,0,1,1",
            "v=native&region=0,0,1,1",
            "v=small",
            "format=jpeg",
            "cacheOnly=0",
            "priority=urgent",
        ] {
            assert!(parse_image_uri(&format!("{url}?{bad}")).is_err(), "{bad}");
        }
    }

    #[test]
    fn region_previews_clone_the_snapshot_and_keep_native_renders_separate() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"source").unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let source = editor.edits.source_revision(&path).unwrap();
        let recipe = EditRecipe::default();
        let url = editor
            .register(&path, &source, &recipe, 2048, None)
            .unwrap();
        let uri = format!("{url}?v=region&region=0.2,0.3,0.25,0.4&format=rgba8");
        let query = parse_image_uri(&uri).unwrap();
        assert_eq!(editor.respond(&format!("{uri}&cacheOnly=1")).status, 204);
        editor.paused.store(true, Ordering::SeqCst);
        assert!(editor
            .image_uri(&uri)
            .unwrap_err()
            .contains("pauses during export"));
        let asset = editor.assets.lock().unwrap().recipes[&query.id].clone();
        assert_eq!(asset.recipe, recipe);
        assert_eq!(asset.max_edge, 4096);
        assert_eq!(asset.region, query.region);
        assert!(preview_options(&asset).rgba8);
        assert!(!persistable(&asset));
        assert_ne!(
            query.id,
            parse_image_uri(&format!("{url}?v=native")).unwrap().id
        );
        assert_ne!(
            query.id,
            parse_image_uri(&format!("{url}?v=region&region=0,0,0.25,0.4"))
                .unwrap()
                .id
        );
        // Region pixels use the same bounded memory cache as editor tiles.
        editor.memory.put_if(
            frame_key(&query.id),
            Arc::new(b"region frame".to_vec()),
            || true,
        );
        assert_eq!(editor.respond(&format!("{uri}&cacheOnly=1")).status, 200);
        assert!(
            editor.assets.lock().unwrap().recipes[&protocol_id(&url).unwrap()]
                .region
                .is_none()
        );
    }

    #[test]
    fn native_previews_use_full_size_and_survive_restart_separately_from_fit() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"source").unwrap();
        let directory = temporary.path().join("edits");
        let editor = Editor::new(directory.clone());
        let source = editor.edits.source_revision(&path).unwrap();
        let recipe = EditRecipe::default();
        let url = editor
            .register(&path, &source, &recipe, 2048, None)
            .unwrap();
        let uri = format!("{url}?v=native");
        let id = native_id(&protocol_id(&url).unwrap());
        assert_eq!(editor.respond(&format!("{uri}&cacheOnly=1")).status, 204);
        editor.paused.store(true, Ordering::SeqCst);
        assert!(editor
            .image_uri(&uri)
            .unwrap_err()
            .contains("pauses during export"));
        let asset = editor.assets.lock().unwrap().recipes[&id].clone();
        assert_eq!(asset.max_edge, NATIVE_EDGE);
        assert!(preview_options(&asset).max_dimension.is_none());
        assert!(asset.region.is_none());
        assert!(!preview_options(&asset).rgba8);
        assert_eq!(asset.source_revision, source);

        let rendered = || x3f_render::RenderedImage {
            width: 5000,
            height: 1,
            data: x3f_render::Pixels::Rgb16(vec![32768; 5000 * 3]),
            color_profile: x3f_render::ColorProfile::Srgb,
            full_width: 5000,
            full_height: 1,
            region: None,
        };
        let expected = editor
            .cache_native(&id, &asset, rendered(), editor.store.generation())
            .unwrap();
        assert!(editor.pending.lock().unwrap().is_empty());
        assert!(editor.memory.get(&frame_key(&id)).is_none());
        drop(editor);

        let reopened = Editor::new(directory);
        reopened.paused.store(true, Ordering::SeqCst);
        let cached = reopened.respond(&format!("{uri}&cacheOnly=1"));
        assert_eq!(cached.status, 200);
        assert_eq!(cached.content_type, "image/jpeg");
        assert_eq!(cached.bytes, *expected);
        assert_eq!(*reopened.image_uri(&uri).unwrap(), cached.bytes);
        assert_eq!(reopened.respond(&format!("{url}?cacheOnly=1")).status, 204);
        let changed = EditRecipe {
            exposure: 1.,
            ..recipe
        };
        let changed_url = reopened
            .register(&path, &source, &changed, 2048, None)
            .unwrap();
        assert_eq!(
            reopened
                .respond(&format!("{changed_url}?v=native&cacheOnly=1"))
                .status,
            204
        );
        assert!(reopened.worker.lock().unwrap().renderer.is_none());
        reopened.store.clear().unwrap();
        reopened.memory.clear();
        assert_eq!(reopened.respond(&format!("{uri}&cacheOnly=1")).status, 204);
        let before_clear = reopened.store.generation();
        reopened.store.clear().unwrap();
        reopened
            .cache_native(&id, &asset, rendered(), before_clear)
            .unwrap();
        assert!(reopened
            .store
            .get(&native_name(&id), &[], jpeg_valid)
            .is_none());
        reopened.store.configure(false, crate::cache::DEFAULT_LIMIT);
        reopened
            .cache_native(&id, &asset, rendered(), reopened.store.generation())
            .unwrap();
        reopened.store.configure(true, crate::cache::DEFAULT_LIMIT);
        assert!(reopened
            .store
            .get(&native_name(&id), &[], jpeg_valid)
            .is_none());
        fs::write(&path, b"changed source").unwrap();
        reopened
            .cache_native(&id, &asset, rendered(), reopened.store.generation())
            .unwrap();
        assert!(reopened
            .store
            .get(&native_name(&id), &[], jpeg_valid)
            .is_none());
        assert!(jpeg_valid(&expected));
        assert!(!jpeg_valid(&expected[..expected.len() - 2]));
    }

    /// A final 2048-pixel PNG, as a render stores it.
    fn final_png(width: u32, height: u32) -> Vec<u8> {
        x3f_render::RenderedImage {
            width,
            height,
            data: x3f_render::Pixels::Rgb16(vec![32768; (width * height * 3) as usize]),
            color_profile: x3f_render::ColorProfile::Srgb,
            full_width: width,
            full_height: height,
            region: None,
        }
        .png()
        .unwrap()
    }

    fn png_size(png: &[u8]) -> (u32, u32) {
        (
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            u32::from_be_bytes(png[20..24].try_into().unwrap()),
        )
    }

    fn prepared(path: &Path, recipe: &EditRecipe) -> Prepared {
        Prepared {
            path: path.to_owned(),
            source_revision: "a".repeat(64),
            denoise: recipe.denoise,
            denoise_options: recipe.denoise_options,
            denoise_free: false,
            dng_demosaic: None,
            x3i_source: EditRecipe::default().x3i_source,
            image: PreparedImage::new(
                SceneLinearImage {
                    width: 1,
                    height: 1,
                    orientation: 1,
                    data: vec![0.18; 3],
                    white_balance: x3f_core::WhiteBalanceCalibration {
                        camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                        as_shot_neutral: [1.; 3],
                    },
                    color_mode_calibration: None,
                },
                &AtomicBool::new(false),
            )
            .unwrap(),
        }
    }

    #[test]
    fn thumbnails_derive_from_final_previews_and_survive_restart() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let directory = temporary.path().join("edits");
        let recipe = EditRecipe::default();
        let editor = Editor::new(directory.clone());
        let url = editor
            .register(&path, &"a".repeat(64), &recipe, 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let medium = final_png(900, 600);
        assert!(editor
            .store
            .put(editor.store.generation(), &medium_name(&id), &medium));
        // No render may start, and the RAW is not decodable.
        editor.cancel_preview();
        editor.paused.store(true, Ordering::SeqCst);
        let uri = format!("{url}?v=thumbnail");
        let expected = editor.image_uri(&uri).unwrap();
        assert_eq!(png_size(&expected), (640, 427));
        editor.persist_previews();
        assert!(editor.worker.lock().unwrap().renderer.is_none());
        drop(editor);

        // After a restart, the derived thumbnail is on disk, without registration.
        let reopened = Editor::new(directory);
        reopened.paused.store(true, Ordering::SeqCst);
        let cached = reopened.respond(&format!("{uri}&cacheOnly=1"));
        assert_eq!((cached.status, cached.bytes), (200, (*expected).clone()));
        assert_eq!(*reopened.image_uri(&uri).unwrap(), *expected);
        assert!(reopened.image_uri(&format!("{url}?v=unknown")).is_err());

        *reopened.session.lock().unwrap() = Some(Session {
            id: "active".into(),
            path: path.clone(),
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        });
        reopened.worker.lock().unwrap().prepared = Some(prepared(&path, &recipe));
        let mut changed = recipe.clone();
        changed.exposure = 1.;
        for (source, recipe) in [("b".repeat(64), &recipe), ("a".repeat(64), &changed)] {
            let url = reopened
                .register(&path, &source, recipe, 2048, None)
                .unwrap();
            assert_eq!(
                reopened
                    .respond(&format!("{url}?v=thumbnail&cacheOnly=1"))
                    .status,
                204
            );
            assert!(reopened
                .image_uri(&format!("{url}?v=thumbnail"))
                .unwrap_err()
                .contains("pauses during export"));
        }
        let worker = reopened.worker.lock().unwrap();
        let prepared = worker.prepared.as_ref().unwrap();
        assert_eq!(prepared.source_revision, "a".repeat(64));
        assert_eq!(prepared.image.image().data, vec![0.18; 3]);
    }

    #[test]
    fn cache_only_requests_never_wait_for_the_worker_or_registration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"Not a decodable RAW").unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let url = editor
            .register(&path, &"a".repeat(64), &EditRecipe::default(), 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let unknown = asset_url(&"b".repeat(64));
        // A busy worker and foreground work block generation, not cache reads.
        let _foreground = editor.foreground_request().unwrap();
        let worker = editor.worker.lock().unwrap();
        for uri in [
            format!("{url}?cacheOnly=1"),
            format!("{url}?v=thumbnail&cacheOnly=1"),
            format!("{url}?format=rgba8&cacheOnly=1"),
            format!("{unknown}?cacheOnly=1&requestId=expired"),
        ] {
            let body = editor.respond(&uri);
            assert_eq!((body.status, body.bytes.len()), (204, 0), "{uri}");
        }
        // A legacy large preview moves into the shared cache on its first hit.
        let legacy = temporary
            .path()
            .join("edits")
            .join(crate::cache::LEGACY_MEDIUMS);
        fs::create_dir_all(&legacy).unwrap();
        let medium = final_png(2048, 1024);
        fs::write(legacy.join(format!("{id}.png")), &medium).unwrap();
        let thumbnail = editor.respond(&format!("{url}?v=thumbnail&cacheOnly=1"));
        assert_eq!(thumbnail.status, 200);
        assert_eq!(png_size(&thumbnail.bytes), (640, 320));
        assert!(!legacy.join(format!("{id}.png")).exists());
        let body = editor.respond(&format!("{url}?cacheOnly=1"));
        assert_eq!((body.status, body.bytes), (200, medium));
        assert!(worker.renderer.is_none());
    }

    #[test]
    fn medium_previews_survive_restart_and_keep_source_and_recipe_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let directory = temporary.path().join("edits");
        let recipe = EditRecipe::default();
        let source = "a".repeat(64);
        let editor = Editor::new(directory.clone());
        let url = editor
            .register(&path, &source, &recipe, 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let expected = final_png(2048, 1024);
        editor
            .store
            .put(editor.store.generation(), &medium_name(&id), &expected);
        editor.memory.clear();
        editor.cancel_preview();
        editor.paused.store(true, Ordering::SeqCst);
        assert_eq!(*editor.image_uri(&url).unwrap(), expected);
        assert!(editor.worker.lock().unwrap().renderer.is_none());
        drop(editor);

        let reopened = Editor::new(directory);
        reopened.cancel_preview();
        reopened.paused.store(true, Ordering::SeqCst);
        assert_eq!(
            reopened
                .register(&path, &source, &recipe, 2048, None)
                .unwrap(),
            url
        );
        assert_eq!(*reopened.image_uri(&url).unwrap(), expected);
        let mut draft = recipe.clone();
        draft.denoise = if recipe.denoise == 0 { 1 } else { 0 };
        let mut bm3d = recipe.clone();
        bm3d.denoise_options.algorithm = x3f_core::DenoiseAlgorithm::Bm3d;
        let mut chroma = recipe.clone();
        chroma.denoise_options.nlm.chroma_search = 21;
        for (source, recipe, edge, region) in [
            ("b".repeat(64), &recipe, 2048, None),
            (source.clone(), &draft, 2048, None),
            (source.clone(), &bm3d, 2048, None),
            (source.clone(), &chroma, 2048, None),
            // Direct thumbnails and regions are other images.
            (source.clone(), &recipe, 640, None),
            (
                source,
                &recipe,
                2048,
                Some(Crop {
                    width: 0.5,
                    height: 0.5,
                    ..Default::default()
                }),
            ),
        ] {
            let distinct = reopened
                .register(&path, &source, recipe, edge, region)
                .unwrap();
            assert_ne!(distinct, url);
            assert!(reopened
                .image_uri(&distinct)
                .unwrap_err()
                .contains("pauses during export"));
        }
        assert!(reopened.worker.lock().unwrap().renderer.is_none());
    }

    #[test]
    fn raw_region_frames_keep_snapped_bounds_and_encode_without_the_trailer() {
        let region = Crop {
            x: 0.125,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        };
        let mut pixels = b"X3F8\x02\0\0\0\x01\0\0\0\0\0\0\0".to_vec();
        pixels.extend([10, 20, 30, 255].repeat(2));
        let rendered = x3f_render::RenderedImage {
            width: 2,
            height: 1,
            full_width: 4,
            full_height: 2,
            data: x3f_render::Pixels::Rgba8(pixels),
            color_profile: x3f_render::ColorProfile::Srgb,
            region: Some(region),
        };
        let frame = frame_body(rendered).unwrap();
        assert_eq!(u32::from_le_bytes(frame[12..16].try_into().unwrap()), 1);
        assert_eq!(frame.len(), 16 + 8 + 16);
        let image = frame_image(&frame).unwrap();
        assert_eq!(image.rgb8(), [10, 20, 30].repeat(2));
        assert!(image.png().unwrap().starts_with(PNG_SIGNATURE));
        assert!(frame_image(&frame[..frame.len() - 1]).is_err());
    }

    #[test]
    fn frames_serve_raw_then_encode_and_persist_png_on_demand() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let directory = temporary.path().join("edits");
        let editor = Editor::new(directory.clone());
        let source = editor.edits.source_revision(&path).unwrap();
        let url = editor
            .register(&path, &source, &EditRecipe::default(), 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let mut frame = b"X3F8\x03\0\0\0\x02\0\0\0\0\0\0\0".to_vec();
        frame.extend([10, 20, 30, 255].repeat(6));
        assert_eq!(frame_image(&frame).unwrap().rgb8(), [10, 20, 30].repeat(6));
        assert!(frame_image(&frame[..20]).is_err());
        let frame = Arc::new(frame);
        let asset = editor.assets.lock().unwrap().recipes[&id].clone();
        editor.publish_frame(&id, &frame, editor.store.generation(), Some(&asset), None);
        // No render may start: every body below comes from the frame or disk.
        editor.paused.store(true, Ordering::SeqCst);
        let raw = editor.respond(&format!("{url}?format=rgba8"));
        assert_eq!(raw.status, 200);
        assert_eq!(raw.bytes, *frame);
        assert_eq!(raw.content_type, "application/octet-stream");
        let png = editor.respond(&url);
        assert_eq!((png.status, png.content_type), (200, "image/png"));
        editor.persist_previews();
        assert!(editor.pending.lock().unwrap().is_empty());
        let stored = |name: &str| {
            directory
                .join(crate::cache::DIRECTORY)
                .join(&name[..2])
                .join(name)
        };
        assert_eq!(fs::read(stored(&medium_name(&id))).unwrap(), png.bytes);
        assert!(stored(&thumbnail_name(&id)).is_file());
        drop(editor);

        // After a restart only the disk PNG exists; a raw request gets it.
        let reopened = Editor::new(directory);
        reopened.paused.store(true, Ordering::SeqCst);
        let fallback = reopened.respond(&format!("{url}?format=rgba8"));
        assert_eq!(fallback.bytes, png.bytes);
        assert_eq!(fallback.content_type, "image/png");
        let invalid = reopened.respond(&format!("{url}?format=jpeg"));
        assert_eq!((invalid.status, invalid.content_type), (400, "text/plain"));
    }

    #[test]
    fn clear_disable_drafts_and_changed_sources_do_not_persist() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"source").unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let source = editor.edits.source_revision(&path).unwrap();
        let url = editor
            .register(&path, &source, &EditRecipe::default(), 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let asset = editor.assets.lock().unwrap().recipes[&id].clone();
        let mut frame = b"X3F8\x01\0\0\0\x01\0\0\0\0\0\0\0".to_vec();
        frame.extend([1, 2, 3, 255]);
        let frame = Arc::new(frame);
        // The shared store also holds source fingerprints: look for the images.
        let persisted = |editor: &Editor| {
            editor.persist_previews();
            [medium_name(&id), thumbnail_name(&id)]
                .iter()
                .any(|name| editor.store.get(name, &[], png_valid).is_some())
        };

        // A render that started before Clear: no memory entry, no disk entry.
        let before = editor.store.generation();
        editor.store.clear().unwrap();
        editor.publish_frame(&id, &frame, before, Some(&asset), None);
        assert!(editor.memory.get(&frame_key(&id)).is_none());
        assert!(!persisted(&editor));
        // Queued before Clear, persisted after it: dropped.
        let generation = editor.store.generation();
        editor.publish_frame(&id, &frame, generation, Some(&asset), None);
        editor.store.clear().unwrap();
        editor.memory.clear();
        editor.cache_cleared();
        assert!(!persisted(&editor));
        // Disabled: nothing persists.
        let generation = editor.store.generation();
        editor.publish_frame(&id, &frame, generation, Some(&asset), None);
        editor.store.configure(false, crate::cache::DEFAULT_LIMIT);
        assert!(!persisted(&editor));
        editor.store.configure(true, crate::cache::DEFAULT_LIMIT);
        // A draft has no asset to persist; its derived thumbnail stays in memory.
        let generation = editor.store.generation();
        editor.assets.lock().unwrap().drafts.insert(id.clone());
        editor.publish_frame(&id, &frame, generation, None, None);
        assert!(editor.pending.lock().unwrap().is_empty());
        assert_eq!(
            editor
                .respond(&format!("{url}?v=thumbnail&cacheOnly=1"))
                .status,
            200
        );
        assert!(!persisted(&editor));
        editor.assets.lock().unwrap().drafts.clear();
        // The source changed after the render: not persisted.
        editor.publish_frame(&id, &frame, generation, Some(&asset), None);
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&path, b"changed").unwrap();
        editor.memory.clear();
        assert!(!persisted(&editor));
        fs::write(&path, b"source").unwrap();
        let asset = Asset {
            source_revision: editor.edits.source_revision(&path).unwrap(),
            ..asset
        };
        editor.publish_frame(&id, &frame, generation, Some(&asset), None);
        assert!(persisted(&editor));
    }

    #[test]
    fn waiting_requests_follow_priority_then_age() {
        let gate: PreviewGate = Arc::new((Mutex::new(PreviewWork::default()), Condvar::new()));
        let low = Waiter::new(&gate, PRIORITY_LOW).unwrap();
        let normal = Waiter::new(&gate, PRIORITY_NORMAL).unwrap();
        let later = Waiter::new(&gate, PRIORITY_NORMAL).unwrap();
        let high = Waiter::new(&gate, PRIORITY_HIGH).unwrap();
        let first = |waiter: &Waiter| waiter.first(&gate.0.lock().unwrap());
        assert!(first(&high) && !first(&normal));
        drop(high);
        assert!(first(&normal) && !first(&later));
        drop(normal);
        assert!(first(&later));
        drop(later);
        assert!(first(&low));
        drop(low);
        assert!(gate.0.lock().unwrap().waiting.is_empty());
    }

    #[test]
    fn image_request_registration_is_bounded_and_cancels_only_its_active_work() {
        let temporary = tempfile::tempdir().unwrap();
        let editor = Editor::new(temporary.path().join("edits"));
        let requests: Vec<_> = (0..128)
            .map(|_| editor.begin_image_request().unwrap())
            .collect();
        assert!(editor.begin_image_request().is_err());
        let active = Arc::new(AtomicBool::new(false));
        {
            let mut work = editor.preview_work.0.lock().unwrap();
            work.background_request = Some(requests[0].clone());
            work.background_cancel = active.clone();
        }
        editor.end_image_request(&requests[1]).unwrap();
        editor.end_image_request(&requests[1]).unwrap();
        assert!(!active.load(Ordering::SeqCst));
        assert!(editor.begin_image_request().is_ok());
        let expired = format!("{}?requestId={}", asset_url(&"a".repeat(64)), requests[1]);
        assert!(editor.image_uri(&expired).unwrap_err().contains("expired"));
        editor.end_image_request(&requests[0]).unwrap();
        assert!(active.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelled_image_request_leaves_foreground_wait_without_decoding() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"Not a decodable RAW").unwrap();
        let editor = Arc::new(Editor::new(temporary.path().join("edits")));
        let url = editor
            .register(&path, &"a".repeat(64), &EditRecipe::default(), 640, None)
            .unwrap();
        let request = editor.begin_image_request().unwrap();
        let uri = format!("{url}?requestId={request}");
        let foreground = editor.foreground_request().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let image = editor.clone();
        let task = std::thread::spawn(move || send.send(image.image_uri(&uri)).unwrap());
        assert!(matches!(
            receive.recv_timeout(std::time::Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        editor.end_image_request(&request).unwrap();
        assert!(receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .contains("cancelled"));
        task.join().unwrap();
        assert!(editor.worker.lock().unwrap().renderer.is_none());
        drop(foreground);
    }

    #[test]
    fn cancelled_image_request_leaves_worker_wait_without_decoding() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"Not a decodable RAW").unwrap();
        let editor = Arc::new(Editor::new(temporary.path().join("edits")));
        let id = protocol_id(
            &editor
                .register(&path, &"a".repeat(64), &EditRecipe::default(), 2048, None)
                .unwrap(),
        )
        .unwrap();
        let request = editor.begin_image_request().unwrap();
        let cancel = editor.image_requests.lock().unwrap()[&request].clone();
        let worker = editor.worker.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let image = editor.clone();
        let requested = request.clone();
        let task = std::thread::spawn(move || {
            send.send(image.image_request(
                &id,
                true,
                false,
                Some((&requested, &cancel)),
                PRIORITY_HIGH,
            ))
            .unwrap();
        });
        assert!(matches!(
            receive.recv_timeout(std::time::Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        editor.end_image_request(&request).unwrap();
        assert!(receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .contains("cancelled"));
        task.join().unwrap();
        assert!(worker.renderer.is_none());
        drop(worker);
    }

    #[test]
    fn browsing_yields_to_foreground_and_reuses_its_completed_pixels() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"Not a decodable RAW").unwrap();
        let editor = Arc::new(Editor::new(temporary.path().join("edits")));
        let url = editor
            .register(&path, &"a".repeat(64), &EditRecipe::default(), 640, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let cancel = editor
            .preview_work
            .0
            .lock()
            .unwrap()
            .background_cancel
            .clone();
        let foreground = editor.foreground_request().unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        let (send, receive) = std::sync::mpsc::channel();
        let image = editor.clone();
        let requested = id.clone();
        let task = std::thread::spawn(move || send.send(image.image(&requested)).unwrap());
        assert!(matches!(
            receive.recv_timeout(std::time::Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(
            editor.worker.try_lock().is_ok(),
            "Waiting thumbnails must release the GPU worker"
        );
        editor
            .memory
            .put(png_key(&id), Arc::new(b"completed pixels".to_vec()));
        drop(foreground);
        assert_eq!(
            &**receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            b"completed pixels"
        );
        task.join().unwrap();
        assert!(editor.worker.lock().unwrap().renderer.is_none());
    }
}
