#!/usr/bin/env sh
# Build a static MP4Box binary from GPAC source for bundling with apple-music-linux.
# Output: internal/embedded/mp4box
#
# --static-mp4box produces a single self-contained binary with no GPAC .so deps.
# Only the MP4Box CLI is built — the full GPAC library suite is skipped.
#
# Usage: sh scripts/build-mp4box.sh [gpac-git-tag]
#   e.g. sh scripts/build-mp4box.sh v2.4.0   (default)

set -e

TAG="${1:-v2.4.0}"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
BUILD_DIR="/tmp/gpac-aml-build-$$"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT_DIR/internal/embedded/mp4box"

echo "[build-mp4box] tag=$TAG jobs=$JOBS"
echo "[build-mp4box] output → $OUT"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

git clone --depth=1 --branch "$TAG" https://github.com/gpac/gpac.git
cd gpac

./configure \
  --static-mp4box \
  --disable-wx \
  --disable-opengl \
  --disable-x11 \
  --disable-jack \
  --disable-alsa \
  --disable-pulseaudio \
  --disable-oss-audio \
  --use-zlib=no

make -j"$JOBS" mp4box
strip bin/gcc/MP4Box

mkdir -p "$(dirname "$OUT")"
cp bin/gcc/MP4Box "$OUT"

SIZE="$(du -sh bin/gcc/MP4Box | cut -f1)"
echo "[build-mp4box] done — $SIZE"
echo "[build-mp4box] → $OUT"

rm -rf "$BUILD_DIR"
