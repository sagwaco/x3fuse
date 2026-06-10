# X3Fuse (Electron + React)

Cross-platform desktop app that converts Sigma **Merrill** and **Quattro** X3F RAW
files to **DNG**, **TIFF**, and **JPEG**. This is the Electron + React (TypeScript)
port of the macOS-only SwiftUI app in [`../X3Fuse`](../X3Fuse), built for **macOS,
Windows, and Linux** and a faster base for new features.

Conversion is performed by two bundled executables — **`x3f_extract`** (a Rust port
of the Kalpanika converter, from the sibling [`x3fuse-core`](https://github.com/sagwaco/x3fuse-core)
workspace) and **`exiftool`** — plus a directory of flat-fielding **opcodes**. The
Electron app is the orchestration + UI layer around them.

> **Status:** in active development on the `multiplat` branch. The Swift app remains
> the parity reference until cutover.
>
> | Milestone | Scope | State |
> |---|---|---|
> | **M0** | Scaffold + typed IPC | ✅ done |
> | **M1** | Headless conversion pipeline | ✅ done |
> | **M2** | UI parity (queue, settings, menus) | ✅ done |
> | **M3** | Settings persistence · i18n · logging | ✅ done |
> | **M4** | Cross-platform builds · packaging · auto-update | ⏳ next |
> | **M5** | Polish & cutover | — |
>
> macOS is currently the only platform with bundled binaries (synced from the Swift
> app). Windows/Linux binaries and installers land in M4.

---

## Requirements

- **Node.js ≥ 18** (20+ recommended) and npm
- **macOS 14+** for development today (the dev binary sync pulls the macOS slice)
- A checkout of the Swift app at `../X3Fuse` (sibling dir) to populate dev binaries
- *(optional)* `../x3fuse-core` checkout for the gated integration tests

## Quick start

```bash
cd electron
npm install

# Populate resources/ with the host-platform binaries (x3f_extract, exiftool, opcodes)
# by copying them from the sibling Swift app. Required before the first run.
npm run sync:resources

# Launch the app with hot reload (electron-vite)
npm run dev
```

Drag `.X3F` files onto the window (or use **＋ / ⌘O**) and click **Convert**.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the app with HMR (electron-vite) |
| `npm run build` | Typecheck + build main/preload/renderer to `out/` |
| `npm run typecheck` | `tsc --noEmit` for both the node (main/preload/shared) and web (renderer) configs |
| `npm run lint` | ESLint over `src/**` and `tests/**` |
| `npm run format` | Prettier write |
| `npm test` | Fast unit tests (Vitest) — no binaries needed |
| `npm run test:integration` | Real end-to-end conversion against the bundled binaries (gated; see [Testing](#testing)) |
| `npm run sync:resources` | Copy host-platform `x3f_extract` / `exiftool` / `opcodes` from `../X3Fuse` into `resources/` |
| `npm run pack` | Build an unpacked app (electron-builder `--dir`) — *configured in M4* |
| `npm run dist` | Build installers — *configured in M4* |

---

## Architecture

Three processes with a hard security boundary. **All filesystem and subprocess work
lives in the main process**; the renderer is a pure UI layer with no `fs`,
`child_process`, or binary paths (`contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`).

```
┌─ Main process ─────────────────────────────────────────────┐
│  ConversionService · ExifService · BinaryResolver           │
│  SettingsService (electron-store) · LogService · WindowMgr  │
│  native Menu · IPC router                                   │
└───────────▲───────────────────────────────┬────────────────┘
            │ contextBridge (preload)        │ events:
            │ window.x3f.invoke(...)          │ file:status / file:progress
            │                                 ▼ batch:complete / menu:command
┌─ Renderer (React) ─────────────────────────────────────────┐
│  Zustand queueStore / settingsStore ← IPC events            │
│  user actions → ipc.invoke(...)                             │
│  MainWindow · SettingsWindow (#settings hash route)         │
└────────────────────────────────────────────────────────────┘
```

### Typed IPC

`src/shared/ipc.ts` is the single source of truth for every channel and its
request/response & event payload types, imported by all three layers. The renderer
never touches a raw channel string — it goes through the typed `window.x3f` bridge.

- **invoke (request/response):** `settings:get/set`, `queue:add`,
  `queue:existingOutputs`, `convert:start/stop`, `exif:full`,
  `dialog:pickFiles/pickOutputDir`, `shell:reveal`, `window:openSettings`,
  `logs:open/clear/sizes`, `app:info`, `update:check`
- **events (main → renderer):** `file:status`, `file:progress`, `batch:complete`,
  `menu:command`, `update:available/downloaded`
- **`x3f-preview://` custom protocol:** streams an X3F's embedded JPEG preview
  (`?p=<path>&v=preview|full`) to the renderer for thumbnails, the filmstrip
  preview, and the histogram — extracted on demand by `exiftool -b` and cached in
  a byte-budgeted LRU (`PreviewService`). Registered secure + CORS-enabled so the
  histogram canvas stays untainted.

The renderer owns the queue; the main process is stateless about it and simply runs
the file list it is handed, reading global options from `SettingsService`.

### Conversion pipeline

Faithful port of the Swift `FileProcessor` + `X3FConverter` + `FileValidator`.
Per file, sequential, with cancellation checks between every step:

1. **0.10** — `exiftool` extract (`-aperture -model -lensid -json`)
2. **0.30** — spawn `x3f_extract` (args built by the pure, unit-tested
   `src/shared/argv.ts`; `cwd` = output dir)
3. **0.70** — *(DNG only)* `exiftool` copy tags onto the output
4. **0.90** — validate output (exists & non-empty)
5. `chmod 0o644` *(unix only)*
6. *(DNG only)* rename `name.X3F.dng` → `name.dng` (JPG/TIFF keep `name.X3F.<ext>`)
7. **1.0** — completed

Cancellation sends `SIGTERM` to the live child (with a Windows `taskkill` fallback);
exit code `15`/`SIGTERM` is treated as a user cancel, not a failure.

`ConversionService` runs behind a `ConversionBackend` interface so a future
napi-rs/FFI backend is a swap, not a rewrite.

### Queue views & inspector

The queue renders in three switchable modes (toolbar control, persisted in
settings): **list** (virtualized table), **grid** (virtualized thumbnail cells),
and **filmstrip** (a large preview of the active file above a scrollable strip).
A collapsible right **inspector** shows the selected file's **RGB histogram** and
a curated **EXIF** table. All three views share one selection model
(`useQueueSelection`, with an `activeId` "primary selection" driving the inspector
and filmstrip preview); thumbnails/previews/histogram all read the same
`x3f-preview://` bytes, and the histogram is computed in the renderer from the
fetched preview (no extra IPC). These are Electron-only QoL additions — not part
of the Swift app's parity surface.

---

## Project structure

```
electron/
├─ src/
│  ├─ main/                      # Main process (Node/Electron)
│  │  ├─ index.ts                #   app entry — wires context, menu, windows
│  │  ├─ context.ts              #   composition root (services)
│  │  ├─ windows.ts              #   main + Settings (#settings) windows
│  │  ├─ menu.ts                 #   native Menu + accelerators (localized)
│  │  ├─ i18n.ts                 #   main-process translator (menu/dialogs)
│  │  ├─ ipc/                    #   router + WebContentsSink (events → renderer)
│  │  └─ services/               #   Conversion, Exif, BinaryResolver, Settings,
│  │                             #   LogService, FileMetadata, ProcessRunner, …
│  ├─ preload/                   # contextBridge → window.x3f (typed, allow-listed)
│  ├─ renderer/src/              # React UI
│  │  ├─ components/             #   MainWindow, FileQueue, Toolbar, Footer,
│  │  │  └─ ui/                  #   SettingsWindow, ReconversionDialog, + Radix prims
│  │  ├─ stores/                 #   Zustand queueStore / settingsStore
│  │  ├─ hooks/                  #   useIpcEvents, useFileDrop
│  │  ├─ i18n/                   #   i18next config (renderer)
│  │  └─ lib/                    #   ipc, format, sortFiles, strings (t), …
│  └─ shared/                    # Imported by all three layers (@shared/*)
│     ├─ types.ts                #   data models + DEFAULT_SETTINGS
│     ├─ ipc.ts                  #   typed IPC contract
│     ├─ argv.ts                 #   pure x3f_extract argv builder (tested)
│     ├─ settingsMigration.ts    #   pure legacy-settings normalizer (tested)
│     └─ i18n/                   #   detect.ts + locales/{en,ja,ko,zh-Hans,zh-Hant}.json
├─ resources/                    # Bundled binaries (gitignored; see below)
├─ scripts/                      # sync-dev-resources.sh, strings-to-json.mjs
└─ tests/                        # Vitest unit + gated integration + render smoke
```

---

## Bundled binaries & resources

Resolved by `BinaryResolver` from a per-platform/arch layout under `resources/`
(dev) or `process.resourcesPath` (packaged):

```
resources/
├─ binaries/<platform>/<arch>/x3f_extract[.exe]
├─ exiftool/<platform>/exiftool[.exe]   (+ lib/ on macOS/Linux)
└─ opcodes/                              (69 .dat files, platform-independent)
```

These are **gitignored** (~65 MB). For local dev, `npm run sync:resources` copies the
macOS slice out of `../X3Fuse`. For releases they'll come from CI artifacts (M4).
`exiftool` is the Perl script + `lib/` on macOS/Linux (system Perl); Windows uses the
standalone `.exe` (M4).

---

## Settings, i18n, and logging

- **Settings** — `SettingsService` persists to JSON via **electron-store** (replacing
  UserDefaults). On load and every write, values pass through the pure
  `shared/settingsMigration.ts`, which upgrades legacy data (int-rawValue enums →
  string unions, legacy `denoise` bool → `denoiseIntensity`, clamp 0–10). File:
  `<userData>/settings.json`.
- **i18n** — English / Japanese / Korean / Simplified & Traditional Chinese. Locale
  JSONs live in `src/shared/i18n/locales/` (generated from the Swift `.strings` by
  `scripts/strings-to-json.mjs`). The **renderer** uses i18next; the **native menu and
  dialogs** are localized too via the lightweight main-process translator sharing the
  same JSONs. Language is detected once per session (`navigator.language` /
  `app.getLocale()`).
- **Logging** — `LogService` appends to three files (`conversion.log`, `error.log`,
  `debug.log`) in `app.getPath('logs')` (e.g. `~/Library/Logs/X3Fuse` on macOS), in the
  Swift app's timestamp format. Debug logging is gated by the setting. Open / clear /
  size are exposed in **Settings → Debug** and the **Help** menu.

---

## Testing

```bash
npm test                 # fast unit + render-smoke tests (no binaries)
npm run test:integration # real conversion against the bundled binaries
```

- **Unit** — argv parity, EXIF parsing, settings migration, i18n locale completeness,
  X3F metadata, plus a jsdom **render smoke test** that mounts the Main and Settings
  windows against a mocked `window.x3f`.
- **Integration** (gated by `X3FUSE_INTEGRATION=1`, set by the script) converts the
  sample Merrill/Quattro files in `../x3fuse-core/temp/` end-to-end and asserts valid
  DNG/TIFF output, the `.X3F.dng → .dng` rename, and status/progress events. Requires
  `npm run sync:resources` to have run and the sample files to be present; it skips
  cleanly otherwise.

---

## Roadmap (next)

**M4 — cross-platform builds, packaging, auto-update**

- Per-OS `x3fuse-core` CI builds (`x3f_extract` for mac universal / win x64 / linux
  x64+arm64); Windows standalone `exiftool.exe`
- `electron-builder` targets: mac `dmg`+`zip`, win `nsis`, linux `AppImage`+`deb`;
  `extraResources` for binaries/opcodes/exiftool
- macOS notarization; Windows code-signing *(cert TBD)*
- `electron-updater` + GitHub Releases — wires the (currently stubbed) `update:check`
  and the auto-check / auto-download settings (Sparkle retired)

**M5 — polish & cutover:** large-queue perf, ExifEditor undo/redo, notifications,
Playwright E2E, a11y, then archive the Xcode project once parity is signed off.

---

## Notes & intentional deviations from the Swift app

Documented inline where they occur:

- **Output-existence check** uses the *actual* on-disk path (the Swift
  `X3FFile.outputFilePath` only computed the renamed DNG form and so mis-reported
  JPG/TIFF existence).
- **Reconversion confirm** converts the full target set (the Swift flow dropped
  non-conflicting files after the dialog).
- **Logging** is a direct fs appender rather than electron-log (ESM friction vs. our
  CJS main; the Swift behavior is a trivial timestamped append) — swappable via
  `Logger.setLoggerBackend`.
- The dead-code `ConversionSettings.buildX3FArguments` (`-sgain`) variant in the Swift
  app is **not** ported; `argv.ts` follows `X3FConverter.buildX3FArguments`.
- Super-resolution (`-sr`) and OpenCL (`-ocl`) were removed upstream in `x3fuse-core`
  and are absent here.

## License

Apache-2.0 (see the repository root).
