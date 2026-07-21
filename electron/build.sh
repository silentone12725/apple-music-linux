#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Install deps only when missing ───────────────────────────────────────────
if [ ! -f node_modules/.bin/electron ]; then
    npm install --save-dev electron electron-builder 2>/dev/null || true
fi

# ── Bundle VLC libs (audio-only subset) ──────────────────────────────────────
VLC_DEST=dist/resources/vlc
if [ ! -f "$VLC_DEST/libvlc.so.5" ]; then
    echo "Bundling VLC libs → $VLC_DEST ..."
    mkdir -p "$VLC_DEST"
    # Core libs
    cp /usr/lib/libvlc.so.5.* "$VLC_DEST/"
    cp /usr/lib/libvlccore.so.9.* "$VLC_DEST/"
    (cd "$VLC_DEST" && ln -sf libvlc.so.5.*.* libvlc.so.5 && ln -sf libvlccore.so.9.*.* libvlccore.so.9)

    SRC=/usr/lib/vlc/plugins
    P="$VLC_DEST/plugins"
    mkdir -p "$P"/{access,demux,codec,audio_output,audio_filter,packetizer,misc,stream_filter,control}

    # access — HTTP/HTTPS/TCP/filesystem only
    cp "$SRC"/access/{libhttp_plugin.so,libhttps_plugin.so,libtcp_plugin.so,libfilesystem_plugin.so,libimem_plugin.so,libidummy_plugin.so,libattachment_plugin.so,libudp_plugin.so} "$P/access/" 2>/dev/null || true

    # demux — HLS (adaptive), MP4/M4A, TS, elementary streams, FLAC, fallback avformat
    cp "$SRC"/demux/{libadaptive_plugin.so,libmp4_plugin.so,libts_plugin.so,libes_plugin.so,libavformat_plugin.so,libflacsys_plugin.so,libogg_plugin.so,libwav_plugin.so,librawaud_plugin.so,libplaylist_plugin.so} "$P/demux/" 2>/dev/null || true

    # codec — ALAC/AAC/MP3/AC3/FLAC via ffmpeg + individual fallbacks
    cp "$SRC"/codec/{libavcodec_plugin.so,libaraw_plugin.so,libmpg123_plugin.so,liba52_plugin.so,libflac_plugin.so,libvorbis_plugin.so,libopus_plugin.so,libspdif_plugin.so,libddummy_plugin.so,libedummy_plugin.so,liblpcm_plugin.so,libg711_plugin.so,libfaad_plugin.so} "$P/codec/" 2>/dev/null || true

    # audio_output — PulseAudio + ALSA + dummy
    cp "$SRC"/audio_output/{libpulse_plugin.so,libalsa_plugin.so,libamem_plugin.so,libadummy_plugin.so,libafile_plugin.so} "$P/audio_output/" 2>/dev/null || true

    # audio_filter — format conversion + resampling (essential for rate/format matching)
    cp "$SRC"/audio_filter/{libaudio_format_plugin.so,libsimple_channel_mixer_plugin.so,libtrivial_channel_mixer_plugin.so,libsamplerate_plugin.so,libsoxr_plugin.so,libspeex_resampler_plugin.so,libscaletempo_plugin.so,libgain_plugin.so,libnormvol_plugin.so,libmono_plugin.so,libugly_resampler_plugin.so} "$P/audio_filter/" 2>/dev/null || true

    # packetizer — AAC/ALAC, AC-3/E-AC-3 (Atmos), FLAC, MP3, copy, generic
    cp "$SRC"/packetizer/{libpacketizer_mpeg4audio_plugin.so,libpacketizer_a52_plugin.so,libpacketizer_flac_plugin.so,libpacketizer_mpegaudio_plugin.so,libpacketizer_copy_plugin.so,libpacketizer_avparser_plugin.so,libpacketizer_mlp_plugin.so,libpacketizer_dts_plugin.so} "$P/packetizer/" 2>/dev/null || true

    # misc — TLS (HTTPS), XML (HLS manifest parsing), logger
    cp "$SRC"/misc/{libgnutls_plugin.so,libxml_plugin.so,liblogger_plugin.so} "$P/misc/" 2>/dev/null || true

    # stream_filter — needed for HLS segment stitching
    if [ -d "$SRC/stream_filter" ]; then
        cp "$SRC"/stream_filter/lib{inflate,prefetch,record,skip,cache_read,cache_block}_plugin.so "$P/stream_filter/" 2>/dev/null || true
    fi

    # control — dummy control interface (VLC requires at least one)
    if [ -d "$SRC/control" ]; then
        cp "$SRC"/control/libdummy_plugin.so "$P/control/" 2>/dev/null || true
    fi

    # Regenerate plugin cache so VLC doesn't scan on every start
    vlc-cache-gen "$P" 2>/dev/null || true

    echo "VLC bundled: $(du -sh "$VLC_DEST" | cut -f1)"
fi

# ── Use bundled Electron from node_modules ────────────────────────────────────
ELECTRON=node_modules/.bin/electron

echo "Launching with bundled Electron $("$ELECTRON" --version 2>/dev/null)..."
exec "$ELECTRON" --no-sandbox . "$@"
