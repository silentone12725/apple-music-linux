#!/usr/bin/env sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT_DIR/internal/embedded/wrapper_amd64" ]; then
  echo "Missing internal/embedded/wrapper_amd64" >&2
  exit 1
fi
if [ ! -d "$ROOT_DIR/internal/embedded/rootfs_amd64" ]; then
  echo "Missing internal/embedded/rootfs_amd64" >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/internal/embedded/apple-music-cli_amd64" ]; then
  echo "Missing internal/embedded/apple-music-cli_amd64" >&2
  exit 1
fi

cd "$ROOT_DIR"
GOOS=linux GOARCH=amd64 wails build -tags webkit2_41 -o build/bin/apple-music-linux-amd64
