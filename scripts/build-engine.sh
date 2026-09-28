#!/usr/bin/env bash
# build-engine.sh — builds the Go engine with in-process DRM into OUT_DIR.
#
# The engine MUST be built with CGO and the hybris_backend tag: without it the
# DRM backend is a stub and the app silently falls back to AAC-only playback.
# It links libdrm-native.so (which pulls in libhybris-core.so) and finds both
# at runtime next to itself via an $ORIGIN rpath, so they are copied into
# OUT_DIR too.
#
# Usage: scripts/build-engine.sh OUT_DIR [extra go build flags...]
#   scripts/build-engine.sh electron/dist/resources
#   scripts/build-engine.sh electron/dist/resources -ldflags="-w -s" -trimpath

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: build-engine.sh OUT_DIR [go build flags...]}"
shift
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

for lib in libdrm-native.so libhybris-core.so; do
    if [ ! -f "$REPO/drm/$lib" ]; then
        echo "error: drm/$lib not found — build the DRM wrapper first (see CLAUDE.md)" >&2
        exit 1
    fi
done
# libdl.so is a host-built shim preloaded before the Android libs; without it
# libstoreservicescore.so fails to dlopen and DRM is unavailable at runtime.
if [ ! -f "$REPO/drm/rootfs/system/lib64/libdl.so" ]; then
    echo "error: drm/rootfs/system/lib64/libdl.so missing — DRM would fail to load" >&2
    exit 1
fi

# CGO splits CGO_LDFLAGS on spaces, and the repo path may contain one, so link
# against the libraries through a spaceless temporary directory.
LINKDIR="$(mktemp -d)"
trap 'rm -rf "$LINKDIR"' EXIT
ln -s "$REPO/drm/libdrm-native.so" "$LINKDIR/libdrm-native.so"
ln -s "$REPO/drm/libhybris-core.so" "$LINKDIR/libhybris-core.so"

cd "$REPO/engine"
CGO_ENABLED=1 CGO_LDFLAGS="-L$LINKDIR -Wl,-rpath,\$ORIGIN" \
    go build -tags hybris_backend "$@" -o "$OUT/engine" .
cp "$REPO/drm/libdrm-native.so" "$REPO/drm/libhybris-core.so" "$OUT/"

echo "engine + DRM libs → $OUT"
