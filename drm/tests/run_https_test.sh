#!/usr/bin/env bash
# Builds and runs the HTTPS client tests against a local misbehaving TLS server.
#   drm/tests/run_https_test.sh        (needs libdrm_client.so, python3, openssl, gcc)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRM="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'kill "${SRV:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')

python3 "$HERE/https_server.py" "$TMP/cert.pem" "$TMP/key.pem" "$PORT" >"$TMP/server.log" 2>&1 &
SRV=$!
for _ in $(seq 50); do grep -q ready "$TMP/server.log" 2>/dev/null && break; sleep 0.1; done

# The repo path may contain a space, which -L/-I cannot take: build through a symlink.
ln -s "$DRM" "$TMP/drm"
gcc -Wall -Wextra -std=c11 -D_GNU_SOURCE -o "$TMP/https_fetch_test" "$HERE/https_fetch_test.c" \
    -I"$TMP/drm" -L"$TMP/drm" -ldrm_client -Wl,-rpath,"$TMP/drm"

mkdir "$TMP/cookies"
SSL_CERT_FILE="$TMP/cert.pem" AML_HTTPS_TIMEOUT_SEC=2 \
    "$TMP/https_fetch_test" "$PORT" "$TMP/cookies" 2>"$TMP/client.log" || { tail -30 "$TMP/client.log" >&2; exit 1; }
