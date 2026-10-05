#!/usr/bin/env bash
# build-installer.sh — builds dist/apple-music-linux-<version>.run
#
# Every component is rebuilt from source on each run, then the packaged result is checked
# against the fresh build, so the installer cannot silently carry a stale engine, DRM
# library or renderer bundle:
#
#   1. libdrm_client.so   make -C drm             (C client + vendored wrapper)
#   2. engine             scripts/build-engine.sh (Go, CGO, native_backend)
#   3. renderer bundles   scripts/build-renderer.sh
#   4. VLC subset         scripts/bundle-vlc.sh
#   5. electron-builder   --dir → linux-unpacked
#   6. verification       packaged files byte-equal to the fresh build
#   7. self-extracting archive (tar | zstd)
#
# Needs: node, go (CGO), gcc, make, zstd, electron/node_modules (electron-builder), the
# system VLC, and the Android runtime under drm/ (git-ignored where proprietary):
#   drm/libhybris-core.so  drm/hybris-linker/q.so  drm/rootfs/system/lib64/ (the full set)
#
# Usage:
#   ./scripts/build-installer.sh           # full build
#   ./scripts/build-installer.sh --skip-eb # reuse electron/dist/linux-unpacked, refreshing
#                                          # the engine, libraries, bundles and VLC in it
#   ./scripts/build-installer.sh --clean   # afterwards delete electron/dist/linux-unpacked

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$REPO/electron"
DRM="$REPO/drm"
SKIP_EB=0
CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --skip-eb) SKIP_EB=1 ;;
        --clean)   CLEAN=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

die() { echo "Error: $*" >&2; exit 1; }

# ── version ───────────────────────────────────────────────────────────────────
VERSION=$(node -p "require('$ELECTRON/package.json').version")
COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    COMMIT="$COMMIT+dirty"
fi
STAGE="$REPO/.installer-stage"
OUT="$REPO/dist"
UNPACKED="$STAGE/linux-unpacked"
# The staging copy is several hundred MB: remove it whether the build succeeds or fails.
trap 'rm -rf "$STAGE"' EXIT

echo "Building Apple Music Linux $VERSION ($COMMIT) installer..."

# ── 0. pre-flight ─────────────────────────────────────────────────────────────
echo "[0/7] Checking prerequisites..."
for tool in node npx go gcc make zstd tar; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not installed"
done
[ -x "$ELECTRON/node_modules/.bin/electron-builder" ] || die "electron/node_modules missing — run 'npm install' in electron/"

# A Git LFS pointer file is ~130 bytes of text, not a library: a clone made without
# `git lfs pull` would otherwise package garbage.
real_binary() { [ -s "$1" ] && ! head -c 64 "$1" | grep -q 'git-lfs'; }
for f in "$DRM/libhybris-core.so" "$DRM/hybris-linker/q.so" "$ELECTRON/icon.png" "$REPO/assets/tray-icon.png"; do
    real_binary "$f" || die "$f is missing or an unresolved Git LFS pointer (run 'git lfs pull')"
done
LIB64="$DRM/rootfs/system/lib64"
for lib in libc.so libdl.so libc++.so libcrypto.so libCoreFP.so libandroidappmusic.so libstoreservicescore.so; do
    real_binary "$LIB64/$lib" || die "$LIB64/$lib missing — the Android runtime is incomplete.
  Copy the full set, e.g.:  cp -n <musickit-sdk-linux>/drm/rootfs/system/lib64/* \"$LIB64/\""
done

# ── 1. DRM client library ─────────────────────────────────────────────────────
echo "[1/7] Building libdrm_client.so..."
make -C "$DRM" libdrm_client.so >/dev/null

# ── 2. Go engine with in-process DRM (stripped) ──────────────────────────────
# Built into electron/dist/resources, where electron-builder's extraResources picks up
# the engine and libdrm_client.so (build-engine.sh copies the fresh library there too).
echo "[2/7] Building Go engine (CGO + native_backend)..."
"$REPO/scripts/build-engine.sh" "$ELECTRON/dist/resources" -ldflags="-w -s" -trimpath

# ── 3. Renderer bundles ───────────────────────────────────────────────────────
echo "[3/7] Building renderer bundles..."
"$REPO/scripts/build-renderer.sh"

# ── 4. Bundled VLC ────────────────────────────────────────────────────────────
echo "[4/7] Bundling VLC..."
"$REPO/scripts/bundle-vlc.sh"

# ── 5. electron-builder: produce linux-unpacked ───────────────────────────────
RES_SRC="$ELECTRON/dist/resources"
if [ "$SKIP_EB" = "0" ]; then
    echo "[5/7] electron-builder --dir..."
    # --dir produces linux-unpacked without packaging into an AppImage
    (cd "$ELECTRON" && node_modules/.bin/electron-builder --linux dir)
else
    echo "[5/7] Skipping electron-builder (--skip-eb); refreshing the reused directory"
    [ -d "$ELECTRON/dist/linux-unpacked" ] || die "electron/dist/linux-unpacked not found. Run without --skip-eb first."
    R="$ELECTRON/dist/linux-unpacked/resources"
    cp "$RES_SRC/engine" "$RES_SRC/libdrm_client.so" "$DRM/libhybris-core.so" "$R/"
    cp "$ELECTRON/icon.png" "$R/icon.png"
    cp "$REPO/assets/tray-icon.png" "$R/tray-icon.png"
    rm -rf "$R/vlc" && cp -r "$RES_SRC/vlc" "$R/vlc"
    # the renderer bundles were refreshed in step 3 (build-renderer.sh updates this directory)
fi
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$ELECTRON/dist/linux-unpacked" "$UNPACKED"
RES="$UNPACKED/resources"

# ── 6. Verify the package against the fresh build ────────────────────────────
echo "[6/7] Verifying package contents..."
for f in engine libdrm_client.so libhybris-core.so hybris-linker/q.so \
         rootfs/system/lib64/libc.so rootfs/system/lib64/libdl.so rootfs/system/lib64/libCoreFP.so \
         rootfs/system/lib64/libandroidappmusic.so rootfs/system/lib64/libstoreservicescore.so \
         vlc/libvlc.so.5 vlc/libvlccore.so.9 vlc/plugins tray-icon.png icon.png app.asar; do
    [ -e "$RES/$f" ] || die "packaged resources/$f missing — the installed app would not work"
done
if [ -e "$RES/rootfs/data" ]; then
    die "resources/rootfs/data present — it holds a personal Apple session; refusing to package it"
fi
[ ! -e "$RES/libdrm-native.so" ] || die "stale resources/libdrm-native.so is packaged (old wrapper library)"

same() { cmp -s "$1" "$2" || die "$3 in the package differs from the fresh build — stale copy"; }
same "$RES_SRC/engine"           "$RES/engine"             "resources/engine"
same "$DRM/libdrm_client.so"     "$RES/libdrm_client.so"   "resources/libdrm_client.so"
same "$DRM/libhybris-core.so"    "$RES/libhybris-core.so"  "resources/libhybris-core.so"

# The engine must actually link the DRM library (a build without the native_backend tag has
# no DRM and silently falls back to AAC-only), and find it next to itself.
ldd "$RES/engine" 2>/dev/null | grep -q 'libdrm_client.so => /' \
    || die "the packaged engine does not resolve libdrm_client.so (missing native_backend tag or rpath)"

# Renderer bundles: the copy inside app.asar (and any copy beside it, which main.mjs
# prefers) must equal the freshly built file.
ASAR="$ELECTRON/node_modules/.bin/asar"
TMP="$(mktemp -d)"
for b in engine-bundle.js engine-sse-bundle.js smart-cache-bundle.js vision-bundle.js mp4box-bundle.js; do
    (cd "$TMP" && "$ASAR" extract-file "$RES/app.asar" "$b") || die "$b is missing from app.asar"
    same "$ELECTRON/$b" "$TMP/$b" "$b in app.asar"
    [ ! -e "$RES/$b" ] || same "$ELECTRON/$b" "$RES/$b" "resources/$b"
done
rm -rf "$TMP"

printf 'version=%s\ncommit=%s\nbuilt=%s\n' "$VERSION" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RES/BUILD_INFO"

# ── 7. Post-process and pack the self-extracting archive ─────────────────────
echo "[7/7] Optimizing and compressing (zstd -19 --long=31, ~2 min)..."

# Keep only en-US locale — 54 locale files removed (~45 MB uncompressed)
find "$UNPACKED/locales" -name "*.pak" ! -name "en-US.pak" -delete

# Belt-and-suspenders: remove any win32/darwin prebuilds electron-builder left in asar.unpacked
for plat in win32-x64 win32-arm64 darwin-x64 darwin-arm64; do
    rm -rf "$UNPACKED/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/$plat" 2>/dev/null || true
done

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
if [ "$CLEAN" = 1 ]; then
    # electron-builder's unpacked output is an intermediate: the .run holds everything in it.
    rm -rf "$ELECTRON/dist/linux-unpacked" "$ELECTRON/dist/"builder-*.y*ml
    echo "Removed electron/dist/linux-unpacked (--clean)"
fi

SIZE=$(du -sh "$OUTFILE" | cut -f1)
echo ""
echo "Done: $OUTFILE ($SIZE) — $VERSION ($COMMIT)"
echo "Test: $OUTFILE --help"
echo "      $OUTFILE --force"
