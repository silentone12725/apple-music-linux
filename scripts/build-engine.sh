#!/usr/bin/env bash
# build-engine.sh — builds the Go engine with in-process DRM into OUT_DIR.
#
# The engine MUST be built with CGO and the native_backend tag: without it the
# DRM backend is a stub and the app silently falls back to AAC-only playback.
# It links libdrm_client.so and finds it at runtime next to itself via an $ORIGIN rpath,
# so it is copied into OUT_DIR too.
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

# Check for required DRM library
if [ ! -f "$REPO/drm/libdrm_client.so" ]; then
    echo "error: drm/libdrm_client.so not found — build the DRM client first" >&2
    exit 1
fi

# CGO splits CGO_LDFLAGS on spaces, and the repo path may contain one, so link
# against the libraries through a spaceless temporary directory.
LINKDIR="$(mktemp -d)"
trap 'rm -rf "$LINKDIR"' EXIT
ln -s "$REPO/drm/libdrm_client.so" "$LINKDIR/libdrm_client.so"

cd "$REPO/engine"
CGO_ENABLED=1 CGO_LDFLAGS="-L$LINKDIR -Wl,-rpath,\$ORIGIN" \
    go build -tags native_backend "$@" -o "$OUT/engine" ./cmd
cp "$REPO/drm/libdrm_client.so" "$OUT/"

echo "engine + DRM libs → $OUT"
