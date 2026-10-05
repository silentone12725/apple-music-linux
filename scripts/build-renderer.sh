#!/usr/bin/env bash
# build-renderer.sh — builds every bundle injected into the Apple Music page from its
# source in electron/src/, so none of them can be packaged stale:
#
#   engine-bundle.js      esbuild  src/engine-playback.js (+ src/engine/*.js)
#   engine-sse-bundle.js  esbuild  src/engine-sse.js
#   smart-cache-bundle.js esbuild  src/smart-cache.js
#   vision-bundle.js      verbatim copy of src/vision-glass.js
#
# mp4box-bundle.js is a pinned build of the third-party mp4box library, not derived from
# src/, so it is only checked for presence.
#
# main.mjs prefers a bundle in <resources>/ over the one in app.asar, so when an unpacked
# build exists its copies are refreshed too.
#
# Usage: scripts/build-renderer.sh

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/electron"

ESB=(npx esbuild --bundle --format=iife --log-level=warning)

"${ESB[@]}" src/engine-playback.js --outfile=engine-bundle.js
"${ESB[@]}" src/engine-sse.js --global-name=_amlSSEMod --outfile=engine-sse-bundle.js
"${ESB[@]}" src/smart-cache.js --outfile=smart-cache-bundle.js
cp src/vision-glass.js vision-bundle.js

[ -s mp4box-bundle.js ] || { echo "error: electron/mp4box-bundle.js is missing" >&2; exit 1; }

# A bundle with module syntax left in it would throw when injected as a plain script.
for b in engine-bundle.js engine-sse-bundle.js smart-cache-bundle.js; do
    if grep -qE '^\s*(import\s.+\sfrom\s|export\s)' "$b"; then
        echo "error: $b still contains import/export" >&2
        exit 1
    fi
done

UNPACKED="dist/linux-unpacked/resources"
if [ -d "$UNPACKED" ]; then
    cp engine-bundle.js engine-sse-bundle.js smart-cache-bundle.js vision-bundle.js mp4box-bundle.js "$UNPACKED/"
fi
echo "renderer bundles built"
