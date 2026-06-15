# AGENTS.md

This file provides guidance to coding agents like Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

X3Fuse is a macOS SwiftUI application for converting Sigma Merrill and Quattro X3F RAW files to DNG, TIFF, and JPEG formats. The app uses embedded x3f_extract and exiftool binaries to perform conversions and handle EXIF metadata.

**System Requirements**: macOS 14.0 (Sonoma) or later, supports both Intel and Apple Silicon.

## Build & Development Commands

### Building the App

```bash
# Open in Xcode
open X3Fuse.xcodeproj

# Build from command line (Release)
xcodebuild -project X3Fuse.xcodeproj -scheme X3Fuse -configuration Release build

# Build from command line (Debug)
xcodebuild -project X3Fuse.xcodeproj -scheme X3Fuse -configuration Debug build

# Build universal binary (Intel + Apple Silicon)
xcodebuild -project X3Fuse.xcodeproj -scheme X3Fuse ARCHS="x86_64 arm64" ONLY_ACTIVE_ARCH=NO build
```

### Testing

```bash
# Run tests from Xcode
# Product → Test (⌘U)

# Run tests from command line
xcodebuild test -project X3Fuse.xcodeproj -scheme X3Fuse
```

### Verification

```bash
# Verify universal binary build
./scripts/verify_universal_build.sh
```

### Updating the x3f_extract binary

```bash
# Rebuild the embedded x3f_extract from the x3fuse-core Rust workspace and
# install a universal (arm64 + x86_64) binary into X3Fuse/x3f_extract.
# Defaults to a sibling ../x3fuse-core checkout; override with X3FUSE_CORE.
./scripts/build_x3f_extract.sh

# Then commit the updated X3Fuse/x3f_extract.
```

## Architecture

### Service-Based Architecture

The app uses a modular service-based architecture with singleton services that manage different aspects of conversion:

- **FileProcessor**: Orchestrates the entire conversion pipeline (Services/FileProcessor.swift:14)
- **X3FConverter**: Handles x3f_extract process execution (Services/X3FConverter.swift:10)
- **BinaryManager**: Manages embedded binaries (x3f_extract, exiftool) (Services/BinaryManager.swift:10)
- **ExifService**: Extracts and applies EXIF metadata using exiftool
- **OpcodeManager**: Applies camera/lens-specific flat-fielding opcodes to DNGs
- **FileValidator**: Validates input/output files and permissions

### Data Flow

1. User adds X3F files → **ConversionQueue** (Models/ConversionQueue.swift:12)
2. User clicks Convert → **FileProcessor.processAllFiles()** (Services/FileProcessor.swift:32)
3. For each file:
   - Extract EXIF data → **ExifService**
   - Run x3f_extract conversion → **X3FConverter.runX3FConversion()** (Services/X3FConverter.swift:22)
   - For DNG output: Apply EXIF + opcodes → **FileProcessor.applyExifAndOpcodes()** (Services/FileProcessor.swift:169)
   - Validate output → **FileValidator**
   - Rename output file (removes `.X3F` from filename for DNGs)

### Key Models

- **X3FFile**: Represents an X3F file in the queue with conversion state (Models/X3FFile.swift:67)
- **ConversionQueue**: Observable queue managing file list and overall conversion state (Models/ConversionQueue.swift:12)
- **ConversionSettings**: Global and per-file conversion settings (Models/ConversionSettings.swift:11)

### Process Execution Pattern

x3f_extract is executed as a subprocess with:

- Working directory set to effective output directory (Services/X3FConverter.swift:51)
- Cancellation support via process termination (Services/X3FConverter.swift:256)
- Detailed permission and security error logging (Services/X3FConverter.swift:180-252)

### Output File Naming

- x3f_extract creates: `original.X3F.dng` (preserves X3F extension)
- FileValidator renames to: `original.dng` (removes X3F extension) for DNGs only
- Output location: Custom directory if set in settings, otherwise same directory as input file

### Conversion Cancellation

When cancellation is requested:

1. **ConversionQueue.cancelConversion()** sets `isCancelling = true` and cleans up temporary files (Models/ConversionQueue.swift:383)
2. **X3FConverter.terminateCurrentProcess()** sends SIGTERM to x3f_extract process (Services/X3FConverter.swift:256)
3. Processing files are reset to queued status

## Important Implementation Details

### Embedded Binaries

- **x3f_extract**: Must be universal binary (Intel + Apple Silicon). Built from the
  [x3fuse-core](https://github.com/sagwaco/x3fuse-core) Rust workspace (a full Rust port of
  the original Kalpanika C/C++ converter). Rebuild and update it with
  `./scripts/build_x3f_extract.sh`, which compiles both arch targets and `lipo`-combines them
  into `X3Fuse/x3f_extract`; commit the resulting binary.
- **exiftool**: Perl script bundled in Resources
- Binary paths resolved via `Bundle.main.path(forResource:ofType:)` (Services/BinaryManager.swift:24)
- Executable permissions (0o755) set on app launch (Services/BinaryManager.swift:36)
- The Xcode build embeds and code-signs the checked-in `X3Fuse/x3f_extract`; the binary is
  not rebuilt during the app build.

#### CLI compatibility notes (x3fuse-core)

- The legacy single-dash flag syntax is preserved (`-dng`, `-tiff`, `-jpg`, `-color`, `-compress`,
  `-no-denoise`, `-o`, `-v`, …), so X3FConverter's argument building is mostly unchanged.
- **Unknown flags hard-fail** the binary (it prints usage and exits non-zero), so only pass flags
  the core actually supports.
- **Super-resolution (`-sr`/`-sr-model`) and OpenCL (`-ocl`) were removed** — x3fuse-core has no
  upscaler, and `-ocl`/`x3f_set_use_opencl` is now a no-op stub. The corresponding app settings,
  UI, and localization were dropped.

### EXIF and Opcode Handling

- Opcode files (flat-fielding corrections) stored per camera/lens/aperture combination
- Only applied to DNG output format
- Missing opcodes result in warning status but don't fail conversion (Services/FileProcessor.swift:217)

### Localization

- Multi-language support: English, Japanese, Korean, Chinese
- Translation keys managed via LocalizationService

### Settings Persistence

- Settings stored in UserDefaults (Models/ConversionSettings.swift:74-102)
- Per-file overrides supported for output format, compression, etc.

### Auto-Updates

- Uses Sparkle framework for updates
- UpdaterService configured on app launch (X3FuseApp.swift:16)
- Uses Sparkle's standard update window (`SPUStandardUpdaterController`), which already
  renders each appcast item's `<description>` in its notes pane and provides the
  Install / Remind Me Later / Skip This Version buttons — no custom update UI.

#### Release notes in the update prompt

- `Release_Notes.md` is the single source of truth for per-version notes (one `# <version> - <title>`
  header per release, followed by `-` bullets).
- `generate_appcast` (CI) omits release notes, so the update window's notes pane would be blank.
  `Configuration/inject_release_notes.py` post-processes `docs/Support/appcast.xml`, embedding each
  version's notes as inline HTML in the matching `<item>`'s `<description>` (CDATA). It is idempotent
  and replaces existing descriptions, keeping `Release_Notes.md` canonical.
- The release workflow runs the script right after the "Update appcast" step
  (.github/workflows/release.yml), and `docs/Support/appcast.xml` is already in the auto-commit list,
  so every release ships notes automatically.
- To refresh the checked-in appcast by hand (e.g. after editing `Release_Notes.md`):
  `python3 Configuration/inject_release_notes.py` (then commit `docs/Support/appcast.xml`).

#### Previewing the update window locally

- The shipping app is always the latest version, so Sparkle never shows the update dialog in a
  normal run. `Configuration/serve_test_appcast.py` clones the newest appcast item, bumps it to a
  high version (keeping the embedded notes), and serves it over `http://localhost`.
- A `#if DEBUG` delegate in `UpdaterService.swift` redirects Sparkle's feed to
  `http://localhost:8000/appcast-test.xml` (override with the `X3FUSE_TEST_FEED_URL` env var). This
  is compiled out of Release builds. `Info.plist`'s `NSAllowsLocalNetworking` permits the loopback
  http feed (loopback/local only).
- Usage: run `python3 Configuration/serve_test_appcast.py` from the repo root, then launch a Debug
  build and choose "Check for Updates". The generated `docs/Support/appcast-test.xml` is gitignored.

## File Structure Patterns

```
X3Fuse/
├── Models/           # Data models (X3FFile, ConversionQueue, ConversionSettings)
├── Services/         # Business logic services (conversion, EXIF, logging, etc.)
├── Views/            # SwiftUI views
├── Utilities/        # Helper functions
└── Assets.xcassets/  # App icons and assets
```

## Testing Notes

- Tests located in `X3FuseTests/` (unit) and `X3FuseUITests/` (UI)
- Test X3F files should cover Merrill and Quattro camera models
- Universal binary verification critical for release builds

## Known Issues & Constraints

- X3I files (Quattro SFD mode) not supported - workaround: use exposure bracketing with X3F
- DNG RAW compression reduces compatibility with non-Adobe/Capture One applications
- Quick Look doesn't properly render Foveon DNGs due to lack of CFA pattern
