#!/usr/bin/env bash
# build-installer.sh — builds apple-music-linux-<version>.run
#
# Output: dist/apple-music-linux-<version>.run
# Requires: node, go (CGO), zstd, electron-builder (electron/node_modules), and
#           drm/libdrm-native.so + drm/libhybris-core.so + drm/hybris-linker/
#
# Packages electron/ — the single source of truth — exactly as `npm run dist`
# does, just as an unpacked dir wrapped in a self-extracting archive.
#
# Usage:
#   ./scripts/build-installer.sh           # full build
#   ./scripts/build-installer.sh --skip-eb # reuse existing electron/dist/linux-unpacked

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

ELECTRON="$REPO/electron"

# ── 1. Go engine with in-process DRM (stripped) ──────────────────────────────
# Built into electron/dist/resources, where electron-builder's extraResources
# picks up the engine and its DRM libraries.
echo "[1/5] Building Go engine (CGO + hybris_backend)..."
"$REPO/scripts/build-engine.sh" "$ELECTRON/dist/resources" -ldflags="-w -s" -trimpath

# ── 2. Renderer bundle ────────────────────────────────────────────────────────
echo "[2/5] Bundling engine-playback.js..."
(cd "$ELECTRON" && npx esbuild src/engine-playback.js --bundle --format=iife --outfile=engine-bundle.js)

# ── 3. electron-builder: produce linux-unpacked ───────────────────────────────
if [ "$SKIP_EB" = "0" ]; then
    echo "[3/5] electron-builder --dir..."
    # --dir produces linux-unpacked without packaging into AppImage
    (cd "$ELECTRON" && node_modules/.bin/electron-builder --linux dir)
else
    echo "[3/5] Skipping electron-builder (--skip-eb)"
    if [ ! -d "$ELECTRON/dist/linux-unpacked" ]; then
        echo "Error: electron/dist/linux-unpacked not found. Run without --skip-eb first."
        exit 1
    fi
    # Reused dir: refresh the engine + libs + icon built above.
    cp "$ELECTRON/dist/resources/engine" "$ELECTRON/dist/resources/libdrm-native.so" \
       "$ELECTRON/dist/resources/libhybris-core.so" "$ELECTRON/dist/linux-unpacked/resources/"
    # Always sync the current icon so --skip-eb doesn't silently use a stale one.
    [ -f "$ELECTRON/icon.png" ] && cp "$ELECTRON/icon.png" "$ELECTRON/dist/linux-unpacked/resources/icon.png"
fi
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$ELECTRON/dist/linux-unpacked" "$UNPACKED"
for f in engine libdrm-native.so libhybris-core.so hybris-linker rootfs/system/lib64/libdl.so rootfs/system/lib64/libstoreservicescore.so; do
    [ -e "$UNPACKED/resources/$f" ] || { echo "Error: packaged resources/$f missing — DRM would not work"; exit 1; }
done
if [ -e "$UNPACKED/resources/rootfs/data" ]; then
    echo "Error: resources/rootfs/data present — it holds a personal Apple session; refusing to package it"
    exit 1
fi

# ── 4. Post-process the staged copy ──────────────────────────────────────────
echo "[4/5] Optimizing..."

# Keep only en-US locale — 54 locale files removed (~45 MB uncompressed)
find "$UNPACKED/locales" -name "*.pak" ! -name "en-US.pak" -delete

# Belt-and-suspenders: remove any win32/darwin prebuilds electron-builder left in asar.unpacked
for plat in win32-x64 win32-arm64 darwin-x64 darwin-arm64; do
    rm -rf "$UNPACKED/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/$plat" 2>/dev/null || true
done

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
