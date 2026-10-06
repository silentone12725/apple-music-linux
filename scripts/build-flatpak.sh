#!/usr/bin/env bash
# build-flatpak.sh — builds dist/apple-music-linux.flatpak, a single-file bundle.
#
# It wraps the unpacked Electron app that scripts/build-installer.sh and `npm run dist`
# produce (electron/dist/linux-unpacked), so the engine, DRM libraries and VLC are the same
# files as in the .run installer and the AppImage. Run one of those first.
#
# Needs: flatpak, and flatpak-builder (or the org.flatpak.Builder Flatpak), plus the
# org.freedesktop.Platform and Sdk 25.08 runtimes and org.electronjs.Electron2.BaseApp:
#   flatpak install flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08 \
#       org.electronjs.Electron2.BaseApp//25.08
#
# Usage: scripts/build-flatpak.sh

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID=io.github.silentone12725.AppleMusicLinux
OUT="$REPO/dist/apple-music-linux.flatpak"

die() { echo "Error: $*" >&2; exit 1; }

[ -x "$REPO/electron/dist/linux-unpacked/apple-music-linux" ] \
    || die "electron/dist/linux-unpacked not found — run scripts/build-installer.sh or 'npm run dist' first"
[ ! -e "$REPO/electron/dist/linux-unpacked/resources/rootfs/data" ] \
    || die "resources/rootfs/data present — it holds a personal Apple session; refusing to package it"
command -v flatpak >/dev/null 2>&1 || die "flatpak is required"

if command -v flatpak-builder >/dev/null 2>&1; then
    BUILDER=(flatpak-builder)
elif flatpak info org.flatpak.Builder >/dev/null 2>&1; then
    # the Builder Flatpak only sees the directories it is given
    BUILDER=(flatpak run --filesystem="$REPO" org.flatpak.Builder)
else
    die "flatpak-builder not found (install it, or: flatpak install flathub org.flatpak.Builder)"
fi

BUILD="$REPO/.flatpak-build"
STATE="$REPO/.flatpak-builder"
REPO_DIR="$REPO/.flatpak-repo"
trap 'rm -rf "$BUILD"' EXIT

echo "Building the Flatpak ($ID)..."
"${BUILDER[@]}" --force-clean --disable-rofiles-fuse --user \
    --state-dir="$STATE" --repo="$REPO_DIR" \
    "$BUILD" "$REPO/flatpak/$ID.yml"

mkdir -p "$REPO/dist"
rm -f "$OUT"
flatpak build-bundle "$REPO_DIR" "$OUT" "$ID" \
    --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

echo ""
echo "Done: $OUT ($(du -sh "$OUT" | cut -f1))"
echo "Install: flatpak install --user $OUT"
echo "Run:     flatpak run $ID"
