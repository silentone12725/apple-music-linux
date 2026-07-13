# Apple Music CLI Architecture

## Overview
This application is a command-line interface (CLI) and Terminal User Interface (TUI) for interacting with Apple Music. It allows users to search the Apple Music catalog, download tracks (in ALAC, AAC, Atmos), fetch metadata, lyrics, and stream media directly from the terminal.

## Core Components

### `main.go`
The entry point of the application. It handles:
- Command-line argument parsing and flag configuration.
- Routing to specific "rip" functions (e.g., `ripAlbum`, `ripSong`, `ripPlaylist`, `ripStation`) based on the provided URL.
- Extracting parameters like `storefront`, `token`, and `mediaUserToken`.
- Setting up the download/stream pipeline, determining audio quality (`alac-max`, `atmos-max`, `aac-type`), and fetching manifests.

### `tui.go`
Provides an interactive Terminal User Interface using the `survey` library.
- Triggered when the app is run with no arguments.
- Offers interactive menus for:
  - **Search**: Search for songs, albums, artists, music videos, or playlists.
  - **URL**: Paste direct Apple Music URLs.
  - **Settings**: Interactively modify configurations (download folders, streaming folders, audio quality, conversion settings, tagging, lyrics, artwork).
- Incorporates playback control (`tuiNowPlaying`) when streaming is enabled.

### `stream.go`
Handles on-the-fly streaming of media without permanently saving it to disk.
- Sets up background prefetching (`startPrefetchTrack`).
- Interfaces with external media players like `mpv` (via IPC) or `ffplay`.
- Implements `PlayerSession` for controlling playback (Play, Pause, Next, Previous, Stop).
- Manages an LRU-style disk cache (`streamDiskCachePath`, `evictCacheIfNeeded`) to store downloaded segments temporarily during streaming.

## Utility Packages (`/utils`)

### `/utils/ampapi`
Handles all interactions with the Apple Music API (both public Catalog API and internal endpoints).
- **`token.go`**: Scrapes `music.apple.com` to dynamically obtain the Developer/Authorization JWT token required for API access.
- **`search.go`**: Queries the `/v1/catalog/{storefront}/search` endpoint.
- **`song.go`, `album.go`, `playlist.go`, `artist.go`, `station.go`, `musicvideo.go`**: Contains definitions and API wrappers to fetch specific entity metadata.

### `/utils/runv2` & `/utils/runv3`
These packages handle the heavy lifting of media downloading and decryption.
- **`runv3/cdm`**: Contains the Content Decryption Module logic (Widevine PSSH parsing, proto definitions) to acquire keys.
- **`runv3/key`**: Interfaces with the Apple Music DRM servers to fetch decryption keys (`acquireWebPlaybackLicense`).
- **`runv3/runv3.go`**: Manages the download of encrypted MP4 segments, handles the decryption stream (`DecryptMP4`), and remuxes them. It includes specific streaming functions like `RunStream`.

### `/utils/lyrics`
Responsible for fetching and converting lyrics.
- Fetches standard synced lyrics or syllable-level lyrics (TTML).
- Converts TTML formats to standard LRC formats (`TtmlToLrc`, `conventSyllableTTMLToLRC`).

### `/utils/structs`
Defines the core data structures used throughout the application.
- **`ConfigSet`**: The massive configuration struct mirroring `config.yaml`, holding all user preferences (folders, formats, audio quality, FFmpeg settings).

### `/utils/task`
Contains models and helpers for representing download jobs (e.g., `Track`, `Album`, `Playlist`).
