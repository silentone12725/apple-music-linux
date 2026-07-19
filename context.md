# Project context

## What this is

Unofficial Apple Music desktop client for Linux. Electron shell that wraps music.apple.com, with a Go engine sidecar (`apple-music-engine-dev`) for FairPlay DRM and lossless HLS streaming, and libvlc for in-process audio rendering.

## Repos

| Repo | Purpose |
|------|---------|
| `apple-music-linux` | This repo — Electron frontend, Android wrapper, AppImage packaging |
| `apple-music-engine-dev` | Go engine — DRM, HLS decryption, libvlc, HTTP API, SSE event bus |

## Current state (2026-07-20)

- `main` branch is production. `feat/vlc-playback` was the active dev branch (merged to main).
- Audio playback fully migrated from MSE/ffmpeg to libvlc in-process.
- AppImage released as `v1.0.0-pre` on GitHub Releases.
- Credential files purged from all git history (MUSIC_TOKEN, adi.pb, mpl_db/).
- Engine runs on port `20025`, started by `electron/build.sh` or bundled in the AppImage.

## Architecture

```
music.apple.com (BrowserWindow)
    ↕ MusicKit JS
electron/src/engine-playback.js   — MusicKit ↔ engine bridge, VLC control, Settings UI
    ↕ HTTP (localhost:20025)
apple-music-cli                   — Go engine (DRM + HLS + libvlc + SSE)
    ↕ TCP socket / FairPlay
Wrapper.x86_64.latest/            — Android wrapper (FairPlay key acquisition)
```

SSE event bus (`/api/v1/events`) pushes DRM state, queue changes, and playback events from the engine to the frontend without polling.

## Playback flow

1. MusicKit JS resolves track → `engine-playback.js` calls `POST /api/v1/playback` with track ID + quality capabilities
2. Engine decrypts HLS via FairPlay/Widevine → streams ALAC/AAC/Atmos fMP4 at `/api/v1/playback/{id}/audio`
3. engine-playback.js calls `PUT /api/v1/vlc/queue` to hand the audio URL to libvlc
4. libvlc renders to PulseAudio/PipeWire
5. MPRIS2 D-Bus integration in `main.mjs` exposes playback state to media key handlers

## Quality support

| Format | Notes |
|--------|-------|
| ALAC 16–24bit, up to 192kHz | FairPlay CBCS path |
| Dolby Atmos (EC-3) | FairPlay CBCS path |
| AAC-LC 256 kbps | Widevine CTR path, no wrapper needed |
| AAC Binaural | Widevine CTR path |

## Login

Two sign-ins required:
1. **Web session** — sign in to music.apple.com via the app UI on first launch
2. **Engine DRM account** — AML Settings → Engine Account → Sign In (Apple ID; authenticates FairPlay layer)

## Key config

Engine config at `~/.config/apple-music-linux/engine-data/config.yaml`:
- `get-m3u8-mode: hires` — selects ALAC/Atmos
- `storefront: us` — must match account storefront for lyrics

## Roadmap

- Music video playback (MV streaming with hardware decode)
- Download support (lossless tracks to disk via engine CLI)
- Consistent native UI (custom title bar, unified sidebar)
- Now-playing OSD notifications
- arm64 AppImage

## Known issues / gotchas

- `will-change: transform` on `nav.navigation` breaks nav buttons on Wayland — do not set it
- Tray icon must use packaged-aware path (`process.resourcesPath` vs `__dirname/../`)
- Engine session lock (`engine-session.lock`) prevents two engine instances owning the same FairPlay session
- Atmos socket-level stripe protocol is reverse engineered (not wire-verified); output is correct
