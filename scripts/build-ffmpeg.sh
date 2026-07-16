#!/usr/bin/env sh
# Build a minimal ffmpeg binary for bundling with apple-music-linux.
# Output: internal/embedded/ffmpeg
#
# Only the codecs apple-music-linux actually uses are compiled in:
#   decoders : alac, aac, eac3, ac3, flac
#   encoders : flac, aac
#   muxer    : mov  (covers mp4 / m4a / fMP4 output)
#   demuxers : mov, aac, flac, matroska, ogg
#   protocols: pipe, file
#   bsf      : aac_adtstoasc, extract_extradata
#   parsers  : aac, aac_latm, flac, ac3, mpegaudio, opus, vorbis
#   filters  : aresample, anull
#
# The binary links dynamically against glibc/libm/libpthread only —
# no external codec libraries, no network stack.
#
# Usage: sh scripts/build-ffmpeg.sh [ffmpeg-git-tag]
#   e.g. sh scripts/build-ffmpeg.sh n7.1.1   (default)

set -e

TAG="${1:-n7.1.1}"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
BUILD_DIR="/tmp/ffmpeg-aml-build-$$"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT_DIR/internal/embedded/ffmpeg"

echo "[build-ffmpeg] tag=$TAG jobs=$JOBS"
echo "[build-ffmpeg] output → $OUT"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

git clone --depth=1 --branch "$TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
cd ffmpeg

./configure \
  --prefix="$BUILD_DIR/install" \
  --enable-static \
  --disable-shared \
  --disable-doc \
  --disable-htmlpages \
  --disable-manpages \
  --disable-podpages \
  --disable-txtpages \
  --disable-network \
  --disable-avdevice \
  --disable-postproc \
  --disable-everything \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,aac,flac,matroska,ogg \
  --enable-muxer=mov,adts,flac,matroska \
  --enable-decoder=alac,aac,aac_fixed,eac3,ac3,flac,mp3,vorbis,opus \
  --enable-encoder=flac,aac \
  --enable-bsf=aac_adtstoasc,extract_extradata \
  --enable-parser=aac,aac_latm,flac,ac3,mpegaudio,opus,vorbis \
  --enable-filter=aresample,anull \
  --extra-cflags="-O2 -pipe"

make -j"$JOBS" ffmpeg
strip ffmpeg

mkdir -p "$(dirname "$OUT")"
cp ffmpeg "$OUT"

SIZE="$(du -sh ffmpeg | cut -f1)"
echo "[build-ffmpeg] done — $SIZE"
echo "[build-ffmpeg] → $OUT"

rm -rf "$BUILD_DIR"
