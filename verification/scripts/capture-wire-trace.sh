#!/usr/bin/env bash
# capture-wire-trace.sh — capture a socat trace of the FairPlay TCP socket
# for a single track download, then parse it with cmd/protoinspect.
#
# Usage:
#   ./verification/scripts/capture-wire-trace.sh <adamID> [legacy|engine]
#
# Prerequisites:
#   - socat installed (apt install socat)
#   - Wrapper server running on 127.0.0.1:10020
#   - config.yaml configured (MUT, token, storefront)
#
# Output:
#   verification/wire-traces/<adamID>-<mode>-<date>.txt   raw socat trace
#   verification/wire-traces/<adamID>-<mode>-<date>.json  protoinspect output
#
# The trace file is large (tens to hundreds of MB for ALAC).
# It is listed in .gitignore; only the protoinspect JSON is committed.

set -euo pipefail

ADAM_ID="${1:?Usage: $0 <adamID> [legacy|engine]}"
MODE="${2:-legacy}"
DATE=$(date +%Y-%m-%d)
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
OUT_DIR="$REPO_ROOT/verification/wire-traces"
PROXY_PORT=10021
REAL_PORT=10020

TRACE="$OUT_DIR/${ADAM_ID}-${MODE}-${DATE}.txt"
JSON="$OUT_DIR/${ADAM_ID}-${MODE}-${DATE}.json"

echo "==> Starting socat proxy on :$PROXY_PORT → :$REAL_PORT"
socat -x -v "TCP-LISTEN:$PROXY_PORT,reuseaddr,fork" "TCP:127.0.0.1:$REAL_PORT" 2>"$TRACE" &
SOCAT_PID=$!
trap "kill $SOCAT_PID 2>/dev/null; exit" INT TERM EXIT

echo "==> socat PID $SOCAT_PID; trace → $TRACE"
echo "==> NOW: run your download pointing at port $PROXY_PORT instead of $REAL_PORT"
echo "    For legacy ALAC: edit config.yaml decrypt_m3u8_port to 10021, run the CLI"
echo "    For engine ALAC: POST to /api/v1/playback with lossless:true (port patched)"
echo ""
echo "    Press Enter when download is complete to stop the proxy and parse the trace."
read -r

kill $SOCAT_PID 2>/dev/null || true
trap - INT TERM EXIT

echo "==> Parsing trace with cmd/protoinspect..."
go run "$REPO_ROOT/cmd/protoinspect" "$TRACE" --json > "$JSON"

echo ""
echo "==> Summary:"
go run "$REPO_ROOT/cmd/protoinspect" "$TRACE"
echo ""
echo "==> JSON written to: $JSON"
echo "==> Raw trace at:    $TRACE  ($(du -sh "$TRACE" | cut -f1))"
echo ""
echo "Add JSON to git. Raw trace is in .gitignore (too large)."
