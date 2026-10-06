#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# ── Install deps only when missing ───────────────────────────────────────────
if [ ! -f node_modules/.bin/electron ]; then
    npm ci
fi

# Build before launching so fresh checkouts have an engine and renderer fixes.
npm run build:drm
npm run build:go
npm run build:engine

# ── Bundle VLC libs (audio-only subset; no-op when already bundled) ──────────
bash ../scripts/bundle-vlc.sh

# ── Use bundled Electron from node_modules ────────────────────────────────────
ELECTRON=node_modules/.bin/electron

echo "Launching with bundled Electron $("$ELECTRON" --version 2>/dev/null)..."
exec "$ELECTRON" --no-sandbox . "$@"
