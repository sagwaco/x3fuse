//! Opt-in check that a real folder's previews survive a restart in the shared
//! cache. Two child processes use one copy of the folder and one cache: `warm`
//! makes and stores the previews, and `restart` reads them with cache-only
//! requests and the editor paused. A new process has empty memory caches.
//!
//! X3FUSE_CACHE_SMOKE_DIRECTORY=/absolute/folder \
//! cargo test --manifest-path src-tauri/Cargo.toml --test preview_cache_acceptance \
//!   -- --ignored --exact folder_previews_survive_restart_as_cache_hits --nocapture
//!
//! It needs the bundled ExifTool and a supported GPU. Originals and sidecars
//! are only read; the copies and the cache are in a temporary directory.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use x3fuse_app::{
    cache::{self, Memory, Store},
    editor::Editor,
    metadata::ExifTool,
    preview::Previews,
    storage::Logs,
};

const PHASE: &str = "X3FUSE_CACHE_SMOKE_PHASE";
const ROOT: &str = "X3FUSE_CACHE_SMOKE_ROOT";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.
}

/// Count, median, 95th percentile, maximum and total, in milliseconds.
fn summary(mut values: Vec<f64>) -> Value {
    if values.is_empty() {
        return json!({"count": 0});
    }
    values.sort_by(f64::total_cmp);
    let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
    json!({
        "count": values.len(),
        "p50Ms": at(0.5),
        "p95Ms": at(0.95),
        "maxMs": values[values.len() - 1],
        "totalMs": values.iter().sum::<f64>(),
    })
}

fn sidecar(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".x3fuse.json");
    PathBuf::from(name)
}

struct App {
    store: Arc<Store>,
    previews: Previews,
    editor: Editor,
}

/// The shared caches as the app wires them, in `root`. Without `exiftool`,
/// only the caches can answer.
async fn app(root: &Path, exiftool: bool) -> App {
    let logs = Arc::new(Logs::new(root.join("logs")));
    let store = Store::open(
        root.join("cache").join(cache::DIRECTORY),
        vec![],
        true,
        cache::DEFAULT_LIMIT,
        logs.clone(),
    );
    let memory = Arc::new(Memory::new(cache::memory_budget() / 2));
    x3fuse_app::source::use_store(store.clone());
    let edits = root.join("edits");
    let tool = if exiftool {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/exiftool")
    } else {
        root.join("no-exiftool")
    };
    let exif = Arc::new(ExifTool::new(tool, edits.join("x3i-v1"), logs));
    if exiftool {
        exif.check().await.unwrap();
    }
    App {
        previews: Previews::new(exif, store.clone(), memory.clone()),
        editor: Editor::with_cache(edits, store.clone(), memory),
        store,
    }
}

fn stats(store: &Store) -> Value {
    let s = &store.stats;
    let n = |c: &std::sync::atomic::AtomicU64| c.load(Ordering::Relaxed);
    json!({
        "memoryHits": n(&s.memory_hits),
        "diskHits": n(&s.disk_hits),
        "misses": n(&s.misses),
        "adopted": n(&s.adopted),
        "writes": n(&s.writes),
        "writeFailures": n(&s.write_failures),
        "evicted": n(&s.evicted),
        "derivedThumbnails": n(&s.derived_thumbnails),
        "renders": n(&s.renders),
        "droppedPersistence": n(&s.dropped_persistence),
        "bytes": store.size(),
    })
}

fn inputs(root: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = fs::read_dir(root.join("inputs"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(x3fuse_app::model::is_source_extension)
        })
        .collect();
    paths.sort();
    paths
}

/// Makes every preview, then waits until each is on disk.
async fn warm(root: &Path) -> Value {
    let app = app(root, true).await;
    let paths = inputs(root);
    eprintln!("warm: {} photos", paths.len());
    let started = Instant::now();
    for batch in paths.chunks(1024) {
        app.previews.import(batch).await;
    }
    let import = ms(started);
    let (mut small, mut full, mut thumbnails, mut mediums) = (vec![], vec![], vec![], vec![]);
    let mut manifest = BTreeMap::new();
    for (index, path) in paths.iter().enumerate() {
        if index % 25 == 0 {
            eprintln!("warm: {index}/{} after {:.0} ms", paths.len(), ms(started));
        }
        let start = Instant::now();
        let preview = app.previews.get(path, false, false).await.unwrap().unwrap();
        small.push(ms(start));
        let start = Instant::now();
        let large = app.previews.get(path, true, false).await.unwrap().unwrap();
        full.push(ms(start));
        let mut entry = json!({"small": sha(&preview), "full": sha(&large)});
        if let Some(url) = app.editor.load(path).unwrap().and_then(|r| r.preview_url) {
            let start = Instant::now();
            let thumbnail = app.editor.image_uri(&format!("{url}?v=thumbnail")).unwrap();
            thumbnails.push(ms(start));
            let start = Instant::now();
            let medium = app.editor.image_uri(&url).unwrap();
            mediums.push(ms(start));
            app.editor.persist_previews();
            entry["thumbnail"] = sha(&thumbnail).into();
            entry["medium"] = sha(&medium).into();
        }
        manifest.insert(path.display().to_string(), entry);
    }
    app.editor.persist_previews();
    app.editor.edits.flush_fingerprints();
    eprintln!("warm: waiting for disk writes after {:.0} ms", ms(started));
    // Original disk writes follow their responses. Wait for all of them.
    let deadline = Instant::now() + Duration::from_secs(120);
    let check = Previews::new(
        Arc::new(ExifTool::new(
            root.join("no-exiftool"),
            root.join("x3i"),
            app.store.logs.clone(),
        )),
        app.store.clone(),
        Arc::new(Memory::new(1 << 30)),
    );
    for path in &paths {
        while check.get(path, false, true).await.unwrap().is_none()
            || check.get(path, true, true).await.unwrap().is_none()
        {
            assert!(
                Instant::now() < deadline,
                "{} was not stored",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    app.store.flush();
    let stats = stats(&app.store);
    for counter in ["writeFailures", "droppedPersistence"] {
        assert_eq!(stats[counter], 0, "{counter} while warming: {stats}");
    }
    eprintln!("warm: done after {:.0} ms", ms(started));
    json!({
        "manifest": manifest,
        "latency": {
            "importMs": import,
            "originalSmall": summary(small),
            "originalFull": summary(full),
            "editedThumbnail": summary(thumbnails),
            "editedMedium": summary(mediums),
        },
        "stats": stats,
    })
}

/// Reads every preview from the cache only. No render may start.
async fn restart(root: &Path, manifest: &Value) -> Value {
    let app = app(root, false).await;
    app.editor.cancel_preview();
    app.editor.paused.store(true, Ordering::SeqCst);
    let paths = inputs(root);
    eprintln!("restart: {} photos", paths.len());
    // Import metadata comes from the cache: ExifTool is missing.
    let started = Instant::now();
    let mut imported = 0;
    for batch in paths.chunks(1024) {
        imported += app.previews.import(batch).await.len();
    }
    let import = ms(started);
    assert_eq!(imported, paths.len(), "Import metadata after a restart");
    let (mut small, mut full, mut loads, mut thumbnails, mut mediums) =
        (vec![], vec![], vec![], vec![], vec![]);
    let mut edited = 0;
    for (index, path) in paths.into_iter().enumerate() {
        if index % 25 == 0 {
            eprintln!("restart: {index} photos after {:.0} ms", ms(started));
        }
        let expected = &manifest[path.display().to_string()];
        let start = Instant::now();
        let preview = app.previews.get(&path, false, true).await.unwrap();
        small.push(ms(start));
        let start = Instant::now();
        let large = app.previews.get(&path, true, true).await.unwrap();
        full.push(ms(start));
        let name = path.display();
        assert_eq!(sha(&preview.unwrap()), expected["small"], "{name} preview");
        assert_eq!(sha(&large.unwrap()), expected["full"], "{name} full JPEG");
        if expected.get("thumbnail").is_none() {
            continue;
        }
        edited += 1;
        let start = Instant::now();
        let url = app
            .editor
            .load(&path)
            .unwrap()
            .unwrap()
            .preview_url
            .unwrap();
        loads.push(ms(start));
        let start = Instant::now();
        let thumbnail = app
            .editor
            .respond(&format!("{url}?v=thumbnail&cacheOnly=1"));
        thumbnails.push(ms(start));
        let start = Instant::now();
        let medium = app.editor.respond(&format!("{url}?cacheOnly=1"));
        mediums.push(ms(start));
        assert_eq!(thumbnail.status, 200, "{name} thumbnail");
        assert_eq!(medium.status, 200, "{name} large preview");
        assert_eq!(sha(&thumbnail.bytes), expected["thumbnail"], "{name}");
        assert_eq!(sha(&medium.bytes), expected["medium"], "{name}");
    }
    let stats = stats(&app.store);
    for counter in [
        "misses",
        "renders",
        "derivedThumbnails",
        "writeFailures",
        "droppedPersistence",
    ] {
        assert_eq!(stats[counter], 0, "{counter} after a restart: {stats}");
    }
    eprintln!("restart: done after {:.0} ms", ms(started));
    json!({
        "edited": edited,
        "latency": {
            "importMs": import,
            "originalSmall": summary(small),
            "originalFull": summary(full),
            "editLoad": summary(loads),
            "editedThumbnail": summary(thumbnails),
            "editedMedium": summary(mediums),
        },
        "stats": stats,
    })
}

/// One phase in a child process: the caller runs it with `PHASE` and `ROOT`.
#[tokio::test]
#[ignore = "runs as a child of folder_previews_survive_restart_as_cache_hits"]
async fn phase() {
    let (Some(phase), Some(root)) = (std::env::var_os(PHASE), std::env::var_os(ROOT)) else {
        return;
    };
    let root = PathBuf::from(root);
    let result = match phase.to_str() {
        Some("warm") => warm(&root).await,
        Some("restart") => {
            let warm: Value =
                serde_json::from_slice(&fs::read(root.join("warm.json")).unwrap()).unwrap();
            restart(&root, &warm["manifest"]).await
        }
        _ => panic!("Unknown phase"),
    };
    let name = format!("{}.json", phase.to_string_lossy());
    fs::write(root.join(name), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}

fn run(root: &Path, phase: &str) -> f64 {
    let start = Instant::now();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["phase", "--exact", "--ignored", "--nocapture"])
        .env(PHASE, phase)
        .env(ROOT, root)
        .status()
        .unwrap();
    assert!(status.success(), "The {phase} phase failed");
    ms(start)
}

#[test]
#[ignore = "Requires X3FUSE_CACHE_SMOKE_DIRECTORY, bundled ExifTool and a supported GPU"]
fn folder_previews_survive_restart_as_cache_hits() {
    let source = PathBuf::from(
        std::env::var_os("X3FUSE_CACHE_SMOKE_DIRECTORY").expect("Set X3FUSE_CACHE_SMOKE_DIRECTORY"),
    );
    assert!(
        source.is_absolute() && source.is_dir(),
        "Invalid {source:?}"
    );
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let inputs = root.join("inputs");
    fs::create_dir(&inputs).unwrap();
    let (mut originals, mut sidecars) = (0, 0);
    for entry in fs::read_dir(&source).unwrap().flatten() {
        let path = entry.path();
        if !entry.file_type().unwrap().is_file()
            || !path
                .extension()
                .is_some_and(x3fuse_app::model::is_source_extension)
        {
            continue;
        }
        let copy = inputs.join(entry.file_name());
        fs::copy(&path, &copy).unwrap();
        originals += 1;
        if sidecar(&path).is_file() {
            fs::copy(sidecar(&path), sidecar(&copy)).unwrap();
            sidecars += 1;
        }
    }
    assert!(originals > 0, "No photos in {}", source.display());
    let warm_ms = run(root, "warm");
    let restart_ms = run(root, "restart");
    let read = |name: &str| -> Value {
        serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
    };
    let (warm, restart) = (read("warm.json"), read("restart.json"));
    let report = json!({
        "measurement": "backend-cache-acceptance",
        "method": "Two fresh processes with temporary photo copies. Restart import uses a missing ExifTool. All image reads are cache-only and must match the warm SHA-256 hashes. Original small timings follow import and can be memory hits. Timings exclude hashing and do not measure webview paint.",
        "originals": originals,
        "sidecars": sidecars,
        "edited": restart["edited"],
        "warm": {"processMs": warm_ms, "latency": warm["latency"], "stats": warm["stats"]},
        "restart": {
            "processMs": restart_ms,
            "latency": restart["latency"],
            "stats": restart["stats"],
        },
    });
    let path = std::env::var_os("X3FUSE_CACHE_SMOKE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../artifacts/preview-cache-backend.json")
        });
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("{}", serde_json::to_string_pretty(&report).unwrap());
}
