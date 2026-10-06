# Changelog

All notable changes to Apple Music Linux, from the first release. The format follows Keep a
Changelog, and releases are numbered MAJOR.MINOR.PATCH (the early ones were published as
pre-releases). Narrative release notes for 1.4.0 are in releases/v1.4.0.md; earlier ones are on
the project's Releases page.

## 1.4.0 - 2026-10-06

A major release: 304 commits across 689 files since 1.3.0. Grouped by area because of its
size; the same list is in releases/v1.4.0.md.

### DRM and key handling
- **DRM moved in-process.** The subprocess and TCP backends (ProcessBackend, drm-rootless, the TCP sockets) were removed in stages: first a hybris-backed backend, then an in-process cgo backend, then a clean-room native backend (libdrm_client.so) that drives Apple's Android libraries through libhybris. FairPlay keys are derived through a vendored host-native wrapper (lease management and recovery, key contexts, an exception barrier so a C++ exception cannot abort the engine). Packaged builds ship the in-process DRM.
- **Lease recovery** runs inside the engine: decrypts queue during recovery instead of failing, the RUNNING-to-idle state transition is fixed, DRM start is serialised, a nil DRM manager is guarded, logout is fixed, the 2FA reply race and the authentication wait are bounded, and session values are trimmed.
- **The DRM client** (HTTPS with HTTP/2 option, cookie jar, JWT parsing, device GUID persistence, license fetch, skd:// to HTTPS conversion for license requests, system CA certificates, FairPlay license parsing) was rebuilt and audited: 22 findings fixed, an RFC 6265 cookie jar, HTTP/1.1 framing and size caps, timeouts, redirect and retry rules, TLS server-name verification, optional SPKI pinning (AML_TLS_PINS), and hi-res availability that follows a switch (AML_DISABLE_HIRES) instead of being hard-coded.
- **Android runtime.** The stripped ICU libraries load under hybris (the __register_atfork import is retargeted), the libdl.so shim is tracked, the DRM library builds against the in-tree libhybris-core.so, and the runtime shrank from 99 libraries (116 MiB) to the 25 in drm/android-libs.txt (65 MiB): libandroid.so and libOpenSLES.so are empty stubs because Apple's libraries import nothing from them. The unused embedding of those libraries inside libdrm_client.so was removed (64 MB to 1 MB).
- **Content keys.** A content-key cache, format fields, session reuse and audio analysis were ported from Android Apple Music 6.5.2; cached keys survive a cancelled stream; in-process ALAC decryption survives key switches and reconnects; malformed CBCS fragments return errors instead of panicking; the FairPlay license pool is pre-warmed at startup; Widevine license parameters are carried by a typed context key; and a Widevine device identity can be supplied with AML_WIDEVINE_DIR (the built-in default still works).
- **Itun (progressive music-video) groundwork**: the offline decryption pipeline and proactive URL refresh were added, and the engine now requests the real progressive URL through the vendored wrapper (opt-in with AML_MV_PROGRESSIVE=1 while it is evaluated).

### Lossless and AAC playback
- **ALAC plays in-process through libvlc callbacks**: libvlc reads from the disk cache or the in-progress download, with no loopback HTTP and no subprocess. A first play serves while it downloads (the Android RandomAccessFile model), and seeking works during the download through Range-from-writer. A cache-commit race and an engine crash after VLC passthrough teardown were fixed.
- **Faster starts.** The track being started downloads first (other downloads and the next track's pre-warm wait for its first 3 MiB, instead of splitting the CDN link); idle streams no longer trigger a DRM reconnect; the default key context is opened at startup; and the power-profile and library-token updates are event-driven instead of polled.
- **AAC**: cache misses stream while downloading instead of waiting for the full file, the MSE buffer window is capped (240 s / 120 s, was 900 s), and an AAC time-to-first-byte benchmark was added.
- **Quality settings**: the lossless toggle really disables lossless, and the lossless and music-video quality dropdowns stay disabled until you are signed in.
- **Library**: a JS-driven sync into an encrypted SQLite store that persists across restarts, auto-sync as soon as web sign-in completes (no DRM needed), a local cache by default for library tracks, and hardened key handling and server limits.
- **Queue and navigation**: a session history queue with sliding-window navigation, error dialogs suppressed during transitions, external play buttons that switch tracks during ALAC/VLC playback, library song IDs (a.DIGITS), lazy-queue and inter-playlist jumps, station batches synced into the queue (including queueItemsDidChange), a queue cascade on a null nowPlayingItemDidChange prevented, VLC track-click navigation, IPv4 forcing, and a stale singleflight cleanup no longer deleting a live session.
- **Prefetch** yields to active playback and uses Apple's fade and retry policy; the engine periodically returns idle heap to the OS.
- **Mode handoff**: switching from lossless to AAC or a music video stops libvlc and waits for the engine to confirm before the next track starts (releasing the engine session did not stop it, so the old track kept playing underneath). The stop is awaited with a timeout, also in the MusicKit handoff, and the rules are unit-tested.
- **MSE diagnostics**: an AAC MediaSource failure now logs the audio element's error code and message, and anything that detaches the stream logs its caller.

### Music videos
- **Segmented CMAF video ("vseg") is the default backend**: HLS segments are decrypted and re-fragmented through FFmpeg and streamed into MSE as fragments become ready. It replaced a series of experiments this cycle: an mp4box.js MSE path, a native video element over localhost HTTPS with a faststart cache and a growing-file index, a progressive pipeline, and a WebCodecs path (an engine demux endpoint, a full pipeline, then demoted to a shadow path). HLS CBCS decryption is always used for video; the iTunes FairPlay CDN path was removed.
- **Seeking**: seeks go through the HLS segment table; a fragment-level path fetches and decrypts only the fragment holding the target (about 1.4 s against 2.8 s for a whole segment on the real CDN) with an automatic FFmpeg fallback; the from-0 download is parked while a seek producer works, because CDN bandwidth is shared; and a seekable decrypted-track cache with a fragment index, a seek cache with pre-buffering, a freeze-frame overlay during a seek past the buffer, and audio that restarts as soon as the video plays after a seek were added.
- **Startup**: segment 0 streams directly while the rest prefetch in parallel; audio and video playlists open concurrently; the segment lookahead was fixed (a bandwidth estimate taken from the 1.4 KB init segment had clamped prefetch to one connection, leaving the link idle about a second at every segment boundary); fragment-aligned flush coalescing; and playback waits for a 3 s buffer before starting.
- **Stability**: fragments no longer stream past their end into the next moof; recovery from dead pipes, code=3 decode errors (ExoPlayer-style: in place first, then skip past), and starvation deadlocks; a re-entrancy guard on Chrome's seeking events; A/V desync and the seek bar after long pauses; MPRIS resume; duplicate listeners; play/pause mirroring between audio and video; the MSE buffer bounded without dropping chunks; the vseg cache file kept open after the producer commits; and polling instead of blocking when the fragment indexer lags.
- **Smaller fixes**: MV ids registered so play buttons work on search rows, banner navigation separated from play-button playback, MV navigation links skipped by the interceptor, audio stopped on exit, and an EC-3 decode crash on first native play.

### Downloads and exports
- A **priority queue** with FIFO ties and race-free cancellation, an **AIMD throttle** so exports yield to playback without stopping, a configurable throttle floor, and a priority endpoint.
- Exports **reuse playback bytes** (the committed cache, then the live tail), use **private sessions** so releasing an export can never delete a playback session, stream to disk, honour cancel, and stop on shutdown; playback streams are classed foreground or background.
- A retry countdown, a manual retry override, a catalog search panel, a Copy Link intercept, library playlists, temp-file isolation and artwork retry in the downloads view.

### Integrations
- **Discord Rich Presence**, **Last.fm** and **ListenBrainz** scrobbling, and a frameless **mini player**.
- **MPRIS2**: repeat/loop status, a live position for AAC, and the remaining standards gaps closed.
- A reliable quit: VLC stops immediately on engine shutdown and the quit time is hard-capped.

### Theme and interface
- **Album-art palette theming** across every major surface, a blurred artwork backdrop built from 600 px artwork, and the theme following the currently playing track on all pages; the area below the content continues the page colour.
- **Footer**: Apple's footer text and divider lines are hidden while its box is kept as the player-bar clearance, painted in the page colour so the theme runs to the bottom edge. The theme selector offers Blur, Accent and Custom CSS.
- **Settings**: frosted-glass dropdowns, backdrop blur and HIG polish, a compact toggle (reverted to plain checkboxes), DRM, tools and prefs pre-loaded so the panel opens instantly, a global accent colour no longer forced on the dialog, and a corrected DRM status indicator.
- Search-row, sidebar-item and detail-header fixes, the "Also available in the iTunes Store" button hidden everywhere, a new app icon with shape variants, and loose project files reorganised.
- VA-API hardware video decode is used where available, with a leaner disk cache and tray show/hide fixed.

### Security and hardening
- The engine rejects cross-site requests (an exact Origin check, with Host checked for DNS rebinding) and accepts request-supplied tool paths only for ffmpeg, vlc and cvlc.
- The Electron app checks IPC senders, applies a permission policy and a navigation guard, validates IPC arguments, and accepts only identifier keys and primitive values from the page's settings writes (view:tweak).
- HTTP clients were hardened and unbounded reads capped; communications, key logging, CORS and permissions were tightened; retained tokens are dropped and the lyrics proxy hardened; playlist and MP4 parsing were fuzzed and fixed; library key handling and server limits were hardened.
- Two audit passes ("security/stability audit fixes", then a proofread of the HLS, pipeline, export, DRM, handlers, apple provider and aacstream packages) fixed races, goroutine and pipe leaks, an FFmpeg source hang, export tail races, MV cache-key collisions, range responses, past-end seek starts, token body caps and nil guards.

### Engine and API
- The engine's apiserver was split into domain handlers, packages were renamed (engine/engine to engine/core, arbitrary names to ones that reflect their function), complexity-reducing helpers were extracted, hot-path allocations and a file-descriptor leak were removed, three hot paths (HLS, AutoEQ, prefetch) were made cheaper, and 2,140 lines of unreachable code were deleted.
- New personalised-feed endpoints (recommendations, heavy rotation, recently played) ship dormant, and a client-side Web Audio EQ is included but unused.
- Debug logging is gated behind AML_DEBUG, fmt output moved to slog, and time-stamp handling no longer changes with AML_DEBUG.

### Build, packaging and tooling
- **A verified build.** The installer script rebuilds the DRM library, the engine, the renderer bundles and the VLC subset on every run, refuses to continue if the Android runtime does not match drm/android-libs.txt, and checks that the packaged engine, DRM libraries and renderer bundles are byte-identical to the fresh build. npm run dist uses the same inputs, esbuild is a declared dependency, and the Android runtime and the hybris linker are tracked with Git LFS. Bundle drift is guarded by a test, and the renderer is built as an esbuild module pipeline with extracted modules.
- **Self-contained packages**: VLC's plugins no longer depend on the build machine's FFmpeg. A prebuilt minimal FFmpeg 9.0.2 (LGPL, third_party/ffmpeg) is bundled, with its own libraries, and the engine uses its binary for music-video remuxing and exports; the few other libraries VLC needs are copied in and checked at build time.
- **Flatpak**: a self-hosted bundle (io.github.silentone12725.AppleMusicLinux) built by scripts/build-flatpak.sh from the same files as the other packages.
- **Smaller packages**: installer about 112 MB and AppImage about 160 MB (1.3.0: 122 MB and 181 MB).
- **Installer**: named apple-music-linux.run (the version is inside, so releases/latest/download links keep working); the apple-music-linux command goes in ~/.local/bin (the XDG location) without editing any shell startup file, and --uninstall removes only what it installed.
- **Debug output follows how you start the app**: from a terminal (or with AML_DEBUG=1) it turns on the renderer log forwarding, a log file and verbose logging. The "Enable debug mode" setting is gone; a DevTools window opens only with AML_DEVTOOLS.
- Opt-in live checks of the real playback pipeline decrypt and decode ALAC, AAC, Atmos and music-video streams (comparable byte for byte between Android runtimes), plus a live check of the itun path.
- Repository cleanup: generated output, one-off reverse-engineering tools, UI captures and stale benchmark reports were removed, a clean script was added, and the go.work follows the engine's Go version.

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
