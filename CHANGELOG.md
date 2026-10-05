# Changelog

All notable changes to Apple Music Linux. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases are numbered `MAJOR.MINOR.PATCH`. The narrative release notes for each version are
in [`releases/`](releases/) and on the
[Releases page](https://github.com/silentone12725/apple-music-linux/releases).

## [1.4.0] - 2026-10-06

301 commits since 1.3.0. Full notes: [releases/v1.4.0.md](releases/v1.4.0.md).

### Added
- In-process DRM: a native backend (`libdrm_client.so`, via cgo) drives Apple's Android libraries
  through libhybris, with lease recovery inside the engine. Replaces the subprocess/TCP backends.
- ALAC plays in-process through libvlc callbacks, serves while it downloads, and can seek during
  the download.
- Music videos: segmented CMAF video path (the default), fragment-level seeking with an FFmpeg
  fallback, a seekable decrypted-track cache with a fragment index, and a seek cache with
  pre-buffering.
- Export scheduling: a priority queue, an AIMD throttle so exports yield to playback, reuse of
  playback bytes, private sessions, and a configurable throttle floor.
- Discord Rich Presence, Last.fm and ListenBrainz scrobbling, and a mini player.
- Album-art palette theming, an Accented Blur mode and a blurred artwork backdrop.
- MPRIS2 repeat/loop status, a live AAC position, and the remaining standards gaps.
- Optional `AML_WIDEVINE_DIR` for supplying a Widevine device identity (the built-in default still
  works), `AML_DEBUG=1` and `AML_DEVTOOLS`, and an opt-in `AML_MV_PROGRESSIVE=1`.
- The installer puts the `apple-music-linux` command in `~/.local/bin` (XDG).
- Opt-in live checks of the real playback pipeline (`engine/cmd/playback_live_test.go`,
  `itun_live_test.go`), and `drm/android-libs.txt` listing the Android runtime exactly.

### Changed
- The Android runtime shrank from 99 libraries (116 MiB) to the 25 it needs (65 MiB):
  `libandroid.so` and `libOpenSLES.so`, which Apple's libraries list but import nothing from, are
  empty stubs built from `drm/stubs/empty_stub.c`.
- `libdrm_client.so` went from 64 MB to 1 MB: the unused embedding of the Android libraries was
  removed (only `libhybris-core.so` is embedded). Installer 112 MB, AppImage 160 MB
  (1.3.0: 122 MB and 181 MB).
- The installer and `npm run dist` rebuild every component and verify the package against the fresh
  build; `esbuild` is a declared dependency. The Android runtime and `hybris-linker/q.so` are
  tracked with Git LFS.
- Debug output (renderer log forwarding, a log file, verbose logging) is on whenever the app is
  started from a terminal; a DevTools window needs `AML_DEVTOOLS`.
- Faster starts: the track being started downloads first, no idle DRM reconnects, the default key
  context is opened at startup, music-video playlists open in parallel, the segment lookahead is
  fixed and playback waits for a 3 s buffer, and the power-profile and library-token updates are
  event-driven.
- The lossless toggle now really disables lossless; the quality dropdowns need a DRM sign-in.

### Fixed
- Music-video stalls and desyncs: fragments streaming past their end, dead-pipe and `code=3`
  recovery, A/V drift after long pauses, and audio restarting late after a seek.
- Races, leaks and unbounded reads found by two audit passes and by fuzzing; panics on malformed
  CBCS, MP4 and playlist data now return errors.
- Track switching during ALAC/VLC playback, library song IDs, lazy-queue jumps and station batches.

### Security
- The engine rejects non-loopback `Host` headers and cross-site requests, and verifies the DRM
  client's TLS server names (optional SPKI pinning).
- The Electron app validates IPC senders and arguments, applies a permission policy and a
  navigation guard, and accepts only identifier keys and primitive values from page settings writes.

### Removed
- The subprocess and TCP DRM backends, the `AML_EMBED_LIBS` embedding mode, and the "Enable debug
  mode" setting.

### Known issues
- Music-video progressive (itun) streams are not used: Apple's response carries no `sinf` for them,
  so they cannot be decrypted. Music videos stay on HLS.
- Music videos can stall when the link is near or below the stream's bitrate; there is no adaptive
  quality yet.

[1.4.0]: https://github.com/silentone12725/apple-music-linux/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/silentone12725/apple-music-linux/releases/tag/v1.3.0
[1.2.0-pre]: https://github.com/silentone12725/apple-music-linux/releases/tag/v1.2.0-pre
[1.1.0-pre]: https://github.com/silentone12725/apple-music-linux/releases/tag/v1.1.0-pre
[1.0.0-pre]: https://github.com/silentone12725/apple-music-linux/releases/tag/v1.0.0-pre
