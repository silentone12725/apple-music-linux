#!/bin/sh
# zypak runs Electron's Chromium sandbox through the Flatpak sandbox.
exec zypak-wrapper.sh /app/apple-music-linux/apple-music-linux --ozone-platform-hint=auto "$@"
