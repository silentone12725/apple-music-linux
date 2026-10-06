#!/usr/bin/env bash
# build-ffmpeg.sh — regenerates third_party/ffmpeg, the prebuilt minimal FFmpeg that every
# package bundles. Normal builds do NOT run this: the result is committed (Git LFS) and the
# packaging scripts just copy it. Run it only to upgrade FFmpeg or change the component list.
#
# It is FFmpeg 9.0.2 built from the official source as an LGPL build, with only what the app
# uses, in two roles:
#   - bin/ffmpeg  the engine's music-video remux, export and tagging runs
#   - lib/        libavcodec/libavformat/libavutil... — the shared libraries VLC's bundled
#                 libavcodec plugin loads (ALAC and AAC decode). The plugin was linked against
#                 these exact sonames (libavcodec.so.63, libavutil.so.61, libavformat.so.63),
#                 which no other prebuilt FFmpeg provides.
# No external codec libraries are linked (--disable-autodetect), so there is nothing else to
# bundle. HEVC-to-H.264 transcoding needs libx264 and is therefore not available; the app
# stream-copies H.264, which is what it asks Apple for.
#
# Needs: gcc, make, pkg-config, patchelf, curl, tar, xz, zlib headers. No nasm: SIMD is off, which is
# fine for the audio decoding and stream copying done here.

set -euo pipefail

VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
URL="https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO/.ffmpeg-build"
OUT="$REPO/third_party/ffmpeg"
JOBS="$(nproc 2>/dev/null || echo 4)"

die() { echo "Error: $*" >&2; exit 1; }
for t in gcc make curl tar xz sha256sum patchelf; do command -v "$t" >/dev/null 2>&1 || die "'$t' is required"; done

mkdir -p "$WORK"
TARBALL="$WORK/ffmpeg-$VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fL --retry 3 -o "$TARBALL" "$URL"
echo "$SHA256  $TARBALL" | sha256sum -c - >/dev/null || die "checksum mismatch for $TARBALL"

rm -rf "$WORK/src" && mkdir -p "$WORK/src"
tar -xf "$TARBALL" -C "$WORK/src" --strip-components=1
cd "$WORK/src"

STAGE="$WORK/stage"
rm -rf "$STAGE"

./configure \
    --prefix="$STAGE" \
    --disable-autodetect --enable-zlib \
    --disable-everything --disable-doc --disable-debug --disable-static --enable-shared \
    --disable-x86asm --disable-network --disable-avdevice \
    --disable-ffplay --disable-ffprobe --enable-ffmpeg \
    --enable-pic --enable-small \
    --enable-protocol=file,pipe \
    --enable-demuxer=mov,srt,flac,aac,mp3,wav,ac3,eac3 \
    --enable-muxer=mp4,mov,ipod,flac,null \
    --enable-decoder=alac,aac,aac_latm,flac,mp3,mp3float,ac3,eac3,opus,vorbis,h264,srt,subrip,movtext,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
    --enable-encoder=flac,aac,movtext,pcm_s16le,pcm_s24le \
    --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,h264,hevc,opus,vorbis \
    --enable-bsf=aac_adtstoasc,extract_extradata,null \
    --enable-filter=abuffer,abuffersink,buffer,buffersink,aformat,aresample,anull,null,format,scale

make -j"$JOBS"
make install

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"
cp "$STAGE/bin/ffmpeg" "$OUT/bin/"
cp -a "$STAGE"/lib/lib*.so.* "$OUT/lib/"   # soname links and real files; no unversioned dev links
strip --strip-unneeded "$OUT/bin/ffmpeg" "$OUT"/lib/*.so.* 2>/dev/null || true
# Find the bundled libraries next to the binary, and each library next to its siblings,
# whatever LD_LIBRARY_PATH says.
patchelf --set-rpath '$ORIGIN/../lib' "$OUT/bin/ffmpeg"
for f in "$OUT"/lib/*.so.*.*; do patchelf --set-rpath '$ORIGIN' "$f"; done
cp COPYING.LGPLv2.1 "$OUT/COPYING.LGPLv2.1"
cat > "$OUT/README.md" <<EOT
# Prebuilt minimal FFmpeg

FFmpeg $VERSION, built from $URL
(sha256 $SHA256) by scripts/build-ffmpeg.sh as an LGPL v2.1 build with no external codec
libraries. The corresponding source is that tarball; the exact configure flags are in the script.
Do not edit these files: regenerate them with the script.
EOT
echo ""
echo "Done: $OUT"
du -sh "$OUT"/bin/ffmpeg "$OUT"/lib | cat
