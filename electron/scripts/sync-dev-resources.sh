#!/bin/bash
#
# Populate electron/resources/ for LOCAL DEV by copying the binaries already
# bundled with the macOS Swift app (../../X3Fuse). For release builds these come
# from CI artifacts instead (see resources/README.md).
#
# Currently supports the host platform's darwin slice; extend per-OS as the
# cross-platform binaries land.

set -euo pipefail

ELECTRON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="$(cd "$ELECTRON_DIR/.." && pwd)/X3Fuse"
RES="$ELECTRON_DIR/resources"

if [ ! -d "$SWIFT_DIR" ]; then
  echo "❌ Swift app resources not found at: $SWIFT_DIR"
  exit 1
fi

PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Darwin) PLAT_KEY="darwin" ;;
  Linux)  PLAT_KEY="linux" ;;
  *)      echo "❌ Unsupported platform for dev sync: $PLATFORM"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH_KEY="arm64" ;;
  x86_64|amd64)  ARCH_KEY="x64" ;;
  *)             echo "❌ Unsupported arch: $ARCH"; exit 1 ;;
esac

echo "→ Syncing resources for $PLAT_KEY/$ARCH_KEY from $SWIFT_DIR"

# x3f_extract — the macOS binary is a universal lipo, so it serves both arches.
mkdir -p "$RES/binaries/$PLAT_KEY/arm64" "$RES/binaries/$PLAT_KEY/x64"
cp "$SWIFT_DIR/x3f_extract" "$RES/binaries/$PLAT_KEY/arm64/x3f_extract"
cp "$SWIFT_DIR/x3f_extract" "$RES/binaries/$PLAT_KEY/x64/x3f_extract"
chmod 755 "$RES/binaries/$PLAT_KEY/arm64/x3f_extract" "$RES/binaries/$PLAT_KEY/x64/x3f_extract"

# exiftool (+ adjacent lib/, which the perl script needs on @INC).
mkdir -p "$RES/exiftool/$PLAT_KEY"
cp "$SWIFT_DIR/exiftool" "$RES/exiftool/$PLAT_KEY/exiftool"
chmod 755 "$RES/exiftool/$PLAT_KEY/exiftool"
rm -rf "$RES/exiftool/$PLAT_KEY/lib"
cp -R "$SWIFT_DIR/lib" "$RES/exiftool/$PLAT_KEY/lib"

# opcodes (platform-independent).
rm -rf "$RES/opcodes"
cp -R "$SWIFT_DIR/opcodes" "$RES/opcodes"

echo "✅ Synced:"
echo "   $RES/binaries/$PLAT_KEY/{arm64,x64}/x3f_extract"
echo "   $RES/exiftool/$PLAT_KEY/exiftool (+ lib)"
echo "   $RES/opcodes ($(find "$RES/opcodes" -type f | wc -l | tr -d ' ') files)"
