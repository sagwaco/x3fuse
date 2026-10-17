# AGENTS.md

This file provides guidance to coding agents like Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

X3Fuse is a cross-platform Tauri 2 app for converting and editing Sigma X3F RAW files.
The renderer uses React, Zustand, and Vite. The Rust backend uses `x3f-core` 0.3.0
from crates.io for conversion and RAW preparation, and the in-repo `x3f-render`
crate for GPU editing and the spektrafilm film model.

The product name is **X3Fuse**, the bundle identifier is **com.sagwa.X3Fuse**, and
the release version is **0.2.0**. macOS 14 or newer is the released platform, with
Intel and Apple Silicon support. Windows and Linux x64 builds are portable alphas.

## Layout

- `src/`: React renderer, shared types, and translations.
- `src-tauri/`: Rust backend, Tauri configuration, and backend acceptance tests.
- `src-tauri/crates/x3f-render/`: GPU renderer, edit recipes, camera profiles, and film data.
- `src-tauri/resources/opcodes/`: tracked camera/lens flat-field corrections.
- `scripts/prepare-resources.mjs`: downloads checksum-verified ExifTool 13.59 for the
  host OS and prepares bundled license notices. Generated ExifTool and license resources
  are not tracked. Windows uses the standalone runtime; macOS and Linux use Perl.
- `tests/`: frontend, artifact, and native-window tests.
- `scripts/`: resource preparation, artifact packaging, and native smoke checks.
- `Configuration/`: release version parsing and legacy appcast note injection.
- `docs/Support/`: legacy `appcast.xml`. The first release creates updater feed
  `latest.json`; the updater endpoint returns HTTP 404 until then.

## Commands

Run commands from the repository root. See [README.md](README.md#development) for
prerequisites and runtime checks.

### Checks and builds

```sh
npm run sync:resources
npm run typecheck
npm run lint
npm test
npm run build:frontend
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --workspace
```

### Acceptance tests

Real-file tests need absolute input paths. Unit tests alone do not establish
conversion, GPU, or native-webview behavior. Editor tests copy inputs to temporary
storage before writing edits and exports.

```sh
X3FUSE_TEST_MERRILL=/absolute/path/merrill.X3F \
X3FUSE_TEST_QUATTRO=/absolute/path/quattro.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --locked --test conversion_acceptance -- --ignored

cargo test --manifest-path src-tauri/Cargo.toml -p x3f-render -- --include-ignored

X3FUSE_TEST_MERRILL=/absolute/path/merrill.X3F \
X3FUSE_TEST_QUATTRO=/absolute/path/quattro.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --test editor_acceptance -- --ignored --nocapture

X3FUSE_TEST_EDITED_A=/absolute/path/edited-a.X3F \
X3FUSE_TEST_EDITED_B=/absolute/path/edited-b.X3F \
cargo test --manifest-path src-tauri/Cargo.toml --test edited_thumbnail_acceptance -- --ignored --nocapture

X3FUSE_SMOKE_FILE=/absolute/path/sample.X3F npm run test:native -- --build

X3FUSE_EDITOR_SMOKE=1 X3FUSE_SMOKE_FILE=/absolute/path/photo.X3F \
npm run test:native -- --build
```

Edited-thumbnail inputs need adjacent `.x3fuse.json` sidecars. Native probes need a
desktop session; the editor also needs a supported GPU. `X3FUSE_SMOKE_REPORT` overrides
the default `artifacts/native-smoke-<platform>.json` report path. Omit `--build` to
reuse the Debug probe executable. Release builds omit the probe.

## Architecture notes

### Conversion and previews

- `src-tauri/src/conversion.rs` validates batches and output conflicts, calls
  `x3f-core` directly, and reports progress and per-file results to the renderer.
  ExifTool handles metadata. Opcode resources apply to DNG processing.
- Original export supports DNG, TIFF, and embedded JPEG extraction. DNG output uses
  `name.dng`, without the input `.X3F` suffix. SD9 and SD10 have no embedded JPEG.
- `x3f-preview` serves extracted previews through an asynchronous Tauri URI protocol.
  `x3f-edit` serves revisioned rendered images. The renderer uses bounded caches,
  worker-based scopes, and virtualized browsing views.

### Editor and film pipeline

- `x3f-render` prepares calibrated scene-linear input with `x3f-core`, then applies
  light, white balance, curves, HSL, monochrome filters, geometry, and film settings.
  The spektrafilm model includes negative response, DIR couplers, grain, halation,
  and print paper. Film rendering starts enabled and remains experimental.
- Editing requires Metal on macOS, DirectX 12 on Windows, or Vulkan on Linux.
  GPU work is serialized. Bounded tiles support previews and full-size exports.
  A device or driver failure is reported as an error.
- Interactive previews refine after input stops. Changing sensor denoise prepares
  the RAW again; slider gestures defer that work until release. Rendered JPEG and
  16-bit TIFF exports use the saved recipe. Original DNG and Embedded JPG do not bake edits.
- Bump `x3f_render::RENDER_VERSION` when a change alters rendered pixels. Persistent
  preview caches use this value to reject older renders.

### Edits, culling, settings, and logs

- Edits autosave beside the RAW as `<photo>.X3F.x3fuse.json`. Originals stay unchanged.
  Move the sidecar with its RAW. An unwritable source directory uses a backup in
  the app-data `edits/` directory. Invalid or newer recipes and source-content
  mismatches must not overwrite saved files. Undo history lasts for the session.
- Pick/reject flags and star ratings live separately in app-data `culling.json`,
  keyed by path. Moving or renaming a photo loses its flags and rating.
- Tauri resolves storage under `com.sagwa.X3Fuse`: preferences use
  `app_config_dir()/settings.json`; edits and caches use `app_data_dir()/edits`;
  logs use `app_log_dir()`. On macOS, settings and app data are under
  `~/Library/Application Support/com.sagwa.X3Fuse`, and logs are under
  `~/Library/Logs/com.sagwa.X3Fuse`.
- Settings from the previous macOS app are not migrated. Users select output and
  denoise preferences once. The old Tauri alpha identifier's data and logs move
  to the new identifier at startup when the destination does not exist.

## Dependencies

Use published `x3f-core` and `x3f-sys` 0.3.0 dependencies. A temporary local
`[patch.crates-io]` can test an unpublished core, but **never commit it** or its
local-path lockfile changes. CI and release builds cannot access local checkouts.

## Release flow and notes

- A `/release` PR comment starts `.github/workflows/release.yml`.
  `Configuration/release.sh` reads the newest version and notes from `Release_Notes.md`.
- The workflow builds a universal macOS app with Tauri, signs it with Developer ID,
  and notarizes it. It publishes `X3Fuse-App.zip`, `X3Fuse.app.tar.gz`, and
  `X3Fuse.app.tar.gz.sig`, writes `docs/Support/latest.json`, commits version/feed
  updates, and bumps the Homebrew cask.
- macOS updates use `tauri-plugin-updater` and
  `https://sagwaco.github.io/x3fuse/Support/latest.json`. Windows and Linux portable
  alphas have no updater.
- The Sparkle setup, appcast generation, and note injection steps run only for
  0.2.0. They write `docs/Support/appcast.xml` once more for the bridge from older
  installations; it stays frozen afterwards. Keep it available for installs that
  have not updated. Verify the bridge before publishing.
- `Release_Notes.md` is the single source of truth. Each release starts with
  `# <version> - <title>`, followed by `-` bullets. Put the newest release first.
  Keep notes user-facing. Check parsing with `bash Configuration/release.sh | head`.
- `generate_appcast` omits release notes. `Configuration/inject_release_notes.py`
  post-processes `docs/Support/appcast.xml`, embedding each version's notes as inline
  HTML in the matching `<item>`'s `<description>` (CDATA). It is idempotent and
  replaces existing descriptions, keeping `Release_Notes.md` canonical. The release
  workflow uses it for the 0.2.0 bridge only. Later releases use `latest.json` and
  leave the appcast frozen.
- `.github/workflows/tauri.yml` publishes portable alpha ZIPs for tags matching
  `x3fuse-alpha-*`. See the README for artifact names and runtime acceptance.

## Localization

Six locales are available: English (`en`), Spanish (`es`), Japanese (`ja`), Korean
(`ko`), Simplified Chinese (`zh-Hans`), and Traditional Chinese (`zh-Hant`).
Strings live in `src/shared/i18n/locales/`; locale detection is in
`src/shared/i18n/detect.ts`. Missing translations fall back to English.

## Known issues

- X3I files from Quattro SFD mode are not supported. Use exposure-bracketed X3Fs.
- Compressed Foveon DNG support varies by destination editor. Check sample output
  before converting a library. Quick Look can render Foveon DNGs incorrectly.
- Classic Foveon support comes from x3f-core 0.3.0. SD9, SD10, and SD14 conversion
  has not yet been verified in this app.
- Windows and Linux builds are alphas. Compilation does not establish GPU or
  native-webview behavior on those systems.
