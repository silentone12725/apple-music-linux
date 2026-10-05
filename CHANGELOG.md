# Changelog

All notable changes to Apple Music Linux, from the first release. The format follows Keep a
Changelog, and releases are numbered MAJOR.MINOR.PATCH (the early ones were published as
pre-releases). Narrative release notes for 1.4.0 are in releases/v1.4.0.md; earlier ones are on
the project's Releases page.

## 1.4.0 - 2026-10-06

301 commits since 1.3.0. Full notes: releases/v1.4.0.md

### Added
- In-process DRM: a native backend (libdrm_client.so, via cgo) drives Apple's Android libraries
  through libhybris, with lease recovery inside the engine. Replaces the subprocess/TCP backends.
- ALAC plays in-process through libvlc callbacks, serves while it downloads, and can seek during
  the download.
- Music videos: a segmented CMAF video path (the default), fragment-level seeking with an FFmpeg
  fallback, a seekable decrypted-track cache with a fragment index, and a seek cache with
  pre-buffering.
- Export scheduling: a priority queue, an AIMD throttle so exports yield to playback, reuse of
  playback bytes, private sessions, and a configurable throttle floor.
- Discord Rich Presence, Last.fm and ListenBrainz scrobbling, and a mini player.
- Album-art palette theming, an Accented Blur mode and a blurred artwork backdrop.
- MPRIS2 repeat/loop status, a live AAC position, and the remaining standards gaps.
- Optional AML_WIDEVINE_DIR for supplying a Widevine device identity (the built-in default still
  works), AML_DEBUG=1 and AML_DEVTOOLS, and an opt-in AML_MV_PROGRESSIVE=1.
- The installer puts the apple-music-linux command in ~/.local/bin (the XDG location).
- Opt-in live checks of the real playback pipeline (engine/cmd/playback_live_test.go and
  itun_live_test.go), and drm/android-libs.txt listing the Android runtime exactly.

### Changed
- The Android runtime shrank from 99 libraries (116 MiB) to the 25 it needs (65 MiB):
  libandroid.so and libOpenSLES.so, which Apple's libraries list but import nothing from, are
  empty stubs built from drm/stubs/empty_stub.c.
- libdrm_client.so went from 64 MB to 1 MB: the unused embedding of the Android libraries was
  removed (only libhybris-core.so is embedded). Installer about 112 MB, AppImage about 160 MB
  (1.3.0: 122 MB and 181 MB).
- The installer and npm run dist rebuild every component and verify the package against the fresh
  build; esbuild is a declared dependency. The Android runtime and hybris-linker/q.so are tracked
  with Git LFS. The installer is now named apple-music-linux.run, without the version.
- Debug output (renderer log forwarding, a log file, verbose logging) is on whenever the app is
  started from a terminal; a DevTools window needs AML_DEVTOOLS.
- Faster starts: the track being started downloads first, no idle DRM reconnects, the default key
  context is opened at startup, music-video playlists open in parallel, the segment lookahead is
  fixed and playback waits for a 3 s buffer, and the power-profile and library-token updates are
  event-driven.
- The lossless toggle now really disables lossless; the quality dropdowns need a DRM sign-in.

### Fixed
- Music-video stalls and desyncs: fragments streaming past their end, dead-pipe and code=3
  recovery, A/V drift after long pauses, and audio restarting late after a seek.
- Races, leaks and unbounded reads found by two audit passes and by fuzzing; panics on malformed
  CBCS, MP4 and playlist data now return errors.
- Track switching during ALAC/VLC playback, library song IDs, lazy-queue jumps and station batches.

### Security
- The engine rejects non-loopback Host headers and cross-site requests, and verifies the DRM
  client's TLS server names (optional SPKI pinning).
- The Electron app validates IPC senders and arguments, applies a permission policy and a
  navigation guard, and accepts only identifier keys and primitive values from page settings writes.

### Removed
- The subprocess and TCP DRM backends, the AML_EMBED_LIBS embedding mode, and the "Enable debug
  mode" setting.

### Known issues
- Music-video progressive (itun) streams are not used: Apple's response carries no sinf for them,
  so they cannot be decrypted. Music videos stay on HLS.
- Music videos can stall when the link is near or below the stream's bitrate; there is no adaptive
  quality yet.

## 1.3.0 - 2026-08-11

Music videos, downloads, the theme engine and the AAC streaming path.

### Added
- Music videos: a configurable maximum height (480p, 720p, 1080p, 2160p) sent as mvMaxHeight,
  H.264-preferred variant selection (HEVC software decode fails on most Linux/Electron setups),
  a quality menu that lists only the heights the stream really offers, a separately sized and
  independently switchable video segment cache (default 2 GiB), a decrypted-track cache that skips
  the DRM and FFmpeg pipeline on replay, seeking via ?t=, a subtitle overlay for EIA-608/WebVTT
  cues, full-overlay fullscreen, and music-video download that muxes separate video and audio
  temp files with FFmpeg instead of holding the video in memory.
- Downloads and export: playlist and album downloads that expand into per-track jobs, live
  download progress, stable queue order, metadata hints so rows show artwork and names at once,
  post-processing pipelined behind the next download, new filename template variables ({quality},
  {tag}, {release_date}, {isrc}, {id}, {url_artist}), content-rating and Apple Digital Master
  markers, FLAC conversion that embeds cover art, a native download-folder picker, and byte-range
  HLS support (fixes AAC downloads from byte-range playlists). The default output directory is
  ~/Music/AML-Downloads.
- Theme engine: blur (glass), accent (system or custom palette) and custom CSS modes; system
  accent detection on KDE, Hyprland and GNOME; automatic palette generation for dark and light
  appearance; saved, exported and imported user presets; custom CSS injection that persists;
  separate sidebar and background blur sliders; and an "Apple Music Pink" builtin preset.
- A redesigned audio quality badge (Lossless icon, green, "HI-RES" above 48 kHz or 16-bit, a
  detail popup, and a badge on the Now Playing overlay).
- Compositor and blur backends: KDE X11 native blur, KDE Wayland and Hyprland wallpaper blur, a
  reworked software blur, and a software-blur fallback when the GPU process crashes.
- System tray controls and global media keys (play/pause, next, previous, stop), and MPRIS Shuffle.
- Engine API: GET /api/v1/tools, GET/PUT/DELETE /api/v1/cache/mv, selective cache clearing, a
  fonts route so the webview can load SF Pro, and album IDs in GET /api/v1/metadata.

### Changed
- AAC tracks stream straight into a MediaSource/SourceBuffer pipeline instead of libvlc (ALAC and
  lossless stay on VLC): seeks work end to end, backward seeks replay from a chunk cache, and a
  manual pause can no longer be overridden by MusicKit.
- VLC: volume persists across seeks and loads, the WirePlumber mute race is handled, in-place
  seeking (SetTime), a buffering indicator during seeks, accurate seek positions, a flush of
  buffered audio before each seek reload, and karaoke lyrics that stay in sync while paused.
- Settings panel: a floating close button, "Saved" feedback on every write, an inline preset name
  field in place of the blocked prompt(), and separate Clear Songs and Clear Pre-warm buttons.
- In-playlist track clicks use a dual-trigger state machine and skipToNextItem().
- Battery-aware power budget: debounce, wait and poll intervals scale across AC, battery above
  25% and battery at 25% or below.
- Many UI polish changes: search bar and suggestions, scrollbars, library headers and filter tabs,
  player-bar clearance, and the sidebar.

### Fixed
- Eight Go engine races: concurrent crash handlers emitting false failures, a start-up
  time-of-check/time-of-use race, an inconsistent DRM snapshot, unsynchronised cache size
  fields, mid-eviction file deletes, an unguarded VLC session ID, and a session stored before
  its context.
- VA-API disabled to avoid a Chrome 138 Linux regression that broke music-video playback
  (CHUNK_DEMUXER_ERROR_APPEND_FAILED).
- Window title locked, window show timing and fallback corrected, and X11 BadWindow errors
  suppressed so the x11 package cannot crash the process.
- Download templates reverting on reopen, dropdown highlight comparisons, a listener leak, and
  stale poll results overwriting newer ones.
- The CBCS clear-leader init segment and the seek bar thumb, the MusicKit loading blink, and
  other music-video issues.

## 1.2.0-pre - 2026-07-23

### Added
- A dedicated MSE playback path for AAC (ALAC and Atmos stay on VLC), with a faster stream start
  through the engine's HLS fetcher.
- Back and Forward navigation buttons in the sidebar header with accurate history tracking.
- Theme and accent colour system: a live accent picker, five tunable palette keys (background,
  accent, sidebar, border, active item), Dark, Light, Blur and System-accent modes, an Apple
  Music Pink builtin preset, and saving, exporting and importing presets.
- Custom CSS: browse and import a .css file, injected over all other styles and reloaded on
  reimport, with aml-custom.example.css as a template.
- Cache management: separate Clear Songs and Clear Pre-warm buttons and
  DELETE /api/v1/cache/playback?what=persistent|prewarm.

### Fixed
- AAC seeks: the position now snaps to the real seek target, the seek buffer fills from the
  requested position, and volume is restored after switching from a VLC track to AAC.
- VLC volume and mute: an infinite volumechange loop, and the mute state now round-trips through
  MusicKit's audio element.
- Saving a preset (window.prompt() is disabled in Electron; replaced with an inline field).
- The footer and the "Also available in the iTunes Store" button are hidden site-wide.

### Known issues
- Clicking a track's play button inside an open playlist did not switch to it immediately.

## 1.1.0-pre - 2026-07-21

### Added
- A per-track decrypted audio disk cache (later plays need no re-decryption or re-fetch), with
  GET /api/v1/cache/stats, DELETE /api/v1/cache/playback and PUT /api/v1/cache/config.
- VLC routes in the engine (/api/v1/vlc/queue, load, pause, resume, time, seek, volume), which
  returned 404 in 1.0.0, and a bundled VLC so no system VLC is needed.
- Animated spinners in the DRM status panel during starting and unknown states.

### Fixed
- DRM first launch: the CANNOT LINK EXECUTABLE failure (a no-op libnetd_client.so stub satisfies
  libandroid_runtime.so's dependency), DNS inside the chroot (a resolv.conf with public servers
  before entering it), and the half-logged-in state that needed two sign-ins: the DRM credential
  challenge now opens the sign-in form automatically.

### Changed
- wrapper/ was renamed to drm/, and .gitignore now excludes the DRM session files.

### Known issues
- On a completely fresh install, DRM provisioning takes about 30 seconds on first launch; the
  status shows spinners and turns green automatically.

## 1.0.0-pre - 2026-07-19

First pre-release: a standalone x86-64 AppImage.

### Added
- VLC-based audio playback (lossless and hi-res through libvlc in-process).
- Two-way MPRIS2 support, including bidirectional seek.
- A frosted-glass UI with a single-pass backdrop-filter.
- Automatic engine status polling in settings, and an Apple Music tray icon.
