#!/usr/bin/env sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT_DIR/internal/embedded/wrapper_arm64" ]; then
  echo "Missing internal/embedded/wrapper_arm64" >&2
  exit 1
fi
if [ ! -d "$ROOT_DIR/internal/embedded/rootfs_arm64" ]; then
  echo "Missing internal/embedded/rootfs_arm64" >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/internal/embedded/apple-music-cli_arm64" ]; then
  echo "Missing internal/embedded/apple-music-cli_arm64" >&2
  exit 1
fi

cd "$ROOT_DIR"
GOOS=linux GOARCH=arm64 wails build -tags webkit2_41 -o build/bin/apple-music-linux-arm64
