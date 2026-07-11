#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Install deps (dev only, not bundled) ─────────────────────────────────────
npm install --save-dev electron electron-builder 2>/dev/null || true

# ── Quick launch using system Electron (no build needed on this machine) ─────
# System Electron 38 is already installed at /usr/lib/electron38.
# Just launch our app dir directly — zero extra disk cost.
ELECTRON=/usr/lib/electron38/electron

echo "Launching with system Electron $($ELECTRON --version 2>/dev/null || echo 38)..."
exec "$ELECTRON" . "$@"
