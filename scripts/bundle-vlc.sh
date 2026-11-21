#!/usr/bin/env bash
# bundle-vlc.sh — copies the audio-only subset of the system VLC (libvlc, libvlccore and
# the plugins the engine uses) into electron/dist/resources/vlc, where electron-builder
# picks it up and main.mjs points LD_LIBRARY_PATH / VLC_PLUGIN_PATH at it. Without it the
# installed app depends on whatever VLC the user has.
#
# Usage: scripts/bundle-vlc.sh [--force]   (--force rebuilds an existing bundle)
# ADAM_VLC_DEST selects a dev/package stage under electron/dist/.
# ADAM_VLC_CANDIDATE_C_SOURCE opts into the reviewed VLC 3.0.24 development patch.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST="$(realpath -m "${ADAM_VLC_DEST:-$REPO/electron/dist/resources/vlc}")"
case "$DEST" in */vlc) ;; *) echo 'error: VLC destination must be a vlc directory' >&2; exit 1 ;; esac
case "$DEST/" in "$REPO/electron/dist/"*) ;; *) echo 'error: VLC destination must be under electron/dist/' >&2; exit 1 ;; esac
# Opt-in DEVELOPMENT integration only. Default/release packaging remains stock.
apply_candidate_c() {
    [ -n "${ADAM_VLC_CANDIDATE_C_SOURCE:-}" ] || return 0
    python3 "$REPO/scripts/build-vlc-mp4.py" --source "$ADAM_VLC_CANDIDATE_C_SOURCE" --runtime "$DEST"
}
LIBDIR="${ADAM_VLC_LIBDIR:-/usr/lib}"
SRC="${ADAM_VLC_PLUGINS:-$LIBDIR/vlc/plugins}"

if [ "${1:-}" = "--force" ]; then
    rm -rf "$DEST"
fi
if [ -f "$DEST/libvlc.so.5" ] && [ -d "$DEST/plugins" ]; then
    if [ -f "$DEST/playback01-candidate-c.json" ] && [ -z "${ADAM_VLC_CANDIDATE_C_SOURCE:-}" ]; then
        echo 'error: cached Candidate C dev runtime requires explicit ADAM_VLC_CANDIDATE_C_SOURCE; use --force for stock.' >&2
        exit 1
    fi
    echo "Rechecking existing VLC bundle: $DEST"
else

if ! ls "$LIBDIR"/libvlc.so.5.* >/dev/null 2>&1 || [ ! -d "$SRC" ]; then
    echo "error: system VLC not found (looked for $LIBDIR/libvlc.so.5.* and $SRC)." >&2
    echo "  Install it (e.g. 'sudo pacman -S vlc' / 'sudo apt install vlc') or set ADAM_VLC_LIBDIR / ADAM_VLC_PLUGINS." >&2
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
# codec — ALAC/AAC/MP3/AC3/FLAC via ffmpeg plus individual fallbacks (no faad: libavcodec decodes AAC)
cp_plugins codec libavcodec_plugin.so libaraw_plugin.so libmpg123_plugin.so liba52_plugin.so \
    libflac_plugin.so libvorbis_plugin.so libopus_plugin.so libspdif_plugin.so \
    libddummy_plugin.so libedummy_plugin.so liblpcm_plugin.so libg711_plugin.so
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

# Libraries the plugins link that other distros (and the Flatpak runtime) do not provide. The
# FFmpeg ABI compatibility libraries are staged separately below.
for lib in libvlc_pulse.so.0 libsoxr.so.0 libdvbpsi.so.10 libaribb24.so.0 liba52.so.0; do
    real=""
    for d in "$LIBDIR" "$LIBDIR/vlc"; do   # libvlc_pulse lives in the vlc subdirectory
        [ -e "$d/$lib" ] && { real="$(readlink -f "$d/$lib")"; break; }
    done
    if [ -n "$real" ] && [ -f "$real" ]; then
        cp "$real" "$DEST/$lib"
    else
        echo "warning: $lib not found under $LIBDIR; the plugin that needs it will not load" >&2
    fi
done

fi # initial stock staging; cached bundles still stage compatibility libs and validate

# FFmpeg libraries matching this VLC's plugins, when third_party/ffmpeg (FFmpeg 9) does not: built by
# scripts/build-vlc-ffmpeg.sh. They go next to libvlc, which LD_LIBRARY_PATH already covers.
if [ -n "${ADAM_VLC_FFMPEG_LIBDIR:-}" ]; then
    cp -a "$ADAM_VLC_FFMPEG_LIBDIR"/lib*.so.* "$DEST/"
fi

apply_candidate_c

# Every library a bundled plugin links must resolve inside the bundle or be a library every
# system has. FFmpeg and the support libraries above resolving from /usr/lib would work here and
# fail on the next machine, so insist they come from the bundle.
FFLIB="$REPO/third_party/ffmpeg/lib"
[ -d "$FFLIB" ] || { echo "error: $FFLIB is missing (git lfs pull?)" >&2; exit 1; }
bad=0
P="$DEST/plugins"
python3 "$REPO/scripts/check-vlc-ffmpeg.py" --plugins "$P" --runtime "$DEST" --ffmpeg-libdir "$FFLIB"
for plug in "$P/codec/libavcodec_plugin.so" "$P/demux/libavformat_plugin.so" "$P/audio_output/libpulse_plugin.so"; do
    [ -f "$plug" ] || continue
    out="$(LD_LIBRARY_PATH="$DEST:$FFLIB" ldd "$plug" 2>/dev/null)"
    for dep in libavcodec libavformat libavutil libvlc_pulse; do
        line="$(grep "^[[:space:]]*$dep\." <<<"$out" || true)"
        [ -z "$line" ] && continue
        case "$line" in *"$DEST"/*|*"$FFLIB"/*) ;; *) echo "error: $(basename "$plug") resolves $dep outside the bundle: $line" >&2; bad=1 ;; esac
    done
done
[ "$bad" = 0 ] || exit 1

# Nothing bundled may need a newer glibc than the other packaged binaries (the 2.38 release target): a
# library copied from a rolling distro can require symbols that older systems and the Flatpak runtime lack.
# ADAM_MAX_GLIBC above 2.38 is a development-only target; build-installer.sh re-audits at 2.38 regardless.
# A cached bundle is re-audited on every run, so a development bundle cannot pass a release build.
python3 "$REPO/scripts/check-vlc-glibc.py" --runtime "$DEST" \
    --library-dir "$FFLIB" --max "${ADAM_MAX_GLIBC:-2.38}" --closure

# Regenerate the plugin cache so VLC does not scan on every start.
vlc-cache-gen "$P" 2>/dev/null || true

echo "VLC bundled: $(du -sh "$DEST" | cut -f1)"
