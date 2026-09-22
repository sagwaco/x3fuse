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
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
};
use x3f_core::{prepare_scene_linear, SceneLinearImage, SceneLinearOptions};
use x3f_render::{Crop, EditRecipe, PreparedImage, RenderOptions, Renderer};

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
    image: PreparedImage,
}
impl Prepared {
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
    images: HashMap<String, Arc<Vec<u8>>>,
    image_order: VecDeque<String>,
    bytes: usize,
}
impl Assets {
    fn get(&mut self, id: &str) -> Option<Arc<Vec<u8>>> {
        let image = self.images.get(id)?.clone();
        self.image_order.retain(|entry| entry != id);
        self.image_order.push_back(id.into());
        Some(image)
    }
    fn put(&mut self, id: String, bytes: Vec<u8>) {
        if bytes.len() > 128 * 1024 * 1024 {
            return;
        }
        if let Some(old) = self.images.remove(&id) {
            self.bytes -= old.len();
        }
        self.image_order.retain(|entry| entry != &id);
        self.bytes += bytes.len();
        self.images.insert(id.clone(), Arc::new(bytes));
        self.image_order.push_back(id);
        while self.bytes > 128 * 1024 * 1024 || self.images.len() > 128 {
            let Some(old) = self.image_order.pop_front() else {
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
    opening: AtomicU64,
    render_revision: AtomicU64,
    assets: Mutex<Assets>,
    image_requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    thumbnails: PathBuf,
    mediums: PathBuf,
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
    pub revision: u64,
    pub source_revision: String,
    pub storage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub session_id: String,
    pub recipe: EditRecipe,
    pub revision: u64,
    pub max_edge: u32,
    pub region: Option<Crop>,
    /// Reuse the current source, or skip NLM for a first frame. Refinement is exact.
    #[serde(default)]
    pub interactive: bool,
}
pub(crate) struct RenderJob {
    request: RenderRequest,
    session: Session,
    cancel: Arc<AtomicBool>,
    priority: ForegroundRequest,
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
}

impl Editor {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            thumbnails: directory.join("thumbnails-v1"),
            mediums: directory.join("mediums-v1"),
            edits: Edits::new(directory),
            session: Mutex::new(None),
            worker: Mutex::new(Worker::default()),
            preview_work: Arc::new((Mutex::new(PreviewWork::default()), Condvar::new())),
            preview_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            opening: AtomicU64::new(0),
            render_revision: AtomicU64::new(u64::MAX),
            assets: Mutex::new(Assets::default()),
            image_requests: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            close_allowed: AtomicBool::new(false),
            close_gate: Mutex::new(()),
            saving: AtomicUsize::new(0),
            has_edit_activity: AtomicBool::new(false),
        }
    }

    pub fn cancel_preview(&self) {
        if let Ok(work) = self.preview_work.0.lock() {
            work.background_cancel.store(true, Ordering::SeqCst);
        }
        if let Ok(cancel) = self.preview_cancel.lock() {
            cancel.store(true, Ordering::SeqCst);
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
                self.cancel_preview();
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
        self.cancel_preview();
        self.edits.flush()?;
        let requested_path = path.clone();
        let path = path.canonicalize().map_err(|e| e.to_string())?;
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
        if self.edits.source_revision(&path)? != source_revision {
            return Err("Source changed while reading camera framing; reopen the photo".into());
        }
        if saved
            .as_ref()
            .is_some_and(|s| s.source_revision != source_revision)
        {
            return Err("Source changed while opening; reopen the photo".into());
        }
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
        let recipe = saved
            .as_ref()
            .map(|r| r.recipe.clone())
            .unwrap_or_else(|| EditRecipe {
                crop: as_shot_crop,
                seed: u32::from_str_radix(&source_revision[..8], 16).unwrap_or(0),
                ..Default::default()
            });
        Ok(EditorSession {
            session_id: session.id,
            path: requested_path,
            source_revision,
            recipe,
            as_shot_crop,
            revision: saved.as_ref().map_or(0, |s| s.revision),
            storage: saved
                .as_ref()
                .map_or_else(|| "none".into(), |s| s.storage.clone()),
            storage_path: saved.as_ref().map(|s| s.storage_path.clone()),
            preview_url: saved.and_then(|s| s.preview_url),
        })
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
        record.preview_url =
            Some(self.register(path, &record.source_revision, &record.recipe, 2048, None)?);
        Ok(record)
    }

    pub fn load(&self, path: &Path) -> Result<Option<EditRecord>, String> {
        let Some(mut record) = self.edits.load(path)? else {
            return Ok(None);
        };
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
        let key = serde_json::to_vec(&(
            &canonical,
            source_revision,
            recipe,
            max_edge,
            region,
            x3f_render::RENDER_VERSION,
        ))
        .map_err(|e| e.to_string())?;
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

    fn prepare<'a>(
        &self,
        worker: &'a mut Worker,
        asset: &Asset,
        cancel: &AtomicBool,
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
                .is_some_and(|p| p.denoise == asset.recipe.denoise);
        if !reuse {
            // Keep the responsive source if refinement is interrupted. A different
            // photo releases it first to bound memory while browsing.
            if !same_source {
                worker.prepared = None;
            }
            let options = SceneLinearOptions {
                denoise_intensity: asset.recipe.denoise,
                highlight_recovery: true,
                ..Default::default()
            };
            let image = prepare_scene_linear(&asset.path, &options, cancel, |_| ())
                .map_err(|e| e.to_string())?;
            check_cancel(cancel)?;
            if self.edits.source_revision(&asset.path)? != asset.source_revision {
                return Err("Source contents changed during RAW preparation".into());
            }
            worker.prepared = Some(Prepared {
                path: asset.path.clone(),
                source_revision: asset.source_revision.clone(),
                denoise: asset.recipe.denoise,
                image: PreparedImage::new(image, cancel).map_err(|e| e.to_string())?,
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
        self.render_job(self.begin_render(request)?)
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
        let mut recipe = request.recipe.clone();
        if request.interactive {
            recipe.denoise = worker
                .prepared
                .as_ref()
                .filter(|p| p.matches_source(&session.path, &session.source_revision))
                .map_or(0, |p| p.denoise);
        }
        let draft = recipe.denoise != request.recipe.denoise;
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
        drop(worker);
        let bytes = rendered.png().map_err(|e| e.to_string())?;
        check_cancel(&cancel)?;
        self.session(&request.session_id)?;
        if !draft && request.max_edge == 2048 && request.region.is_none() {
            self.prime_thumbnail(&id, &rendered);
            self.store_image(&id, bytes);
        } else {
            self.assets
                .lock()
                .map_err(|_| "Preview cache unavailable")?
                .put(id, bytes);
        }
        Ok(RenderedPreview {
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
        })
    }

    fn render_with_worker(
        &self,
        worker: &mut Worker,
        asset: &Asset,
        cancel: &AtomicBool,
    ) -> Result<(x3f_render::RenderedImage, (u32, u32)), String> {
        check_cancel(cancel)?;
        if self.paused.load(Ordering::SeqCst) {
            return Err("Preview rendering pauses during export".into());
        }
        if worker.renderer.is_none() {
            worker.renderer = Some(Renderer::new().map_err(|e| e.to_string())?);
        }
        self.prepare(worker, asset, cancel)?;
        let Worker { renderer, prepared } = worker;
        let image = &prepared
            .as_ref()
            .ok_or("RAW preparation unavailable")?
            .image;
        let rendered = renderer
            .as_mut()
            .ok_or("GPU renderer unavailable")?
            .render_prepared(
                image,
                &asset.recipe,
                RenderOptions {
                    max_dimension: Some(asset.max_edge),
                    region: asset.region,
                    color_profile: x3f_render::ColorProfile::Srgb,
                },
                cancel,
            )
            .map_err(|e| e.to_string())?;
        check_cancel(cancel)?;
        let image = image.image();
        let source_size = if (5..=8).contains(&image.orientation) {
            (image.height, image.width)
        } else {
            (image.width, image.height)
        };
        Ok((rendered, source_size))
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
        self.image_request(
            &id,
            request
                .as_ref()
                .map(|(id, cancel)| (id.as_str(), cancel.as_ref())),
        )
    }

    fn image_cache(&self, asset: &Asset) -> Option<(&Path, u64, u64)> {
        match (asset.max_edge, asset.region.is_none()) {
            (640, _) => Some((&self.thumbnails, 2 * 1024 * 1024, 256 * 1024 * 1024)),
            (2048, true) => Some((&self.mediums, 16 * 1024 * 1024, 1024 * 1024 * 1024)),
            _ => None,
        }
    }

    fn cached_image(&self, id: &str) -> Result<Option<Arc<Vec<u8>>>, String> {
        let mut assets = self
            .assets
            .lock()
            .map_err(|_| "Preview cache unavailable")?;
        if let Some(image) = assets.get(id) {
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
                if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82")
                {
                    assets.put(id.into(), bytes);
                    return Ok(assets.get(id));
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
            assets.put(id.into(), bytes);
        }
    }

    fn prime_thumbnail(&self, id: &str, rendered: &x3f_render::RenderedImage) {
        if let Ok(thumbnail) = self.thumbnail_id(id) {
            if matches!(self.cached_image(&thumbnail), Ok(None)) {
                if let Ok(bytes) = rendered.png_preview(640) {
                    self.store_image(&thumbnail, bytes);
                }
            }
        }
    }

    pub fn image(&self, id: &str) -> Result<Arc<Vec<u8>>, String> {
        self.image_request(id, None)
    }

    fn image_request(
        &self,
        id: &str,
        request: Option<(&str, &AtomicBool)>,
    ) -> Result<Arc<Vec<u8>>, String> {
        let uncancellable = AtomicBool::new(false);
        let request_cancel = request.map_or(&uncancellable, |(_, cancel)| cancel);
        loop {
            check_cancel(request_cancel)?;
            if let Some(image) = self.cached_image(id)? {
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
            if let Some(image) = self.cached_image(id)? {
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
            let active = self
                .session
                .lock()
                .map_err(|_| "Editor unavailable")?
                .as_ref()
                .map(|session| session.path.clone());
            let preserve = worker.prepared.as_ref().is_some_and(|prepared| {
                active.as_ref() == Some(&prepared.path)
                    && (prepared.path != asset.path
                        || prepared.source_revision != asset.source_revision
                        || prepared.denoise != asset.recipe.denoise)
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
            let bytes = rendered.png().map_err(|e| e.to_string())?;
            check_cancel(request_cancel)?;
            if asset.max_edge == 2048 && asset.region.is_none() {
                self.prime_thumbnail(id, &rendered);
            }
            self.store_image(id, bytes);
            check_cancel(request_cancel)?;
            return self
                .cached_image(id)?
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
        let image = self.prepare(&mut worker, &asset, &cancel)?;
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
        self.prepare(&mut worker, &asset, cancel)?;
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

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Rendering cancelled".into())
    } else {
        Ok(())
    }
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
    use super::*;
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
        assert!(editor.prepare(&mut worker, &asset, &cancel).is_err());
        assert_eq!(worker.prepared.as_ref().unwrap().denoise, 0);
        assert_eq!(
            worker.prepared.as_ref().unwrap().image.image().data,
            vec![0.18; 3]
        );
        asset.path = temporary.path().join("next.X3F");
        fs::write(&asset.path, b"another invalid RAW").unwrap();
        asset.source_revision = editor.edits.source_revision(&asset.path).unwrap();
        assert!(editor.prepare(&mut worker, &asset, &cancel).is_err());
        assert!(worker.prepared.is_none());
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
        let mut cache = Assets::default();
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
            data: vec![32768; 900 * 600 * 3],
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
            data: vec![32768; 2048 * 1024 * 3],
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
                assets.put(format!("evict-{n}"), vec![0]);
            }
            assert!(assets.get(&id).is_none());
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
        for (source, recipe) in [("b".repeat(64), &recipe), (source, &draft)] {
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
            send.send(image.image_request(&"a".repeat(64), Some((&requested, &cancel))))
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
