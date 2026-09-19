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
  and Perl.

Cargo resolves `x3f-core` 0.1.5 from crates.io, including the parsing hardening,
cooperative cancellation, and conversion reports used by the desktop backend.
`src-tauri/Cargo.lock` pins the resolved dependency versions and registry checksums.
Core attribution files are kept in `licenses/x3fuse-core` and included in the app's
resources. A normal build requires no sibling `x3fuse-core` checkout.

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

Development builds optimize the core crates and TIFF compression library so
full-strength denoising remains usable while the desktop backend keeps its
normal debug build settings.

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

To update the core dependency, change its version in `src-tauri/Cargo.toml`, run
`cargo update --manifest-path src-tauri/Cargo.toml -p x3f-core`, and review the updated
lockfile. Refresh the core LICENSE and NOTICE from that release, then rerun the
checks and real-file acceptance tests above. Commit the manifest, lockfile, and
attribution changes together.

Build a macOS app bundle with `npm run dist`, or a native executable with
`npm run pack`. For Windows/Linux, use the executable build until installer targets
are added. Then run:

```sh
node scripts/package-artifact.mjs
```

The archive in `artifacts/` contains the complete native application and resources:

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
The macOS deployment target remains 14.0; its Intel CI runner uses macOS 15.

### Alpha releases

Push a versioned Tauri alpha tag on the commit to distribute:

```sh
git tag -a tauri-v0.1.0-alpha.1 -m "X3Fuse Tauri alpha 1"
git push origin tauri-v0.1.0-alpha.1
```

Tags matching `tauri-v*-alpha.*` run the full four-platform build and publish a
GitHub prerelease only after every build, check, and artifact upload succeeds.
The release does not replace the stable latest release. Rerunning the tag workflow
updates the same release's assets; use a new alpha tag for a new commit.
The app's internal version stays unchanged; the release tag and source commit
identify the alpha build.

Download one of these archives from the repository's **Releases** page:

- `x3fuse-tauri-darwin-arm64.tar.gz`: macOS, Apple Silicon.
- `x3fuse-tauri-darwin-x64.tar.gz`: macOS, Intel.
- `x3fuse-tauri-win32-x64.tar.gz`: Windows, x64.
- `x3fuse-tauri-linux-x64.tar.gz`: Linux, x64.

Extract the archive and follow the launch table above or the included `README.txt`.
Windows needs Microsoft WebView2 Runtime; Linux needs WebKitGTK 4.1, GTK 3, and
Perl; macOS needs macOS 14 or newer and system Perl. These alpha builds are unsigned,
are not notarized, and have no automatic updater. Record the alpha tag and OS when
reporting results from the runtime acceptance checks below.

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
checks. Native popup selection and real-photo conversion remain manual checks.

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
prepares nearby images first, then the remaining queue; background preparation pauses
during conversion. Full-resolution images appear only above Fit, after decoding, with
the medium preview kept underneath. A small thumbnail covers a cold cache miss.
In-memory preview caches are bounded; obsolete queued requests are replaced during
rapid navigation. Import supplies inspector EXIF rows in the same
metadata pass. Scopes render in a worker, with cooperative fallback on older webviews;
preference persistence runs off the native event thread.

Native popup controls retain OS menus. When a control disappears or becomes disabled,
queued actions are ignored; an already-visible popup can remain until normal OS
dismissal. Automatic update preferences are retained, but the updater is not implemented.

License: [GPL-3.0-only](../LICENSE).
