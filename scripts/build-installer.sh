#!/usr/bin/env bash
# build-installer.sh — builds apple-music-linux-<version>.run
#
# Output: dist/apple-music-linux-<version>.run (~122 MB)
# Requires: node, go, zstd, strip, electron-builder (via build/node_modules)
#
# Usage:
#   ./scripts/build-installer.sh           # full build
#   ./scripts/build-installer.sh --skip-eb # skip electron-builder (reuse existing linux-unpacked)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_EB=0
for arg in "$@"; do [ "$arg" = "--skip-eb" ] && SKIP_EB=1; done

# ── version ───────────────────────────────────────────────────────────────────
VERSION=$(node -p "require('$REPO/electron/package.json').version")
STAGE="$REPO/.installer-stage"
OUT="$REPO/dist"
UNPACKED="$STAGE/linux-unpacked"

echo "Building Apple Music Linux $VERSION installer..."

# ── 1. electron-builder: produce linux-unpacked ───────────────────────────────
if [ "$SKIP_EB" = "0" ]; then
    echo "[1/5] electron-builder --dir..."
    cd "$REPO/build"
    # --dir produces linux-unpacked without packaging into AppImage
    node_modules/.bin/electron-builder --linux dir
    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    cp -r "$REPO/build/dist/linux-unpacked" "$UNPACKED"
else
    echo "[1/5] Skipping electron-builder (--skip-eb)"
    if [ ! -d "$REPO/build/dist/linux-unpacked" ]; then
        echo "Error: build/dist/linux-unpacked not found. Run without --skip-eb first."
        exit 1
    fi
    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    cp -r "$REPO/build/dist/linux-unpacked" "$UNPACKED"
fi

# ── 2. Go engine (stripped) ───────────────────────────────────────────────────
echo "[2/5] Building Go engine..."
cd "$REPO/engine"
go build -ldflags="-w -s" -trimpath -o "$UNPACKED/resources/engine" .

# ── 3. DRM binary (stripped) ──────────────────────────────────────────────────
echo "[3/5] Stripping DRM binary..."
cp "$REPO/drm/drm-rootless" "$UNPACKED/resources/drm"
strip -s "$UNPACKED/resources/drm"

# ── 4. Post-process linux-unpacked ───────────────────────────────────────────
echo "[4/5] Optimizing..."

# Keep only en-US locale — 54 locale files removed (~45 MB uncompressed)
find "$UNPACKED/locales" -name "*.pak" ! -name "en-US.pak" -delete

# Belt-and-suspenders: remove any win32/darwin prebuilds electron-builder left in asar.unpacked
for plat in win32-x64 win32-arm64 darwin-x64 darwin-arm64; do
    rm -rf "$UNPACKED/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/$plat" 2>/dev/null || true
done

# Strip debug instrumentation from app.asar:
#   - installAudioCapture IIFE (allocates 64MB capture buffer, runs unconditionally)
#   - __amlCaptureChunk call site in the MV audio pipeline
ASAR_BIN="$REPO/build/node_modules/.bin/asar"
ASAR_PATH="$UNPACKED/resources/app.asar"
ASAR_STAGE="$STAGE/asar-stage"

"$ASAR_BIN" e "$ASAR_PATH" "$ASAR_STAGE"

node -e "
const fs = require('fs');
const bundle = process.argv[1];
let src = fs.readFileSync(bundle, 'utf8');
const before = src.length;
src = src.replace(/\(function installAudioCapture\(\) \{[\s\S]*?\}\)\(\);\n?/, '');
src = src.replace(/[ \t]*window\.__amlCaptureChunk\?\.\([^)]+\);\n?/, '');
fs.writeFileSync(bundle, src);
const removed = before - src.length;
console.log('  debug strip: -' + removed + ' bytes' + (removed === 0 ? ' (already clean)' : ''));
" "$ASAR_STAGE/engine-bundle.js"

"$ASAR_BIN" p "$ASAR_STAGE" "$ASAR_PATH" --unpack "*.node"
rm -rf "$ASAR_STAGE"

# ── 5. Pack SFX ───────────────────────────────────────────────────────────────
echo "[5/5] Compressing (zstd -19 --long=31, ~2 min)..."

mkdir -p "$OUT"
HEADER="$REPO/scripts/installer-header.sh"
OUTFILE="$OUT/apple-music-linux-$VERSION.run"

# Write header with version substituted
sed "s/__VERSION__/$VERSION/g" "$HEADER" > "$OUTFILE"

# Append payload: tar | zstd solid, strip-components=1 so install dir is flat
tar -cf - -C "$STAGE" linux-unpacked \
    | zstd -19 --long=31 -T0 -q \
    >> "$OUTFILE"

chmod +x "$OUTFILE"

# ── cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$STAGE"

SIZE=$(du -sh "$OUTFILE" | cut -f1)
echo ""
echo "Done: $OUTFILE ($SIZE)"
echo "Test: $OUTFILE --help"
echo "      $OUTFILE --force"
