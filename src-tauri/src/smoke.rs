//! Opt-in checks in the real webview. This module is absent from release builds.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::{webview::PageLoadEvent, Manager, Webview};

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn on_page_load(webview: &Webview, event: PageLoadEvent) {
    if webview.label() != "main" || event != PageLoadEvent::Finished {
        return;
    }
    let Ok(input) = std::env::var("X3FUSE_SMOKE_FILE") else {
        return;
    };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let report = std::env::var_os("X3FUSE_SMOKE_REPORT").map(PathBuf::from);
    let webview = webview.clone();
    std::thread::spawn(move || {
        let result =
            probe(&webview, &input).unwrap_or_else(|error| json!({"ok":false,"error":error}));
        let written = report
            .ok_or_else(|| "Set X3FUSE_SMOKE_REPORT to an absolute report path".to_string())
            .and_then(|path| {
                if !path.is_absolute() {
                    return Err("X3FUSE_SMOKE_REPORT must be absolute".into());
                }
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap())
                    .map_err(|e| e.to_string())
            });
        eprintln!("Native webview smoke: {result}");
        if let Err(error) = &written {
            eprintln!("Could not save smoke report: {error}");
        }
        webview
            .app_handle()
            .exit(if result["ok"] == true && written.is_ok() {
                0
            } else {
                1
            });
    });
}

fn probe(webview: &Webview, input: &str) -> Result<Value, String> {
    // WKWebView suspends animation frames when occluded. Keep this disposable
    // test window visible so input-to-paint measurements observe real frames.
    webview
        .window()
        .set_always_on_top(true)
        .map_err(|e| e.to_string())?;
    webview.window().set_focus().map_err(|e| e.to_string())?;
    if let Some(manifest) = std::env::var_os("X3FUSE_CACHE_SMOKE_MANIFEST") {
        let paths: Vec<PathBuf> =
            serde_json::from_slice(&std::fs::read(manifest).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if paths.is_empty()
            || paths
                .iter()
                .any(|path| !path.is_absolute() || !path.is_file())
        {
            return Err("Cache benchmark needs absolute photo paths".into());
        }
        let script = CACHE_SCRIPT
            .replace("__PATHS__", &serde_json::to_string(&paths).unwrap())
            .replace(
                "__WARMUP__",
                if std::env::var("X3FUSE_CACHE_SMOKE_WARMUP").as_deref() == Ok("1") {
                    "true"
                } else {
                    "false"
                },
            );
        webview.eval(script).map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(1800);
        let mut progress = Value::Null;
        while Instant::now() < deadline {
            let mut sample = evaluate(
                webview,
                "({result: window.__x3fSmoke ?? null, stage: window.__x3fSmokeProgress ?? null})",
            )?;
            if sample["stage"] != progress {
                progress = sample["stage"].take();
                eprintln!("Preview cache benchmark: {progress}");
            }
            let mut result = sample["result"].take();
            if !result.is_null() {
                let state = webview.app_handle().state::<Arc<crate::AppState>>();
                let stats = &state.previews.store.stats;
                let renders = stats.renders.load(Ordering::Relaxed);
                let misses = stats.misses.load(Ordering::Relaxed);
                let derived = stats.derived_thumbnails.load(Ordering::Relaxed);
                let dropped = stats.dropped_persistence.load(Ordering::Relaxed);
                result["cacheCounters"] = json!({
                    "memoryHits": stats.memory_hits.load(Ordering::Relaxed),
                    "diskHits": stats.disk_hits.load(Ordering::Relaxed),
                    "misses": misses,
                    "writes": stats.writes.load(Ordering::Relaxed),
                    "writeFailures": stats.write_failures.load(Ordering::Relaxed),
                    "derivedThumbnails": derived,
                    "renders": renders,
                    "droppedPersistence": dropped,
                });
                if dropped != 0 {
                    result["ok"] = false.into();
                    result["error"] = format!("Dropped {dropped} preview cache writes").into();
                }
                if result["phase"] == "application-restart"
                    && (renders != 0 || misses != 0 || derived != 0)
                {
                    result["ok"] = false.into();
                    result["error"] =
                        format!("Restart needed {renders} renders, {misses} uncached previews, and {derived} thumbnail derivations")
                            .into();
                }
                return Ok(result);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        return Err("Preview cache benchmark exceeded 30 minutes".into());
    }
    webview
        .eval(
            SCRIPT
                .replace("__INPUT_PATH__", &serde_json::to_string(input).unwrap())
                .replace(
                    "__EDITOR_SMOKE__",
                    if std::env::var("X3FUSE_EDITOR_SMOKE").as_deref() == Ok("1") {
                        "true"
                    } else {
                        "false"
                    },
                ),
        )
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut previous_progress = Value::Null;
    while Instant::now() < deadline {
        let progress = evaluate(
            webview,
            "({stage: window.__x3fSmokeProgress ?? null, visibility: document.visibilityState})",
        )?;
        if progress != previous_progress {
            eprintln!("Native smoke progress: {progress}");
            previous_progress = progress;
        }
        let mut result = evaluate(webview, "window.__x3fSmoke ?? null")?;
        if !result.is_null() {
            // Geometry checks are independent of the renderer's performance budget.
            result["resize"] = check_resize(webview)?;
            #[cfg(target_os = "macos")]
            {
                result["animatedZoom"] = check_animated_zoom(webview)?;
                // Animation frames follow the display, not WebKit's 60 per second default.
                if let Some(rate) = result["editor"]["cloudFrameRate"].as_f64() {
                    let display = display_refresh_rate(webview)?;
                    result["editor"]["displayRefreshRate"] = display.into();
                    if let Some(display) = display.filter(|display| rate < display * 0.9) {
                        result["ok"] = false.into();
                        result["error"] = format!(
                            "The cloud drew {rate} frames per second on a {display} Hz display"
                        )
                        .into();
                    }
                }
            }
            return Ok(result);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Native webview smoke exceeded 90 seconds: {previous_progress}"
    ))
}

fn evaluate(webview: &Webview, script: &str) -> Result<Value, String> {
    let (send, receive) = mpsc::channel();
    webview
        .eval_with_callback(script, move |value| {
            let _ = send.send(value);
        })
        .map_err(|e| e.to_string())?;
    let value = receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|e| format!("Webview did not answer: {e}"))?;
    serde_json::from_str(&value).map_err(|e| e.to_string())
}

fn check_resize(webview: &Webview) -> Result<Value, String> {
    let window = webview.window();
    let mut samples = vec![];
    for (width, height) in [(720, 480), (1100, 720), (960, 680)] {
        let start = Instant::now();
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        loop {
            let sample = evaluate(
                webview,
                r#"(() => {
                const bounds = document.querySelector('#root > div').getBoundingClientRect();
                return {width: innerWidth, height: innerHeight, appWidth: bounds.width,
                    appHeight: bounds.height, background: getComputedStyle(document.documentElement).backgroundColor};
            })()"#,
            )?;
            let elapsed = start.elapsed();
            if elapsed > Duration::from_millis(500) {
                return Err(format!(
                    "Webview did not follow native resize promptly: {sample}"
                ));
            }
            if sample["width"] == width
                && sample["height"] == height
                && sample["appWidth"] == width
                && sample["appHeight"] == height
            {
                if sample["background"] != "rgb(10, 10, 10)" {
                    return Err(format!(
                        "Document canvas exposes a different background: {sample}"
                    ));
                }
                samples.push(
                    json!({"width":width,"height":height,"milliseconds":elapsed.as_millis()}),
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(json!(samples))
}

/// The refresh rate of the window's display, or None when Low Power Mode or
/// heat can make macOS give fewer animation frames.
#[cfg(target_os = "macos")]
fn display_refresh_rate(webview: &Webview) -> Result<Option<f64>, String> {
    let (send, receive) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            use objc2::{class, msg_send, runtime::AnyObject};
            let process: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            let low_power: bool = msg_send![process, isLowPowerModeEnabled];
            // 2 is NSProcessInfoThermalStateSerious.
            let thermal: isize = msg_send![process, thermalState];
            let hot = thermal >= 2;
            let window = &*platform.ns_window().cast::<AnyObject>();
            let screen: *mut AnyObject = msg_send![window, screen];
            let rate = if low_power || hot || screen.is_null() {
                None
            } else {
                let rate: isize = msg_send![screen, maximumFramesPerSecond];
                Some(rate as f64)
            };
            let _ = send.send(rate);
        })
        .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|e| format!("The display rate did not answer: {e}"))
}

#[cfg(target_os = "macos")]
fn native_zoom(webview: &Webview, start: bool) -> Result<(bool, bool), String> {
    let (send, receive) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            use objc2::{class, msg_send, runtime::AnyObject, sel};
            let window = &*platform.ns_window().cast::<AnyObject>();
            let supported: bool =
                msg_send![window, respondsToSelector: sel!(x3fuseIsZoomAnimating)];
            if !supported {
                let _ = send.send(Err("Native smooth zoom was not installed".to_string()));
                return;
            }
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let reduce_motion: bool = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
            if start {
                let _: () = msg_send![window, zoom: std::ptr::null::<AnyObject>()];
            }
            let animating: bool = msg_send![window, x3fuseIsZoomAnimating];
            let _ = send.send(Ok((reduce_motion, animating)));
        })
        .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|e| format!("Native zoom did not answer: {e}"))?
}

#[cfg(target_os = "macos")]
fn check_animated_zoom(webview: &Webview) -> Result<Value, String> {
    let window = webview.window();
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let original_size = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let original_position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let result = (|| {
        let mut directions = vec![];
        for direction in ["zoom", "restore"] {
            evaluate(webview, RESIZE_RECORD_START)?;
            let (reduce_motion, mut animating) = native_zoom(webview, true)?;
            let deadline = Instant::now() + Duration::from_secs(3);
            while animating {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Native {direction} animation exceeded three seconds"
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
                animating = native_zoom(webview, false)?.1;
            }
            // Sample two final animation frames before checking the settled bounds.
            evaluate(webview, "window.__x3fResizeRecord.remaining = 2")?;
            loop {
                if evaluate(webview, "window.__x3fResizeRecord.done")? == true {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(format!("Webview did not settle after {direction}"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let samples = evaluate(webview, "window.__x3fResizeRecord.samples")?;
            let samples = samples
                .as_array()
                .ok_or("Missing animated resize samples")?;
            let first = samples.first().ok_or("No animated resize samples")?;
            let last = samples.last().unwrap();
            let native_size = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            for (field, expected) in [
                ("width", native_size.width),
                ("height", native_size.height),
                ("appWidth", native_size.width),
                ("appHeight", native_size.height),
            ] {
                if last[field]
                    .as_f64()
                    .is_none_or(|value| (value - expected).abs() > 1.0)
                {
                    return Err(format!(
                        "Webview did not fit final {direction} bounds: {last}"
                    ));
                }
            }
            let mut intermediate = vec![];
            for (width, height) in [("width", "height"), ("appWidth", "appHeight")] {
                let sizes: std::collections::HashSet<_> = samples
                    .iter()
                    .filter(|sample| {
                        (sample[width] != first[width] || sample[height] != first[height])
                            && (sample[width] != last[width] || sample[height] != last[height])
                    })
                    .map(|sample| format!("{},{}", sample[width], sample[height]))
                    .collect();
                if !reduce_motion && sizes.len() < 3 {
                    return Err(format!(
                        "Webview {width}/{height} froze during {direction}: {} intermediate sizes; samples: {samples:?}",
                        sizes.len()
                    ));
                }
                intermediate.push(sizes.len());
            }
            directions.push(json!({
                "direction": direction, "samples": samples,
                "intermediateViewportSizes": intermediate[0],
                "intermediateRootSizes": intermediate[1],
                "intermediateAssertionSkipped": reduce_motion.then_some("macOS Reduce Motion is enabled")
            }));
        }
        let restored_size = window
            .outer_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let restored_position = window
            .outer_position()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        if (restored_size.width - original_size.width).abs() > 1.0
            || (restored_size.height - original_size.height).abs() > 1.0
            || (restored_position.x - original_position.x).abs() > 1.0
            || (restored_position.y - original_position.y).abs() > 1.0
        {
            return Err(format!(
                "Zoom restore changed the original window rectangle: {original_position:?} {original_size:?} -> {restored_position:?} {restored_size:?}"
            ));
        }
        Ok(json!({"directions": directions, "restoredOriginalFrame": true}))
    })();
    let cleanup = evaluate(
        webview,
        "cancelAnimationFrame(window.__x3fResizeRecord?.frame); delete window.__x3fResizeRecord; true",
    );
    result.and_then(|result| cleanup.map(|_| result))
}

#[cfg(target_os = "macos")]
const RESIZE_RECORD_START: &str = r#"
(() => {
  cancelAnimationFrame(window.__x3fResizeRecord?.frame);
  const record = window.__x3fResizeRecord = {samples: [], frame: 0, remaining: null, done: false};
  const tick = () => {
    const bounds = document.querySelector('#root > div').getBoundingClientRect();
    record.samples.push({time: performance.now(), width: innerWidth, height: innerHeight,
      appWidth: bounds.width, appHeight: bounds.height});
    if (record.remaining !== null && --record.remaining === 0) record.done = true;
    else record.frame = requestAnimationFrame(tick);
  };
  tick();
  return true;
})()
"#;

const SCRIPT: &str = r#"
(() => {
  window.__x3fSmoke = null;
  void (async () => {
    const deadline = Date.now() + 15000;
    while (!window.__x3fRunNativeSmoke && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!window.__x3fRunNativeSmoke) throw new Error('Renderer smoke bridge missing; run npm run test:native -- --build');
    return window.__x3fRunNativeSmoke(__INPUT_PATH__, __EDITOR_SMOKE__);
  })().then(result => { window.__x3fSmoke = result; }, error => {
    window.__x3fSmoke = {ok: false, error: String(error), url: location.href};
  });
})()
"#;

const CACHE_SCRIPT: &str = r#"
(() => {
  window.__x3fSmoke = null;
  void (async () => {
    const deadline = Date.now() + 15000;
    while (!window.__x3fRunPreviewCacheSmoke && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!window.__x3fRunPreviewCacheSmoke) throw new Error('Cache smoke bridge missing');
    return window.__x3fRunPreviewCacheSmoke(__PATHS__, __WARMUP__);
  })().then(result => { window.__x3fSmoke = result; }, error => {
    window.__x3fSmoke = {ok: false, error: String(error)};
  });
})()
"#;
