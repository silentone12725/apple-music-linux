#!/usr/bin/env bash
# Sourced by build-ffmpeg.sh (Linux) and build-ffmpeg-windows.sh: the pinned FFmpeg source and the
# component list, so both platforms ship the same minimal build.

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"

# An LGPL build with only what the app uses; --disable-autodetect keeps external codec libraries out.
# Platform scripts add --prefix, the target and their own linking flags.
FFMPEG_COMMON_FLAGS=(
    --disable-autodetect --enable-zlib
    --disable-everything --disable-doc --disable-debug --disable-static --enable-shared
    --disable-network --disable-avdevice
    --disable-ffplay --disable-ffprobe --enable-ffmpeg
    --enable-small
    --enable-protocol=file,pipe
    --enable-demuxer=mov,srt,flac,aac,mp3,wav,ac3,eac3
    --enable-muxer=mp4,mov,ipod,flac,null
    --enable-decoder=alac,aac,aac_latm,flac,mp3,mp3float,ac3,eac3,opus,vorbis,h264,srt,subrip,movtext,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le
    --enable-encoder=flac,aac,movtext,pcm_s16le,pcm_s24le
    --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,h264,hevc,opus,vorbis
    --enable-bsf=aac_adtstoasc,extract_extradata,null
    --enable-filter=abuffer,abuffersink,buffer,buffersink,aformat,aresample,anull,null,format,scale
)
