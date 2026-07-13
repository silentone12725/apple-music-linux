#!/usr/bin/env bash
# compare-outputs.sh — download a track via both legacy and engine, compare.
#
# Usage:
#   ./verification/scripts/compare-outputs.sh <adamID> [storefront]
#
# Prerequisites:
#   - Engine running: ./apple-music-cli --api 8080 (or set AM_ENGINE_PORT)
#   - config.yaml with valid token + MUT
#   - MP4Box installed (for structural comparison)
#   - jq installed (for JSON parsing)
#
# Output:
#   verification/output-hashes/<adamID>-<date>-legacy.sha256
#   verification/output-hashes/<adamID>-<date>-engine.sha256
#   verification/mp4box-reports/<adamID>-<date>-legacy.txt
#   verification/mp4box-reports/<adamID>-<date>-engine.txt
#
# Exit code 0 if hashes match, 1 if they differ.

set -euo pipefail

ADAM_ID="${1:?Usage: $0 <adamID> [storefront]}"
STOREFRONT="${2:-us}"
DATE=$(date +%Y-%m-%d)
ENGINE_PORT="${AM_ENGINE_PORT:-8080}"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
HASH_DIR="$REPO_ROOT/verification/output-hashes"
MP4_DIR="$REPO_ROOT/verification/mp4box-reports"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

LEGACY_OUT="$TMP/legacy-${ADAM_ID}.m4a"
ENGINE_OUT="$TMP/engine-${ADAM_ID}.m4a"

# ── Legacy download ───────────────────────────────────────────────────────────
echo "==> Legacy download (adamID=$ADAM_ID, storefront=$STOREFRONT)"
echo "    Run: cd $REPO_ROOT && ./apple-music-cli <song URL or ID>"
echo "    Save output to: $LEGACY_OUT"
echo "    Press Enter when done."
read -r

if [[ ! -f "$LEGACY_OUT" ]]; then
    echo "ERROR: $LEGACY_OUT not found. Copy the legacy output there, then re-run."
    exit 1
fi

# ── Engine download ───────────────────────────────────────────────────────────
echo ""
echo "==> Engine download (via HTTP API on port $ENGINE_PORT)"

SESSION=$(curl -sf -X POST "http://localhost:$ENGINE_PORT/api/v1/playback" \
    -H "Content-Type: application/json" \
    -d "{\"assetId\":\"$ADAM_ID\",\"storefront\":\"$STOREFRONT\",\"capabilities\":{\"lossless\":true}}" \
    | jq -r '.sessionId')

echo "    Session ID: $SESSION"
curl -sf "http://localhost:$ENGINE_PORT/api/v1/playback/$SESSION/audio" -o "$ENGINE_OUT"
curl -sf -X DELETE "http://localhost:$ENGINE_PORT/api/v1/playback/$SESSION" > /dev/null
echo "    Downloaded $(du -sh "$ENGINE_OUT" | cut -f1)"

# ── Hash comparison ───────────────────────────────────────────────────────────
echo ""
LEGACY_HASH=$(sha256sum "$LEGACY_OUT" | awk '{print $1}')
ENGINE_HASH=$(sha256sum "$ENGINE_OUT" | awk '{print $1}')

echo "Legacy SHA-256: $LEGACY_HASH"
echo "Engine SHA-256: $ENGINE_HASH"

echo "$LEGACY_HASH  ${ADAM_ID}-${DATE}-legacy.m4a" > "$HASH_DIR/${ADAM_ID}-${DATE}-legacy.sha256"
echo "$ENGINE_HASH  ${ADAM_ID}-${DATE}-engine.m4a" > "$HASH_DIR/${ADAM_ID}-${DATE}-engine.sha256"

if [[ "$LEGACY_HASH" == "$ENGINE_HASH" ]]; then
    echo "✓ IDENTICAL — outputs are byte-for-byte equal"
    RESULT=0
else
    echo "✗ DIFFER — outputs are not identical"
    echo ""
    echo "==> Running cmd/mvcompare for structural diff..."
    go run "$REPO_ROOT/cmd/mvcompare" "$LEGACY_OUT" "$ENGINE_OUT" || true
    RESULT=1
fi

# ── MP4Box reports ────────────────────────────────────────────────────────────
echo ""
echo "==> MP4Box reports"
if command -v MP4Box &>/dev/null; then
    MP4Box -info "$LEGACY_OUT" 2>&1 | tee "$MP4_DIR/${ADAM_ID}-${DATE}-legacy.txt"
    MP4Box -info "$ENGINE_OUT" 2>&1 | tee "$MP4_DIR/${ADAM_ID}-${DATE}-engine.txt"
    echo "    Reports written to $MP4_DIR/"
else
    echo "    MP4Box not found — skipping structural report"
fi

echo ""
echo "==> Written to:"
echo "    $HASH_DIR/${ADAM_ID}-${DATE}-{legacy,engine}.sha256"
[[ -f "$MP4_DIR/${ADAM_ID}-${DATE}-legacy.txt" ]] && \
    echo "    $MP4_DIR/${ADAM_ID}-${DATE}-{legacy,engine}.txt"

exit $RESULT
