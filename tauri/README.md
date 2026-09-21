# X3Fuse Tauri

The existing Electron interface runs in Tauri 2, with conversion performed directly
by the Rust `x3f-core` library. This app lives independently in `tauri/`; the Electron
and Swift applications remain available during migration.

The queue, list/grid/filmstrip views, inspector, scopes, zoom/minimap, export review,
previous export settings, conflict confirmation, native menus, and five UI locales
are retained. The renderer uses React, Zustand, and Vite. Filesystem access, settings,
metadata, preview extraction, and batch conversion live in Rust.

## Development

Install Node.js 22 LTS, the stable Rust toolchain, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:

- macOS 14 or newer: Xcode command-line tools and system Perl; Intel and Apple Silicon.
- Windows x64: Visual Studio C++ build tools, LLVM/libclang, and Microsoft WebView2
  Runtime. Set `LIBCLANG_PATH` to LLVM's `bin` directory when it is not discoverable.
- Linux x64: GTK 3, WebKitGTK 4.1 development packages, build tools, Clang/libclang,
  Perl, and `zip`/`unzip` for packaging and archive tests.

The editor uses the sibling `../x3fuse-core` checkout, including its new
`x3f-render` crate. Keep the repositories next to one another:

```text
Developer/
  x3fuse/
  x3fuse-core/
```

Cargo uses relative path dependencies; `src-tauri/Cargo.lock` pins third-party
versions. `npm run sync:resources` includes the renderer's GPL code notice and
spectral-data attribution in the application. Original conversion does not require
a GPU; editing requires Metal on macOS, DirectX 12 on Windows, or Vulkan on Linux.

```sh
cd tauri
npm ci
npm run dev
```

`npm run dev` prepares resources and starts Tauri with Vite hot reload. Resource
preparation downloads checksum-verified ExifTool **13.59** for the host OS and copies
the repository's opcode data into `src-tauri/resources/`. Windows includes ExifTool's
complete standalone runtime; macOS and Linux use its Perl script and bundled modules.
The app does not ship or launch `x3f_extract`.

Development builds optimize the core crates, PNG preview encoder and TIFF compression
library while the desktop backend keeps its normal debug build settings.

## Checks and builds

```sh
npm run sync:resources
npm run typecheck
npm run lint
npm test
npm run build:frontend
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

The frontend suite includes the inherited rendering, browsing, scope, zoom, import,
and batch scenarios, plus Tauri command/event, native-menu lifecycle, drag/drop, and
artifact-layout checks. Rust tests cover backend behavior. Real conversion tests
require Merrill and Quattro samples supplied through `X3FUSE_TEST_MERRILL` and
`X3FUSE_TEST_QUATTRO`; a successful unit suite is not evidence of real-file conversion.

Set both variables to absolute paths and run the opt-in acceptance test:

```sh
X3FUSE_TEST_MERRILL=/absolute/path/merrill.X3F \
X3FUSE_TEST_QUATTRO=/absolute/path/quattro.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --locked --test conversion_acceptance -- --ignored
```

This also checks full-strength denoising with compressed DNG/TIFF and DNG highlight
recovery, with a 60-second limit per conversion. Run it in the default test profile as shown
to exercise the development-build settings; `--release` alone would miss regressions there.

Use matching app/core revisions when developing or distributing this editor.
The desktop CI checks out the repositories as siblings and requires a full 40-character
core commit SHA in the `X3FUSE_CORE_REVISION` repository variable, or the
`core_revision` input on a manual workflow run. Set it to the reviewed core commit
containing `x3f-render` after that commit is available remotely. A moving branch
name is deliberately rejected. No crate publication is needed.

Build a macOS app bundle with `npm run dist`, or a native executable with
`npm run pack`. For Windows/Linux, use the executable build until installer targets
are added. Then run:

```sh
node scripts/package-artifact.mjs
```

The ZIP archive in `artifacts/` contains the complete native application and resources:

| Platform | Extracted layout                                     | Launch                   |
| -------- | ---------------------------------------------------- | ------------------------ |
| macOS    | `X3Fuse Tauri.app`, with resources inside the bundle | Open the app             |
| Windows  | `x3fuse-tauri.exe` beside `resources/`               | Run the executable       |
| Linux    | `bin/x3fuse-tauri` and `lib/x3fuse-tauri/resources/` | Run `./bin/x3fuse-tauri` |

Keep the complete extracted directory together. The Linux layout follows Tauri's
resource lookup relative to the executable; the Windows resource directory is beside
the executable. These development artifacts need the platform webview runtime and,
on macOS/Linux, Perl. They do not need this repository or the core checkout at runtime.

The dedicated workflow builds macOS arm64 and Intel, Windows x64, and Linux x64
artifacts. Branch, pull-request, and manual runs upload downloadable Actions artifacts.
These runs do not use Apple signing credentials; their macOS artifacts are not
Developer ID signed or notarized.
The macOS deployment target remains 14.0; its Intel CI runner uses macOS 15.

### Alpha releases

Push a versioned alpha tag on the commit to distribute, using
`x3fuse-alpha-<version>-<sequence>`:

```sh
git tag -a x3fuse-alpha-0.1.0-2 -m "x3fuse-alpha-0.1.0-2"
git push origin x3fuse-alpha-0.1.0-2
```

Tags matching `x3fuse-alpha-*` run the full four-platform build and publish a
GitHub prerelease only after every build, check, and artifact upload succeeds.
The release title matches the tag and does not replace the stable latest release.
Rerunning the tag workflow updates the same release's assets; use a new alpha tag
for a new commit.
Existing releases and internal app/binary names remain unchanged. The app's
internal version stays unchanged; the release tag and source commit identify the
alpha build.

Download one of these ZIP files from the repository's **Releases** page:

- `x3fuse-alpha-macos-arm64.zip`: macOS, **Apple Silicon (M-series)**.
- `x3fuse-alpha-macos-x64.zip`: macOS, **Intel**.
- `x3fuse-alpha-windows-x64.zip`: Windows, x64.
- `x3fuse-alpha-linux-x64.zip`: Linux, x64.

On a Mac, open **Apple menu → About This Mac**: an Apple M-series chip means
Apple Silicon; an Intel processor means Intel.

Extract the ZIP and follow the launch table above or the included `README.txt`.
Windows needs Microsoft WebView2 Runtime; Linux needs WebKitGTK 4.1, GTK 3, and
Perl; macOS needs macOS 14 or newer and system Perl. macOS alpha releases are
Developer ID signed and notarized using the same Apple credentials as stable
releases. Windows and Linux builds are unsigned. No alpha build has an automatic
updater. Record the alpha tag and OS when reporting results from the runtime
acceptance checks below.

## Runtime acceptance

An opt-in smoke check runs inside the real native webview with bundled assets and
the production CSP, without screen-capture permission:

```sh
X3FUSE_SMOKE_FILE=/absolute/path/sample.X3F npm run test:native -- --build
```

It imports through the renderer, checks both preview sizes and the packaged workers
under the production CSP, and verifies a generated 4K image's 2K preview stays visible
during deliberately delayed full-resolution decoding. It then measures navigation and scope-setting
actions in a 1,000-row synthetic filmstrip. The rows reuse the supplied source: this
checks UI scaling, not cold extraction from 1,000 distinct photos. The report includes
input-to-paint estimates, frame gaps, mounted cell counts, and three native resize
checks. On macOS it also measures intermediate viewport sizes during native zoom
and restore, checking that the web content follows the animation and the original
window bounds are restored. Reduce Motion skips the intermediate-frame requirement.
Native popup selection remains a manual check; the opt-in editor probe below also exports a real photo.

The macOS zoom controller also has a standalone regression check (no X3F input needed):

```sh
xcrun clang -fobjc-arc -mmacosx-version-min=14.0 -framework AppKit -framework WebKit \
  -framework QuartzCore tests/native-zoom.m -o /tmp/x3fuse-native-zoom
/tmp/x3fuse-native-zoom
```

The controller uses a window-associated display link to let WebKit update between
resize frames. It preserves AppKit's zoom targets and the existing titlebar, handles
interruption and window cleanup, and respects Reduce Motion. Check actual painting
visually by double-clicking the titlebar in populated list, grid, filmstrip, and
export views; DOM geometry checks alone do not establish smooth painting.

The `--build` option enables the opt-in renderer probe in a Debug executable; omit it
to rerun that executable. Normal builds omit the probe. Its JSON report is written to
`artifacts/native-smoke-<platform>.json`; set `X3FUSE_SMOKE_REPORT` to choose another
path. It requires a desktop session and exits within 100 seconds after building. The native probe is
compiled out of release builds. Repeat with Merrill and Quattro samples.

Run the extracted artifact outside the repository on each supported OS. Verify native
file import and drops, all browsing modes, portrait/cropped previews, scopes, pinch
and keyboard zoom, the Settings window, native menu selection and dismissal, output
reveal, and persistence across relaunch. Export real Merrill and Quattro inputs in
all three formats, then check cancellation, invalid inputs, overwrite confirmation,
parallel batches, and intact pre-existing outputs after failure.

Automated frontend tests do not exercise WKWebView, WebView2, or WebKitGTK. A passing
build or unit suite does not claim that these desktop acceptance checks have passed.

The filmstrip virtualizes thumbnails and uses decoded 2K previews at Fit. A worker
greedily prepares nearby images first, then the remaining queue, including saved edits.
Background work yields to visible previews and pauses during conversion or active
RAW editing. Edited PNGs retain their lossless pixels in the shared decoded cache.
Full-resolution images appear only above Fit, after decoding, with
the medium preview kept underneath. A small thumbnail covers a cold cache miss.
If no pixels are ready after 500 ms, the large filmstrip preview shows a skeleton.
Saved app edits have a pencil indicator beside list filenames and over small grid
and filmstrip thumbnails.
In-memory preview caches are bounded; obsolete queued requests are replaced during
rapid navigation. Import supplies inspector EXIF rows in the same
metadata pass. Scopes render in a worker, with cooperative fallback on older webviews;
preference persistence runs off the native event thread.

Native popup controls retain OS menus. When a control disappears or becomes disabled,
queued actions are ignored; an already-visible popup can remain until normal OS
dismissal. Automatic update preferences are retained, but the updater is not implemented.

License: [GPL-3.0-only](../LICENSE).

## RAW editor

Select a photo and choose **Edit** in the main toolbar. The editor shares the
filmstrip, zoom/pan and scopes with browsing. Adjust light, calibrated white balance,
curves, HSL, crop/straighten, denoise and sharpening. Film rendering starts enabled;
its switch and experimental-pipeline tooltip sit above the adjustment sections.
Light's exposure control adjusts film exposure while this mode is enabled.
The simulation models the negative, couplers, grain, halation and print paper using the pinned
sigmadeveloper/vkdt/spektrafilm spectral implementation in `x3f-render`.

Double-click a slider thumb to restore its default. Grain and halation each have
a simple strength control, with their individual settings in Advanced collapsibles.
New edits start with the camera's as-shot framing; the crop presets include 5:7,
6:7, 21:9 and 65:24 (XPan). Existing saved crops remain intact.

Enable **Monochrome** above Light to reveal the **Filter** dropdown: Neutral, Red,
Orange, Yellow, Green or Blue. Filters mix the calibrated Foveon Bottom/Middle/Top
responses, with equal neutral brightness across choices. Red, green and blue favor
the respective sensor layers, following [Sigma's description of their depth-dependent
sensitivity](https://www.sigma-global.com/jp/special/sppmonochrome/en/technology.html).
Orange and yellow blend bottom and middle layers; Neutral blends all three. These
are virtual filter effects over the prepared sensor data, including existing
denoise and Quattro layer reconstruction. Monochrome remains gray with color film
stocks and channel curves, and is saved, copied, undone and exported with other edits.

Edits autosave to `<photo>.X3F.x3fuse.json` without modifying the RAW. Move this file
with the original to carry edits between folders. If the source folder is unwritable,
X3Fuse saves a local backup in its application-data `edits` directory and shows that
location. Invalid/newer recipes and source-content mismatches are reported without
overwriting the files. Undo history lasts for the current application session;
the final recipe persists. Copy/Paste Adjustments excludes geometry and the grain seed.

Export from the editor or return to the main view. Both paths use the same review
screen and render saved edits into a genuine JPEG or 16-bit TIFF. A TIFF selection
containing edited files defaults to rendered mode; unedited files in that batch use
the default film recipe. Original DNG and Embedded JPG remain separate options and do
not bake edits. Rendered exports carry matching sRGB, Adobe RGB or ProPhoto RGB
profiles and normalized orientation; export settings do not apply denoise twice.

The backend validates and caches prepared RAW input, serializes GPU work, renders
bounded overlapping tiles, and serves revisioned sRGB preview images. Adjustments
render immediately at a 1024-pixel maximum edge; after 100 ms without input, a 2048-pixel
preview refines the image. While zoomed, both interactive and idle requests render
only the visible viewport; idle requests refine it at native resolution, capped at
4096 pixels. Scopes show the visible area. Panning keeps the decoded detail tile
anchored to the image while rendering the new region directly at native resolution,
without an intermediate low-resolution tile. Returning to Fit refreshes the full
image. Geometry edits first refresh full image dimensions before resuming viewport rendering.
New input interrupts refinement. The webview paints these PNGs directly, and active
editor thumbnails reuse them. Full-resolution exports use the same rendering pipeline.
Saved edits use dedicated 640-pixel thumbnails. A local cache under
`edits/thumbnails-v1` retains up to 512 PNGs / 256 MiB across scrolling and restarts;
the keys include the RAW fingerprint, recipe, dimensions and region. Completed
2048-pixel editor frames populate this cache without another RAW preparation.
Exact 2048-pixel previews also persist in `edits/mediums-v1`, bounded to 512 PNGs /
1 GiB, so a browser-cache eviction or app restart does not require RAW processing.
Draft and region renders do not populate this medium cache. On the M1 Max,
the two Quattro H acceptance files reloaded their cached medium PNGs after a
backend restart in 0.84–0.90 ms (native cache reads, excluding webview decoding).
Browser thumbnail canvases are capped at 640 pixels, and independent browsing
requests yield to interactive renders and retry after them instead of publishing a
cancelled thumbnail as an error. The first uncached
thumbnail still needs RAW preparation with the saved denoise settings.
While editing, one background thumbnail decode may temporarily coexist with the
active prepared RAW; it preserves that RAW so the next slider change stays fast.
Initial RAW preparation still takes time; changing sensor denoise requires preparing
the RAW again, so slider drags defer that operation until release.
Rendering pauses during export; the last completed frame stays visible.
A device/driver failure is an editor/export error, never an unnoticed film bypass.

Run GPU correctness checks on supported hardware from the core checkout:

```sh
cargo test -p x3f-render -- --include-ignored
```

Run real-photo acceptance with source paths supplied explicitly; tests copy photos
into temporary storage before writing sidecars or exports. Cross-platform compilation
alone does not establish driver or native-webview behavior on another OS.

From the Tauri directory, run the real backend editor check with Merrill and Quattro
files (the test verifies their camera families):

```sh
X3FUSE_TEST_MERRILL=/absolute/path/merrill.X3F \
X3FUSE_TEST_QUATTRO=/absolute/path/quattro.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --test editor_acceptance -- --ignored --nocapture
```

For edited-thumbnail regressions, provide two RAWs with adjacent `.x3fuse.json`
sidecars. The tests use temporary copies, check progressive first renders and
exact denoised refinement, concurrent requests after editor cancellation, and
exact cached pixels after a backend restart:

```sh
X3FUSE_TEST_EDITED_A=/absolute/path/edited-a.X3F \
X3FUSE_TEST_EDITED_B=/absolute/path/edited-b.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --test edited_thumbnail_acceptance -- --ignored --nocapture
```

On the M1 Max debug build (2026-09-21), saved edits for `_DQH1361.X3F` and
`_DQH1378.X3F` produced 0.55–0.59 MB thumbnails instead of 5.4 MB previews.
After restarting the backend, disk-cache reads took 0.26–4.3 ms and did not
prepare RAW. Optimizing SHA-256 reduced initial edit loading from 2.7–2.8 s to
0.18–0.19 s. A first uncached thumbnail still needed 8.5–9.4 s of RAW processing;
the cache and completed-editor-frame reuse avoid repeating that work.

Interactive editor requests now reuse the current prepared source, or skip NLM
for the first frame, then refine using the saved denoise setting after input
settles. The first 1024 px native render measured 2.24 s / 1.58 s on these files;
the exact denoised refinement still took 9.01 s / 8.80 s. Draft frames have
distinct asset identities and never replace the saved recipe's thumbnail.
The editor displays available thumbnail pixels while preparing RAW, the
inspector navigator reuses the 640 px thumbnail, and scrolling away cancels
abandoned edited-thumbnail processing in the native worker.

The native editor probe opens Edit through the toolbar, verifies default film and
as-shot crop, measures twelve film-exposure slider inputs through canvas paint,
checks double-click reset, idle refinement, undo/redo and sidecar reload, compares
red/blue monochrome pixels, verifies that panning retains native detail, measures
viewport-only adjustments at 100% zoom, checks the refreshed Fit view, exports JPEG,
and checks saved edits in the main export review:

```sh
X3FUSE_EDITOR_SMOKE=1 X3FUSE_SMOKE_FILE=/absolute/path/photo.X3F \
npm run test:native -- --build
```

This mode copies the input into a temporary directory and removes generated edits
and exports afterward, ignoring the remembered export destination. Keep the native
window visible during paint measurements. Repeat with each camera family; omit `--build` to reuse the
same Debug executable. Rebuild the probe after running Cargo directly, which can
replace that executable with a development-server build. Native probes need a
desktop session and a supported GPU.

On an M1 Max, twelve warm film-exposure slider inputs per photo measured a 66–67 ms
median and 67 ms p95 for Merrill and Quattro in the native Debug app. This includes
the probe's 20 ms observation polling and two animation frames after canvas paint.
Backend rendering plus PNG encoding measured about 13 ms at 512 pixels; initial
RAW preparation and display took about eight seconds.
Six additional viewport-only inputs at 100% zoom with red-filter monochrome
measured a 67 ms median and 68–78 ms p95 across the two camera families. The probe
also verifies that these adjustments leave the full-image preview untouched until Fit.
