#!/bin/bash
#
# Builds the embedded x3f_extract universal binary from the x3fuse-core
# Rust workspace (https://github.com/sagwaco/x3fuse-core) and installs it
# into X3Fuse/x3f_extract.
#
# By default it builds from a local checkout next to this repo
# (../x3fuse-core); override with the X3FUSE_CORE env var. The Xcode project
# still embeds and code-signs the checked-in X3Fuse/x3f_extract, so re-run
# this whenever x3fuse-core is updated, then commit the new binary.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="${X3FUSE_CORE:-$REPO_ROOT/../x3fuse-core}"
DEST="$REPO_ROOT/X3Fuse/x3f_extract"

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)

if [ ! -d "$CORE_DIR" ]; then
    echo "❌ x3fuse-core not found at: $CORE_DIR"
    echo "   Clone it (git clone https://github.com/sagwaco/x3fuse-core)"
    echo "   or set X3FUSE_CORE to its path."
    exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "❌ cargo not found. Install a Rust toolchain via https://rustup.rs"
    exit 1
fi

echo "Building x3f_extract from: $CORE_DIR"
CORE_COMMIT="$(git -C "$CORE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "x3fuse-core commit: $CORE_COMMIT"
echo ""

BINS=()
for target in "${TARGETS[@]}"; do
    echo "→ rustup target add $target"
    rustup target add "$target" >/dev/null
    echo "→ cargo build --release --target $target"
    ( cd "$CORE_DIR" && cargo build --release --target "$target" )
    BINS+=("$CORE_DIR/target/$target/release/x3f_extract")
done

echo ""
echo "→ lipo -create → $DEST"
lipo -create -output "$DEST" "${BINS[@]}"
chmod 755 "$DEST"

echo ""
echo "✅ Installed universal x3f_extract (x3fuse-core @ $CORE_COMMIT)"
file "$DEST"
