# Bundled resources

These directories hold the native binaries and assets the app shells out to.
They are **not committed** (large + platform-specific) — populate them locally
with the sync script, and via CI artifacts for release builds.

```
resources/
├─ binaries/<platform>/<arch>/x3f_extract[.exe]   # the RAW converter (Rust, from ../x3fuse-core)
├─ exiftool/<platform>/exiftool[.exe] (+ lib/)    # EXIF read/copy (Perl script on unix, .exe on Windows)
└─ opcodes/                                        # 69 flat-fielding .dat files, shared across platforms
```

`<platform>` is one of `darwin` / `win32` / `linux`; `<arch>` is `arm64` / `x64`.

## Local dev (macOS)

Copy the binaries from the existing Swift app:

```bash
npm run sync:resources
```

This pulls `x3f_extract`, `exiftool` + `lib/`, and `opcodes/` from `../X3Fuse`
into the layout above for the current platform.

## Release builds

CI builds `x3f_extract` per target triple in the `x3fuse-core` workspace and
downloads the artifacts here; `electron-builder` then ships them via
`extraResources` (see M4).
