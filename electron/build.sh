#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Install deps only when missing ───────────────────────────────────────────
if [ ! -f node_modules/.bin/electron ]; then
    npm install --save-dev electron electron-builder 2>/dev/null || true
fi

# ── Bundle VLC libs (audio-only subset; no-op when already bundled) ──────────
bash ../scripts/bundle-vlc.sh

# ── Use bundled Electron from node_modules ────────────────────────────────────
ELECTRON=node_modules/.bin/electron

echo "Launching with bundled Electron $("$ELECTRON" --version 2>/dev/null)..."
exec "$ELECTRON" --no-sandbox . "$@"
