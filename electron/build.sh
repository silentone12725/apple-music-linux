#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Install deps only when missing ───────────────────────────────────────────
if [ ! -f node_modules/.bin/electron ]; then
    npm install --save-dev electron electron-builder 2>/dev/null || true
fi

# ── Bundle VLC libs if not already present ────────────────────────────────────
VLC_DEST=dist/resources/vlc
if [ ! -f "$VLC_DEST/libvlc.so.5" ]; then
    echo "Bundling VLC libs → $VLC_DEST ..."
    mkdir -p "$VLC_DEST"
    # Core libs (copy actual files, then symlink the .so.N name the linker expects)
    cp /usr/lib/libvlc.so.5.* "$VLC_DEST/"
    cp /usr/lib/libvlccore.so.9.* "$VLC_DEST/"
    (cd "$VLC_DEST" && ln -sf libvlc.so.5.*.* libvlc.so.5 && ln -sf libvlccore.so.9.*.* libvlccore.so.9)
    # Plugins (codec/demux/ao/sout — everything VLC needs to decode audio)
    cp -r /usr/lib/vlc/plugins "$VLC_DEST/"
    echo "VLC bundled: $(du -sh "$VLC_DEST" | cut -f1)"
fi

# ── Use bundled Electron from node_modules ────────────────────────────────────
ELECTRON=node_modules/.bin/electron

echo "Launching with bundled Electron $("$ELECTRON" --version 2>/dev/null)..."
exec "$ELECTRON" . "$@"
