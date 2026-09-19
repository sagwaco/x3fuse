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
    webview
        .eval(SCRIPT.replace("__INPUT_PATH__", &serde_json::to_string(input).unwrap()))
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        let mut result = evaluate(webview, "window.__x3fSmoke ?? null")?;
        if !result.is_null() {
            if result["ok"] == true {
                result["resize"] = check_resize(webview)?;
            }
            return Ok(result);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Native webview smoke exceeded 45 seconds".into())
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

const SCRIPT: &str = r#"
(() => {
  window.__x3fSmoke = null;
  const input = __INPUT_PATH__;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  void (async () => {
    check(location.protocol === 'tauri:' || location.hostname === 'tauri.localhost',
      'Use embedded production assets: npm run tauri -- build --debug --no-bundle');
    const deadline = Date.now() + 10000;
    while (!document.querySelector('#root button') && Date.now() < deadline) await wait(50);
    const root = document.querySelector('#root');
    check(root?.querySelector('button'), 'React did not mount its main controls');
    const native = window.__TAURI_INTERNALS__;
    const info = await native.invoke('app_info');
    check(['darwin', 'win32', 'linux'].includes(info.platform), 'Invalid app_info response');
    const files = await native.invoke('queue_add', {payload: {paths: [input]}});
    check(files.length === 1 && files[0].path === input && files[0].fileSize > 0,
      'Native import did not return source metadata');
    const previews = [];
    for (const variant of ['preview', 'full']) {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = native.convertFileSrc(input, 'x3f-preview') + '?v=' + variant;
      let timeout;
      try {
        await Promise.race([
          image.decode(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(variant + ' decode timed out')), 15000); })
        ]);
      } finally { clearTimeout(timeout); }
      check(image.naturalWidth > 0 && image.naturalHeight > 0, variant + ' has no image pixels');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d');
      check(context, 'Canvas 2D is unavailable');
      context.drawImage(image, 0, 0, 16, 16);
      const pixels = context.getImageData(0, 0, 16, 16).data;
      check(pixels.length === 1024 && pixels.some((value, i) => i % 4 === 3 && value > 0),
        variant + ' canvas returned no visible pixels');
      previews.push({variant, width: image.naturalWidth, height: image.naturalHeight, pixelBytes: pixels.length});
    }
    return {ok: true, url: location.href, app: info,
      root: {buttons: root.querySelectorAll('button').length, text: root.textContent.slice(0, 160)},
      imported: {fileName: files[0].fileName, fileSize: files[0].fileSize}, previews};
  })().then(result => { window.__x3fSmoke = result; }, error => {
    window.__x3fSmoke = {ok: false, error: String(error), url: location.href};
  });
})()
"#;
