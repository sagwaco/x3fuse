//! Opt-in checks in the real webview. This module is absent from release builds.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
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
    webview.window().set_focus().map_err(|e| e.to_string())?;
    webview
        .eval(SCRIPT.replace("__INPUT_PATH__", &serde_json::to_string(input).unwrap()))
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        let mut result = evaluate(webview, "window.__x3fSmoke ?? null")?;
        if !result.is_null() {
            // Geometry checks are independent of the renderer's performance budget.
            result["resize"] = check_resize(webview)?;
            #[cfg(target_os = "macos")]
            {
                result["animatedZoom"] = check_animated_zoom(webview)?;
            }
            return Ok(result);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Native webview smoke exceeded 90 seconds".into())
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
    return window.__x3fRunNativeSmoke(__INPUT_PATH__);
  })().then(result => { window.__x3fSmoke = result; }, error => {
    window.__x3fSmoke = {ok: false, error: String(error), url: location.href};
  });
})()
"#;
