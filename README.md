<div align="center">

# Apple Music Linux

[![GitHub release](https://img.shields.io/github/release/silentone12725/apple-music-linux.svg?style=for-the-badge)](https://github.com/silentone12725/apple-music-linux/releases/latest)
[![GitHub license](https://img.shields.io/github/license/silentone12725/apple-music-linux.svg?style=for-the-badge)](https://github.com/silentone12725/apple-music-linux/blob/main/LICENSE)
[![GitHub downloads](https://img.shields.io/github/downloads/silentone12725/apple-music-linux/total?style=for-the-badge)](https://github.com/silentone12725/apple-music-linux/releases)
[![Platform](https://img.shields.io/badge/platform-linux%20x86__64-blue?style=for-the-badge)](https://github.com/silentone12725/apple-music-linux/releases/latest)

An unofficial Apple Music desktop client for Linux with Lossless support

</div>

> [!IMPORTANT]
> **Disclaimer**
>
> **No Affiliation**
>
> This project and its contributors are not affiliated with, authorized by, endorsed by, or in any way officially connected with Apple Inc. or any of its subsidiaries or affiliates. This is an independent, unofficial client developed for personal use.
>
> **Trademarks**
>
> "Apple Music", "Apple", and related names, marks, and logos are registered trademarks of Apple Inc. Any use of these trademarks is for identification and reference purposes only and does not imply any association with the trademark holder.
>
> **Limitation of Liability**
>
> This application is provided "AS IS". The developers are not liable for any claim, damages, or legal consequences arising from its use. You use it entirely at your own risk. An active Apple Music subscription is required.

## Contents

- [Features](#features)
- [Roadmap](#roadmap)
- [Requirements](#requirements)
- [Download](#download)
- [Login](#login)
- [Dev](#dev)
- [Build AppImage](#build-appimage)
- [Project structure](#project-structure)
- [References](#referenced-projects)

## Features

- **Lossless & Hi-Res** — ALAC up to 192kHz, Dolby Atmos via FairPlay-decrypted HLS
- **MPRIS2** — bidirectional D-Bus media control: play/pause/next/prev/seek from any media key handler or taskbar widget
- **Frosted glass UI** — transparent window with compositor blur-behind (Hyprland/KWin)
- **Smart prefetch cache** — tracks pre-warmed before you hit play; configurable size
- **System tray** — minimize to tray with playback controls in the context menu
- **Wayland + X11** — tested on Hyprland and KDE Plasma

## Roadmap

- **Music video playback** — MV streaming with hardware-accelerated decode
- **Download support** — save lossless tracks, albums, and playlists to disk via the engine CLI
- **Consistent native UI** — custom title bar, unified controls, and sidebar that match on all desktop environments
- **Notifications** — now-playing OSD with artwork on track change
- **arm64 support** — packaging and wrapper binary for Apple Silicon / Raspberry Pi

## Requirements

- Linux x86_64
- PulseAudio or PipeWire
- Apple Music subscription

Wayland compositor with blur support (Hyprland, KWin) is recommended for the glass UI — X11 works without blur(may add software compositing in future).

## Download

Download `apple-music-linux.AppImage` from the [latest release](https://github.com/silentone12725/apple-music-linux/releases/latest):

```bash
chmod +x apple-music-linux.AppImage
./apple-music-linux.AppImage
```

[AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) integrates it into your app menu automatically on first run.

## Login

Two separate sign-ins are required:

1. **Apple Music web session** — sign in via the web UI on first launch, the same as music.apple.com in a browser
2. **Engine DRM account** — open **AML Settings** (top-left gear icon) → Engine Account → Sign In with your Apple ID. This authenticates the FairPlay layer for lossless and hi-res. Without it, playback falls back to AAC 256.

## Dev

```bash
git clone https://github.com/silentone12725/apple-music-linux
cd apple-music-linux/electron
bash build.sh
```

`build.sh` installs npm deps, bundles system VLC libs into `dist/resources/vlc`, and launches the app.

Requires: `node`, `npm`, `vlc` (provides `libvlc`)

```bash
# Arch
sudo pacman -S vlc nodejs npm

# Ubuntu/Debian
sudo apt install vlc nodejs npm
```

## Build AppImage

```bash
cd electron
bash build.sh          # bundle VLC libs first
NODE_ENV=production npm run dist
# → dist/apple-music-linux.AppImage
```

## Project structure

```
electron/
  src/
    engine-playback.js  MusicKit bridge, VLC control, settings UI
    engine-sse.js       SSE client for engine push events
    smart-cache.js      prefetch scheduler and disk cache
  main.mjs              app lifecycle, window, tray, MPRIS2, IPC
  preload.cjs           context bridge (window.amlBridge)

cli/
  engine/drm/           FairPlay session management
  engine/hls/           HLS decrypt and stream proxy
  engine/playback/      VLC HTTP control
  apiserver.go          HTTP API server (/api/v1/*)

Wrapper.x86_64.latest/  Android wrapper binary + rootfs (FairPlay DRM)
```

## References

- [apple-music-engine](https://github.com/silentone12725/apple-music-engine-dev) — Go backend: FairPlay DRM, HLS decryption, lossless streaming, SSE event bus, smart prefetch cache
- [Electron](https://electronjs.org) — desktop shell
- [libvlc](https://www.videolan.org/vlc/libvlc.html) — audio playback
- [mpris-service](https://github.com/dbkr/mpris-service) — MPRIS2 D-Bus
- [MusicKit JS](https://developer.apple.com/documentation/musickitjs) — Apple's web playback SDK (loaded from music.apple.com)
- [electron-builder](https://www.electron.build) — AppImage packaging
