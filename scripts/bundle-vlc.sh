#!/usr/bin/env bash
# bundle-vlc.sh — copies the audio-only subset of the system VLC (libvlc, libvlccore and
# the plugins the engine uses) into electron/dist/resources/vlc, where electron-builder
# picks it up and main.mjs points LD_LIBRARY_PATH / VLC_PLUGIN_PATH at it. Without it the
# installed app depends on whatever VLC the user has.
#
# Usage: scripts/bundle-vlc.sh [--force]   (--force rebuilds an existing bundle)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO/electron/dist/resources/vlc"
LIBDIR="${AML_VLC_LIBDIR:-/usr/lib}"
SRC="${AML_VLC_PLUGINS:-$LIBDIR/vlc/plugins}"

if [ "${1:-}" = "--force" ]; then
    rm -rf "$DEST"
fi
if [ -f "$DEST/libvlc.so.5" ] && [ -d "$DEST/plugins" ]; then
    echo "VLC already bundled: $(du -sh "$DEST" | cut -f1)"
    exit 0
fi

if ! ls "$LIBDIR"/libvlc.so.5.* >/dev/null 2>&1 || [ ! -d "$SRC" ]; then
    echo "error: system VLC not found (looked for $LIBDIR/libvlc.so.5.* and $SRC)." >&2
    echo "  Install it (e.g. 'sudo pacman -S vlc' / 'sudo apt install vlc') or set AML_VLC_LIBDIR / AML_VLC_PLUGINS." >&2
    exit 1
fi

echo "Bundling VLC libs → $DEST ..."
mkdir -p "$DEST"
cp "$LIBDIR"/libvlc.so.5.* "$LIBDIR"/libvlccore.so.9.* "$DEST/"
(cd "$DEST" && ln -sf libvlc.so.5.*.* libvlc.so.5 && ln -sf libvlccore.so.9.*.* libvlccore.so.9)

P="$DEST/plugins"
mkdir -p "$P"/{access,demux,codec,audio_output,audio_filter,packetizer,misc,stream_filter,control}

# Each group is best-effort: a plugin a distro does not ship is simply skipped.
cp_plugins() { # <dir> <plugin>...
    local dir="$1"; shift
    local f
    for f in "$@"; do cp "$SRC/$dir/$f" "$P/$dir/" 2>/dev/null || true; done
}

# access — HTTP/HTTPS/TCP/filesystem only (imem = the engine's callback source)
cp_plugins access libhttp_plugin.so libhttps_plugin.so libtcp_plugin.so libfilesystem_plugin.so \
    libimem_plugin.so libidummy_plugin.so libattachment_plugin.so libudp_plugin.so
# demux — HLS (adaptive), MP4/M4A, TS, elementary streams, FLAC, fallback avformat
cp_plugins demux libadaptive_plugin.so libmp4_plugin.so libts_plugin.so libes_plugin.so \
    libavformat_plugin.so libflacsys_plugin.so libogg_plugin.so libwav_plugin.so \
    librawaud_plugin.so libplaylist_plugin.so
# codec — ALAC/AAC/MP3/AC3/FLAC via ffmpeg plus individual fallbacks
cp_plugins codec libavcodec_plugin.so libaraw_plugin.so libmpg123_plugin.so liba52_plugin.so \
    libflac_plugin.so libvorbis_plugin.so libopus_plugin.so libspdif_plugin.so \
    libddummy_plugin.so libedummy_plugin.so liblpcm_plugin.so libg711_plugin.so libfaad_plugin.so
# audio_output — PulseAudio + ALSA + dummy
cp_plugins audio_output libpulse_plugin.so libalsa_plugin.so libamem_plugin.so \
    libadummy_plugin.so libafile_plugin.so
# audio_filter — format conversion + resampling (rate/format matching)
cp_plugins audio_filter libaudio_format_plugin.so libsimple_channel_mixer_plugin.so \
    libtrivial_channel_mixer_plugin.so libsamplerate_plugin.so libsoxr_plugin.so \
    libspeex_resampler_plugin.so libscaletempo_plugin.so libgain_plugin.so libnormvol_plugin.so \
    libmono_plugin.so libugly_resampler_plugin.so
# packetizer — AAC/ALAC, AC-3/E-AC-3 (Atmos), FLAC, MP3, copy, generic
cp_plugins packetizer libpacketizer_mpeg4audio_plugin.so libpacketizer_a52_plugin.so \
    libpacketizer_flac_plugin.so libpacketizer_mpegaudio_plugin.so libpacketizer_copy_plugin.so \
    libpacketizer_avparser_plugin.so libpacketizer_mlp_plugin.so libpacketizer_dts_plugin.so
# misc — TLS (HTTPS), XML (HLS manifests), logger
cp_plugins misc libgnutls_plugin.so libxml_plugin.so liblogger_plugin.so
# stream_filter — HLS segment stitching
for n in inflate prefetch record skip cache_read cache_block; do
    cp_plugins stream_filter "lib${n}_plugin.so"
done
# control — dummy interface (VLC needs at least one)
cp_plugins control libdummy_plugin.so

# Core plugins the engine cannot do without: fail the build rather than ship a silent player.
for need in access/libimem_plugin.so demux/libmp4_plugin.so audio_output/libpulse_plugin.so; do
    if [ ! -f "$P/$need" ] && [ ! -f "$P/${need/libpulse/libalsa}" ]; then
        echo "error: required VLC plugin $need was not found under $SRC" >&2
        exit 1
    fi
done

# Regenerate the plugin cache so VLC does not scan on every start.
vlc-cache-gen "$P" 2>/dev/null || true

echo "VLC bundled: $(du -sh "$DEST" | cut -f1)"
