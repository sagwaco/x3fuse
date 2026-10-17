//! One RAW preparation/GPU worker shared by interactive previews and edited exports.
pub use crate::edits::EditRecord;
use crate::{
    edits::Edits,
    model::{source_path, BatchSettings, ColorProfile, OutputFormat},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
};
use x3f_core::{SceneLinearImage, SceneLinearOptions};
use x3f_render::{Crop, EditRecipe, PreparedImage, RenderOptions, Renderer};

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
    /// Denoise settings do not change this source, as for a merged X3I.
    denoise_free: bool,
    image: PreparedImage,
}
impl Prepared {
    fn matches_denoise(&self, recipe: &EditRecipe) -> bool {
        self.denoise_free
            || (self.denoise == recipe.denoise && self.denoise_options == recipe.denoise_options)
    }
    fn matches_source(&self, path: &Path, source_revision: &str) -> bool {
        self.path == path && self.source_revision == source_revision
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
}
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
    /// Encoded PNG previews.
    pngs: Images,
    /// Raw RGBA8 frame bodies. A frame is read once after its render, and
    /// again only to encode a PNG on demand. 128 MiB holds two 4096 px frames
    /// or eleven 2048 px frames.
    frames: Images,
}
/// Bodies by preview ID, least recently used first out, at most 128 MiB and 128 entries.
#[derive(Default)]
struct Images {
    images: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
    bytes: usize,
}
impl Images {
    const BUDGET: usize = 128 * 1024 * 1024;
    fn get(&mut self, id: &str) -> Option<Arc<Vec<u8>>> {
        let image = self.images.get(id)?.clone();
        self.order.retain(|entry| entry != id);
        self.order.push_back(id.into());
        Some(image)
    }
    fn put(&mut self, id: String, bytes: impl Into<Arc<Vec<u8>>>) {
        let bytes = bytes.into();
        if bytes.len() > Self::BUDGET {
            return;
        }
        if let Some(old) = self.images.remove(&id) {
            self.bytes -= old.len();
        }
        self.order.retain(|entry| entry != &id);
        self.bytes += bytes.len();
        self.images.insert(id.clone(), bytes);
        self.order.push_back(id);
        while self.bytes > Self::BUDGET || self.images.len() > 128 {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if let Some(bytes) = self.images.remove(&old) {
                self.bytes -= bytes.len();
            }
        }
    }
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
    /// Frames whose medium and thumbnail PNGs are not yet persisted.
    pending: Mutex<VecDeque<(String, Arc<Vec<u8>>)>>,
    image_requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    thumbnails: PathBuf,
    mediums: PathBuf,
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
    pub as_shot_camera_profile: String,
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
        ..Default::default()
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
}

impl Editor {
    pub fn new(directory: PathBuf) -> Self {
        crate::x3i::prune(&directory.join(crate::x3i::DIRECTORY));
        Self {
            thumbnails: directory.join("thumbnails-v1"),
            x3i: directory.join(crate::x3i::DIRECTORY),
            x3i_jobs: Mutex::new(HashMap::new()),
            mediums: directory.join("mediums-v1"),
            edits: Edits::new(directory),
            session: Mutex::new(None),
            worker: Mutex::new(Worker::default()),
            preview_work: Arc::new((Mutex::new(PreviewWork::default()), Condvar::new())),
            preview_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            warm: Mutex::new(None),
            opening: AtomicU64::new(0),
            render_revision: AtomicU64::new(u64::MAX),
            assets: Mutex::new(Assets::default()),
            pending: Mutex::new(VecDeque::new()),
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
        let as_shot_crop = x3f_core::read_as_shot_crop(&path)
            .map_err(|e| e.to_string())?
            .map(|[x, y, width, height]| Crop {
                x,
                y,
                width,
                height,
            });
        let camera_profiles = x3f_render::read_camera_profiles(&path, &AtomicBool::new(false))
            .map_err(|e| e.to_string())?;
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
            as_shot_recipe(as_shot_crop, &camera_profiles.as_shot, &source_revision)
        });
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
            as_shot_camera_profile: camera_profiles.as_shot,
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
        let options = scene_options(recipe);
        Ok(Some(X3iStatus {
            frames,
            processed: crate::x3i::processed(&self.x3i, &path, &source_revision, &options),
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
        let options = scene_options(recipe);
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

    /// Returns camera defaults without writing a sidecar or backup.
    pub fn default_recipe(
        &self,
        path: &Path,
        source_revision: &str,
        cancel: &AtomicBool,
    ) -> Result<EditRecipe, String> {
        check_cancel(cancel)?;
        let crop = x3f_core::read_as_shot_crop(path)
            .map_err(|e| e.to_string())?
            .map(|[x, y, width, height]| Crop {
                x,
                y,
                width,
                height,
            });
        let profiles = x3f_render::read_camera_profiles(path, cancel).map_err(|e| e.to_string())?;
        if self.edits.source_revision(path)? != source_revision {
            return Err("Source changed while reading camera defaults".into());
        }
        Ok(as_shot_recipe(crop, &profiles.as_shot, source_revision))
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
        recipe.validate()?;
        if !(1..=4096).contains(&max_edge) {
            return Err("Invalid preview dimensions".into());
        }
        if let Some(region) = region {
            region.validate()?;
        }
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        // The renderer version is part of the key: an unchanged recipe renders
        // differently after the renderer changes, and the persisted thumbnail
        // and medium PNGs would otherwise keep showing the old pixels beside
        // freshly rendered exports. Superseded entries fall out of the caches
        // through the existing size/count eviction in `store_image`.
        let mut key = serde_json::to_vec(&(
            &canonical,
            source_revision,
            recipe,
            max_edge,
            region,
            x3f_render::RENDER_VERSION,
        ))
        .map_err(|e| e.to_string())?;
        // An X3I renders differently after its merge changes. X3F keys stay as they were.
        if let Some(identity) = crate::x3i::identity(&canonical) {
            key.extend(identity.as_bytes());
        }
        let id = format!("{:x}", Sha256::digest(key));
        let mut assets = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?;
        if !assets.recipes.contains_key(&id) {
            assets.recipes.insert(
                id.clone(),
                Asset {
                    path: canonical,
                    source_revision: source_revision.into(),
                    recipe: recipe.clone(),
                    max_edge,
                    region,
                },
            );
            assets.recipe_order.push_back(id.clone());
            // ponytail: bounded snapshot registry; renew expired URLs through editor:preview.
            while assets.recipes.len() > 16384 {
                if let Some(old) = assets.recipe_order.pop_front() {
                    assets.recipes.remove(&old);
                }
            }
        }
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
        let same_source = worker
            .prepared
            .as_ref()
            .is_some_and(|p| p.matches_source(&asset.path, &asset.source_revision));
        let reuse = same_source
            && worker
                .prepared
                .as_ref()
                .is_some_and(|p| p.matches_denoise(&asset.recipe));
        if !reuse {
            // Keep the responsive source if refinement is interrupted. A different
            // photo releases it first to bound memory while browsing.
            if !same_source {
                worker.prepared = None;
            }
            let options = scene_options(&asset.recipe);
            let (image, denoise_free) = prepare_in_background(|| {
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
            })?;
            let profiles =
                x3f_render::read_camera_profiles(&asset.path, cancel).map_err(|e| e.to_string())?;
            check_cancel(cancel)?;
            if self.edits.source_revision(&asset.path)? != asset.source_revision {
                return Err("Source contents changed during RAW preparation".into());
            }
            worker.prepared = Some(Prepared {
                path: asset.path.clone(),
                source_revision: asset.source_revision.clone(),
                denoise: asset.recipe.denoise,
                denoise_options: asset.recipe.denoise_options,
                denoise_free,
                image: PreparedImage::new(image, cancel)
                    .map_err(|e| e.to_string())?
                    .with_camera_profiles(profiles),
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
    /// denoise. Before any RAW is prepared, it skips only BM3D, which can take
    /// seconds; the first preparation applies NLM at once. Returns the recipe
    /// and whether the frame is a draft.
    fn effective_recipe(
        worker: &Worker,
        request: &RenderRequest,
        session: &Session,
    ) -> (EditRecipe, bool) {
        let mut recipe = request.recipe.clone();
        if request.interactive {
            if let Some(prepared) = worker
                .prepared
                .as_ref()
                .filter(|p| p.matches_source(&session.path, &session.source_revision))
            {
                if !prepared.denoise_free {
                    recipe.denoise = prepared.denoise;
                    recipe.denoise_options = prepared.denoise_options;
                }
            } else if recipe.denoise_options.algorithm == x3f_core::DenoiseAlgorithm::Bm3d {
                recipe.denoise = 0;
            }
        }
        let draft = recipe.denoise != request.recipe.denoise
            || recipe.denoise_options != request.recipe.denoise_options;
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
        request.recipe.validate()?;
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "Renderer unavailable; restart the app")?;
        let (recipe, draft) = Self::effective_recipe(&worker, &request, &session);
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
        let as_shot = worker
            .prepared
            .as_ref()
            .map(|p| p.image.as_shot_white_balance());
        drop(worker);
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
            as_shot_temperature: as_shot.map(|(k, _)| k),
            as_shot_tint: as_shot.map(|(_, t)| t),
        };
        let frame = Arc::new(frame_body(rendered)?);
        check_cancel(&cancel)?;
        self.session(&preview.session_id)?;
        self.assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?
            .frames
            .put(id.clone(), frame.clone());
        // PNGs are encoded on demand. Only a refined medium is persisted, by
        // `persist_previews` after the frame is returned.
        if !draft && request.max_edge == 2048 && request.region.is_none() {
            self.defer_persist(id, frame);
        }
        Ok(preview)
    }

    /// Queues a frame for `persist_previews`. Only the newest jobs are kept;
    /// a dropped job is encoded on demand instead.
    fn defer_persist(&self, id: String, frame: Arc<Vec<u8>>) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|(queued, _)| queued != &id);
            pending.push_back((id, frame));
            while pending.len() > 4 {
                pending.pop_front();
            }
        }
    }

    /// Encodes and persists the queued medium and thumbnail PNGs. Call it off
    /// the critical path, after the frame went to the webview.
    pub fn persist_previews(&self) {
        while let Some((id, frame)) = self.pending.lock().ok().and_then(|mut p| p.pop_front()) {
            let Ok(rendered) = frame_image(&frame) else {
                continue;
            };
            self.prime_thumbnail(&id, &rendered);
            if matches!(self.cached_png(&id), Ok(None)) {
                if let Ok(png) = rendered.png() {
                    self.store_image(&id, png);
                }
            }
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
        self.ready(worker, asset, cancel)?;
        let Worker { renderer, prepared } = worker;
        let prepared = prepared.as_ref().ok_or("RAW preparation unavailable")?;
        let rendered = renderer
            .as_mut()
            .ok_or("GPU renderer unavailable")?
            .render_prepared(
                &prepared.image,
                &asset.recipe,
                preview_options(asset),
                cancel,
            )
            .map_err(|e| e.to_string())?;
        check_cancel(cancel)?;
        Ok((rendered, oriented_size(prepared.image.image())))
    }

    fn thumbnail_id(&self, id: &str) -> Result<String, String> {
        let asset = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?
            .recipes
            .get(id)
            .cloned()
            .ok_or("Preview expired; reopen the photo")?;
        protocol_id(&self.register(
            &asset.path,
            &asset.source_revision,
            &asset.recipe,
            640,
            asset.region,
        )?)
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

    /// Serves an `x3f-edit` request: an edited preview as an RGBA8 frame or a PNG.
    pub fn respond(&self, uri: &str) -> Body {
        let octets = "application/octet-stream";
        match self.image_uri(uri) {
            Ok(bytes) => {
                let bytes = Arc::unwrap_or_clone(bytes);
                let png = bytes.starts_with(PNG_SIGNATURE);
                Body {
                    status: 200,
                    content_type: if png { "image/png" } else { octets },
                    bytes,
                }
            }
            Err(error) => Body {
                status: 400,
                bytes: error.into_bytes(),
                content_type: "text/plain",
            },
        }
    }

    pub fn image_uri(&self, uri: &str) -> Result<Arc<Vec<u8>>, String> {
        let id = protocol_id(uri)?;
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
        let id = match url
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value)
        {
            None => id,
            Some(variant) if variant == "thumbnail" => self.thumbnail_id(&id)?,
            _ => return Err("Invalid rendered preview variant".into()),
        };
        let raw = match url.query_pairs().find(|(key, _)| key == "format") {
            None => false,
            Some((_, format)) if format == "rgba8" => true,
            _ => return Err("Invalid rendered preview format".into()),
        };
        self.image_request(
            &id,
            request
                .as_ref()
                .map(|(id, cancel)| (id.as_str(), cancel.as_ref())),
            raw,
        )
    }

    fn image_cache(&self, asset: &Asset) -> Option<(&Path, u64, u64)> {
        match (asset.max_edge, asset.region.is_none()) {
            (640, _) => Some((&self.thumbnails, 2 * 1024 * 1024, 256 * 1024 * 1024)),
            (2048, true) => Some((&self.mediums, 16 * 1024 * 1024, 1024 * 1024 * 1024)),
            _ => None,
        }
    }

    /// A finished preview: with `raw`, the RGBA8 frame, or else a PNG that
    /// exists already (the frame layer decodes either body). Without `raw`, a
    /// PNG, encoded from a cached frame when needed.
    fn cached_image(&self, id: &str, raw: bool) -> Result<Option<Arc<Vec<u8>>>, String> {
        let frame = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?
            .frames
            .get(id);
        if raw {
            return Ok(match frame {
                Some(frame) => Some(frame),
                None => self.cached_png(id)?,
            });
        }
        if let Some(png) = self.cached_png(id)? {
            return Ok(Some(png));
        }
        let Some(frame) = frame else {
            return Ok(None);
        };
        let png = frame_image(&frame)?.png().map_err(|e| e.to_string())?;
        self.store_image(id, png);
        self.cached_png(id)
    }

    fn cached_png(&self, id: &str) -> Result<Option<Arc<Vec<u8>>>, String> {
        let mut assets = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?;
        if let Some(image) = assets.pngs.get(id) {
            return Ok(Some(image));
        }
        let Some((directory, max_size, _)) = assets
            .recipes
            .get(id)
            .and_then(|asset| self.image_cache(asset))
        else {
            return Ok(None);
        };
        let path = directory.join(format!("{id}.png"));
        if fs::metadata(&path).is_ok_and(|m| m.len() <= max_size) {
            if let Ok(bytes) = fs::read(path) {
                // Cache writes are atomic. Reject missing/truncated PNGs and regenerate.
                if bytes.starts_with(PNG_SIGNATURE) && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82") {
                    assets.pngs.put(id.into(), bytes);
                    return Ok(assets.pngs.get(id));
                }
            }
        }
        Ok(None)
    }

    fn store_image(&self, id: &str, bytes: Vec<u8>) {
        // A disposable cache must never make a successful preview/save fail.
        let _ = (|| -> std::io::Result<()> {
            let Some((directory, max_size, budget)) = self.assets.lock().ok().and_then(|assets| {
                assets
                    .recipes
                    .get(id)
                    .and_then(|asset| self.image_cache(asset))
            }) else {
                return Ok(());
            };
            if bytes.len() as u64 > max_size {
                return Ok(());
            }
            fs::create_dir_all(directory)?;
            let mut file = tempfile::NamedTempFile::new_in(directory)?;
            file.write_all(&bytes)?;
            file.persist(directory.join(format!("{id}.png")))?;
            let mut entries: Vec<_> = fs::read_dir(directory)?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
                .filter_map(|entry| entry.metadata().ok().map(|meta| (entry.path(), meta)))
                .collect();
            entries.sort_by_key(|(_, meta)| meta.modified().ok());
            let mut size: u64 = entries.iter().map(|(_, meta)| meta.len()).sum();
            let mut count = entries.len();
            // ponytail: scan a bounded cache on writes; use an index above 512 images.
            for (path, meta) in entries {
                if size <= budget && count <= 512 {
                    break;
                }
                if fs::remove_file(path).is_ok() {
                    size -= meta.len();
                    count -= 1;
                }
            }
            Ok(())
        })();
        if let Ok(mut assets) = self.assets.lock() {
            // An ID names exact pixels. Keep the PNG that a concurrent request
            // stored first, so that all requests share one copy.
            if assets.pngs.get(id).is_none() {
                assets.pngs.put(id.into(), bytes);
            }
        }
    }

    fn prime_thumbnail(&self, id: &str, rendered: &x3f_render::RenderedImage) {
        if let Ok(thumbnail) = self.thumbnail_id(id) {
            if matches!(self.cached_png(&thumbnail), Ok(None)) {
                if let Ok(bytes) = rendered.png_preview(640) {
                    self.store_image(&thumbnail, bytes);
                }
            }
        }
    }

    pub fn image(&self, id: &str) -> Result<Arc<Vec<u8>>, String> {
        self.image_request(id, None, false)
    }

    fn image_request(
        &self,
        id: &str,
        request: Option<(&str, &AtomicBool)>,
        raw: bool,
    ) -> Result<Arc<Vec<u8>>, String> {
        let uncancellable = AtomicBool::new(false);
        let request_cancel = request.map_or(&uncancellable, |(_, cancel)| cancel);
        loop {
            check_cancel(request_cancel)?;
            if let Some(image) = self.cached_image(id, raw)? {
                check_cancel(request_cancel)?;
                return Ok(image);
            }
            let mut worker = match self.worker.try_lock() {
                Ok(worker) => worker,
                Err(std::sync::TryLockError::WouldBlock) => {
                    let work = self
                        .preview_work
                        .0
                        .lock()
                        .map_err(|_| "Renderer unavailable")?;
                    check_cancel(request_cancel)?;
                    // ponytail: poll availability every 10 ms; notify on worker
                    // release if needed. Cancellation wakes this wait immediately.
                    drop(
                        self.preview_work
                            .1
                            .wait_timeout(work, std::time::Duration::from_millis(10))
                            .map_err(|_| "Renderer unavailable")?,
                    );
                    continue;
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Renderer unavailable; restart the app".into());
                }
            };
            check_cancel(request_cancel)?;
            // Recheck after waiting: a duplicate request or editor refinement may
            // already have generated this snapshot.
            if let Some(image) = self.cached_image(id, raw)? {
                check_cancel(request_cancel)?;
                return Ok(image);
            }
            let mut work = self
                .preview_work
                .0
                .lock()
                .map_err(|_| "Renderer unavailable")?;
            check_cancel(request_cancel)?;
            if work.foreground > 0 {
                drop(worker);
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
            let cancel = Arc::new(AtomicBool::new(false));
            work.background_cancel = cancel.clone();
            work.background_request = request.map(|(id, _)| id.to_owned());
            drop(work);
            let asset = self
                .assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?
                .recipes
                .get(id)
                .cloned()
                .ok_or("Preview expired; reopen the photo")?;
            // A background photo must not evict the active editor's prepared RAW;
            // otherwise every preemption would make the next slider change decode again.
            let active = self.kept_source()?;
            let preserve = worker.prepared.as_ref().is_some_and(|prepared| {
                active.as_ref() == Some(&prepared.path)
                    && (prepared.path != asset.path
                        || prepared.source_revision != asset.source_revision
                        || !prepared.matches_denoise(&asset.recipe))
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
            check_cancel(request_cancel)?;
            let rendered = match result {
                Ok((rendered, _)) => rendered,
                Err(_)
                    if cancel.load(Ordering::SeqCst)
                        && !self.paused.load(Ordering::SeqCst)
                        && !self.close_allowed.load(Ordering::SeqCst) =>
                {
                    // Let interactive work run first, then retry this immutable
                    // snapshot instead of returning a broken thumbnail to WebKit.
                    continue;
                }
                Err(error) => return Err(error),
            };
            let frame = Arc::new(frame_body(rendered)?);
            self.assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?
                .frames
                .put(id.into(), frame.clone());
            if raw {
                if self.image_cache(&asset).is_some() {
                    self.defer_persist(id.into(), frame.clone());
                }
                check_cancel(request_cancel)?;
                return Ok(frame);
            }
            let rendered = frame_image(&frame)?;
            if asset.max_edge == 2048 && asset.region.is_none() {
                self.prime_thumbnail(id, &rendered);
            }
            self.store_image(id, rendered.png().map_err(|e| e.to_string())?);
            check_cancel(request_cancel)?;
            return self
                .cached_png(id)?
                .ok_or_else(|| "Preview cache unavailable".into());
        }
    }

    pub fn pick_white_balance(
        &self,
        id: &str,
        recipe: EditRecipe,
        x: f32,
        y: f32,
    ) -> Result<(f32, f32), String> {
        if self.paused.load(Ordering::SeqCst) {
            return Err("White balance sampling pauses during export".into());
        }
        recipe.validate()?;
        let session = self.session(id)?;
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
        let result = x3f_render::pick_white_balance(image, &asset.recipe, x, y)
            .map_err(|e| e.to_string())?;
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
        recipe.validate()?;
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
        let result = renderer
            .as_mut()
            .ok_or("GPU renderer unavailable")?
            .render_prepared(
                &prepared
                    .as_ref()
                    .ok_or("RAW preparation unavailable")?
                    .image,
                recipe,
                RenderOptions {
                    max_dimension: None,
                    region: None,
                    color_profile,
                    rgba8: false,
                },
                cancel,
            )
            .map_err(|e| e.to_string())?;
        check_cancel(cancel)?;
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

fn as_shot_recipe(crop: Option<Crop>, profile: &str, source_revision: &str) -> EditRecipe {
    EditRecipe {
        camera_profile: Some(profile.into()),
        film: None,
        monochrome: (profile == "Monochrome").then(x3f_render::MonochromeSettings::default),
        crop,
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
        crop: base.crop,
        seed: base.seed,
        ..recipe.clone()
    };
    probe == base
}

/// True when `recipe` is the photo's `defaults`. With `legacy` (a document from
/// an earlier build), also the default film with the as-shot crop and seed: those
/// builds saved it for every opened photo.
fn matches_defaults(recipe: &EditRecipe, defaults: &EditRecipe, legacy: bool) -> bool {
    *recipe == *defaults
        || legacy
            && *recipe
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
        max_dimension: Some(asset.max_edge),
        region: asset.region,
        color_profile: x3f_render::ColorProfile::Srgb,
        rgba8: true,
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
/// header (width, height and 0 as little-endian u32) in front of the rows.
fn frame_body(rendered: x3f_render::RenderedImage) -> Result<Vec<u8>, String> {
    match rendered.data {
        x3f_render::Pixels::Rgba8(frame) => Ok(frame),
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
    if frame.len() - 16 != width as usize * height as usize * 4 {
        return Err("Invalid preview frame".into());
    }
    Ok(x3f_render::RenderedImage {
        width,
        height,
        data: x3f_render::Pixels::Rgba8(frame.to_vec()),
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
    #[test]
    #[ignore = "set X3F_CAMERA_PROFILE_INPUT to a real file with FCBlue calibration"]
    fn real_camera_defaults_do_not_save_and_existing_recipes_are_preserved() {
        use std::io::{Read, Seek, SeekFrom};
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
        assert_eq!(session.as_shot_camera_profile, "FCBlue");
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
        let worker = Worker::default();
        let nlm = request(x3f_core::DenoiseAlgorithm::Nlm);
        assert_eq!(
            Editor::effective_recipe(&worker, &nlm, &session),
            (nlm.recipe.clone(), false)
        );
        let bm3d = request(x3f_core::DenoiseAlgorithm::Bm3d);
        let (recipe, draft) = Editor::effective_recipe(&worker, &bm3d, &session);
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
    fn preview_urls_and_cache_are_bounded() {
        let id = "a".repeat(64);
        assert_eq!(protocol_id(&asset_url(&id)).unwrap(), id);
        assert!(protocol_id("x3f-edit://localhost/../../etc/passwd").is_err());
        assert!(protocol_id(&format!("https://example.com/{id}")).is_err());
        let mut cache = Images::default();
        for n in 0..140 {
            cache.put(n.to_string(), vec![0; 4]);
        }
        assert_eq!(cache.images.len(), 128);
        assert_eq!(cache.bytes, 512);
        assert!(cache.get("12").is_some());
        cache.put("next".into(), vec![0; 4]);
        assert!(
            cache.get("12").is_some(),
            "A cache hit must renew its LRU position"
        );
        assert!(cache.get("13").is_none());
    }

    #[test]
    fn thumbnails_survive_eviction_restart_and_editor_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let directory = temporary.path().join("edits");
        let recipe = EditRecipe::default();
        let editor = Editor::new(directory.clone());
        let url = editor
            .register(&path, &"a".repeat(64), &recipe, 2048, None)
            .unwrap();
        let rendered = x3f_render::RenderedImage {
            width: 900,
            height: 600,
            data: x3f_render::Pixels::Rgb16(vec![32768; 900 * 600 * 3]),
            color_profile: x3f_render::ColorProfile::Srgb,
            full_width: 900,
            full_height: 600,
            region: None,
        };
        editor.prime_thumbnail(&protocol_id(&url).unwrap(), &rendered);
        let uri = format!("{url}?v=thumbnail");
        let expected = editor.image_uri(&uri).unwrap();
        assert_eq!(
            u32::from_be_bytes(expected[16..20].try_into().unwrap()),
            640
        );
        assert_eq!(
            u32::from_be_bytes(expected[20..24].try_into().unwrap()),
            427
        );
        drop(editor);

        let reopened = Editor::new(directory);
        assert_eq!(
            reopened
                .register(&path, &"a".repeat(64), &recipe, 2048, None)
                .unwrap(),
            url
        );
        reopened.cancel_preview();
        reopened.paused.store(true, Ordering::SeqCst);
        assert_eq!(*reopened.image_uri(&uri).unwrap(), *expected);
        assert!(reopened.worker.lock().unwrap().renderer.is_none());
        assert!(reopened.image_uri(&format!("{url}?v=unknown")).is_err());

        *reopened.session.lock().unwrap() = Some(Session {
            id: "active".into(),
            path: path.clone(),
            source_revision: "a".repeat(64),
            cancelled_revision: None,
        });
        reopened.worker.lock().unwrap().prepared = Some(Prepared {
            path: path.clone(),
            source_revision: "a".repeat(64),
            denoise: recipe.denoise,
            denoise_options: recipe.denoise_options,
            denoise_free: false,
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

        let mut changed = recipe.clone();
        changed.exposure = 1.;
        for (source, recipe) in [("b".repeat(64), &recipe), ("a".repeat(64), &changed)] {
            let url = reopened
                .register(&path, &source, recipe, 2048, None)
                .unwrap();
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
    fn medium_previews_survive_eviction_restart_and_keep_source_and_recipe_identity() {
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
        let rendered = x3f_render::RenderedImage {
            width: 2048,
            height: 1024,
            data: x3f_render::Pixels::Rgb16(vec![32768; 2048 * 1024 * 3]),
            color_profile: x3f_render::ColorProfile::Srgb,
            full_width: 2048,
            full_height: 1024,
            region: None,
        };
        let expected = rendered.png().unwrap();
        editor.store_image(&id, expected.clone());
        assert_eq!(
            fs::read(directory.join("mediums-v1").join(format!("{id}.png"))).unwrap(),
            expected
        );
        assert!(!directory.join("thumbnails-v1").exists());
        {
            let mut assets = editor.assets.lock().unwrap();
            for n in 0..128 {
                assets.pngs.put(format!("evict-{n}"), vec![0]);
            }
            assert!(assets.pngs.get(&id).is_none());
        }
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
        for (source, recipe) in [
            ("b".repeat(64), &recipe),
            (source.clone(), &draft),
            (source.clone(), &bm3d),
            (source, &chroma),
        ] {
            let distinct = reopened
                .register(&path, &source, recipe, 2048, None)
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
    fn frames_serve_raw_then_encode_and_persist_png_on_demand() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("photo.X3F");
        fs::write(&path, b"No RAW decoding should be needed").unwrap();
        let directory = temporary.path().join("edits");
        let editor = Editor::new(directory.clone());
        let url = editor
            .register(&path, &"a".repeat(64), &EditRecipe::default(), 2048, None)
            .unwrap();
        let id = protocol_id(&url).unwrap();
        let mut frame = b"X3F8\x03\0\0\0\x02\0\0\0\0\0\0\0".to_vec();
        frame.extend([10, 20, 30, 255].repeat(6));
        assert_eq!(frame_image(&frame).unwrap().rgb8(), [10, 20, 30].repeat(6));
        assert!(frame_image(&frame[..20]).is_err());
        let frame = Arc::new(frame);
        editor
            .assets
            .lock()
            .unwrap()
            .frames
            .put(id.clone(), frame.clone());
        editor.defer_persist(id.clone(), frame.clone());
        // No render may start: every body below comes from the frame or disk.
        editor.paused.store(true, Ordering::SeqCst);
        let raw = editor.respond(&format!("{url}?format=rgba8"));
        assert_eq!(raw.status, 200);
        assert_eq!(raw.bytes, *frame);
        assert_eq!(raw.content_type, "application/octet-stream");
        let png = editor.respond(&url);
        assert_eq!((png.status, png.content_type), (200, "image/png"));
        let medium = directory.join("mediums-v1").join(format!("{id}.png"));
        assert_eq!(fs::read(&medium).unwrap(), png.bytes);
        editor.persist_previews();
        assert!(editor.pending.lock().unwrap().is_empty());
        assert!(directory.join("thumbnails-v1").is_dir());

        // After a restart only the disk PNG exists; a raw request gets it.
        let reopened = Editor::new(directory);
        reopened.paused.store(true, Ordering::SeqCst);
        reopened
            .register(&path, &"a".repeat(64), &EditRecipe::default(), 2048, None)
            .unwrap();
        let fallback = reopened.respond(&format!("{url}?format=rgba8"));
        assert_eq!(fallback.bytes, png.bytes);
        assert_eq!(fallback.content_type, "image/png");
        let invalid = reopened.respond(&format!("{url}?format=jpeg"));
        assert_eq!((invalid.status, invalid.content_type), (400, "text/plain"));
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
        let editor = Arc::new(Editor::new(temporary.path().join("edits")));
        let request = editor.begin_image_request().unwrap();
        let cancel = editor.image_requests.lock().unwrap()[&request].clone();
        let worker = editor.worker.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let image = editor.clone();
        let requested = request.clone();
        let task = std::thread::spawn(move || {
            send.send(image.image_request(&"a".repeat(64), Some((&requested, &cancel)), false))
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
            .assets
            .lock()
            .unwrap()
            .pngs
            .put(id, b"completed pixels".to_vec());
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
