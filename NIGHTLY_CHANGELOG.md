# Nightly changelog

Unreleased changes, one entry per nightly build, newest first. Each entry is also posted on its own in the nightly channel on Discord, separate from the download announcement. Add the new entry at the top before publishing a nightly.

# Nightly: unreleased changes (2026-11-11b)

### Speed
- **The window opens sooner.** The engine starts before the window is created, so the page and the engine come up together.
- **Windows first launch is no longer a minute of nothing.** The VLC plugin cache ships with the installer, so libvlc does not scan every plugin on the first start.
- **Sidebar clicks made while the page is still starting no longer reload Home or need a second click.** They are held until the player is ready and then replayed.
- Cheaper page styling: exact class selectors instead of `[class*=]` scans, which cost layout time on every page change.

### Loading feedback
- **A small spinner on the item you clicked, and a placeholder (skeleton) over the content** while the next page loads. Nothing shows for waits under a quarter of a second.
- The skeleton copies each page's real layout: Search, Home, New, library grids, songs, Artists, Music Videos, and playlists and albums. It fills the window and follows it when you resize.
- It has no background of its own, so every theme (palette, blurred wallpaper, compositor or acrylic blur) shows through.

### Memory
- **Idle page reload.** Apple's page keeps every page you leave in memory (about 300 MB per pass over the sidebar). When the window is hidden or unfocused for a while, nothing is playing and the page is far above its normal size, it reloads itself; the Resume chip waits for you.
- The engine restarts straight away after a reload and backs off after real crashes; music-video path caches are capped.

### Resume playback
- **Fixed resume stopping after 30 to 60 seconds.** Seeking into a track that was still downloading used the wrong path and cut the track short. Resume now seeks inside the buffer once the download has reached the position.
- The Resume chip is a blurred glass card with a neutral play button, no red.

### Themes
- **New Blue preset** (the blue Apple's web UI now uses, `#5ac8f5`).
- Apple's own blue (sidebar icons and tinted controls) follows the theme: the Apple Music preset uses the app icon's pink, so the page is consistent again.

### Windows
- **Sign-in crash fixed.** The loader's TLS rewriter now finds the ELF header correctly, which is what crashed the Apple sign-in on Windows. Not yet verified with a real account.

---

# Nightly: unreleased changes (2026-11-11)

### Windows lossless
- **Fixed the crash when lossless started.** Apple's FairPlay code uses very large stack frames, which Windows did not have ready, so the engine died as soon as FairPlay initialised. Each thread's stack is now prepared first. In testing on Windows 11 the engine signs in to FairPlay, decrypts a full ALAC track and plays and seeks it through VLC.
- The same fix covers the lease-recovery thread and threads the Apple libraries start themselves.
- Keys are no longer refused on a normal streaming subscription.
- The installer packs the runtime DLLs the DRM layer needs, and Apple's FairPlay libraries are downloaded by the app on first launch (no manual copying).

### Lossless (Linux and Windows)
- **The real format is shown.** Sessions report the sample rate and bit depth Apple's playlist states (for example 48 kHz / 24-bit) instead of a fixed 44.1 kHz / 16-bit.
- **Hi-Res off stays at 48 kHz or below** when a track offers both; Hi-Res on plays the highest (up to 192 kHz).
- The badge says Hi-Res only above 48 kHz, as Apple does.

### Sign-in
- "Can't get to your devices?" now offers the text / call options.
- Sign-in says why it failed, limits repeated attempts, treats Cancel as a cancel, and renews an expired session silently.

### Playback and export
- Non-US storefronts no longer get 30-second previews.
- Exports can go to the folder chosen in Settings on any drive, with valid Windows file names.

---

# Nightly: unreleased changes (2026-11-01)

### Playback
- **Track durations match the real stream.** When a stream's own playlist length differs from the catalog length by more than a second, the engine reports the stream's, so progress, fades and gapless timing line up. Lossless files carry the same length.
- **No more replayed track endings.** The engine tells VLC reaching the real end of a file from a failed read (`eof` on `/vlc/time`); a clean short end advances instead of reloading and replaying the last seconds.
- **Long pauses resume.** Open sessions are kept alive (`POST /api/v1/playback/{id}/touch`), and a session the engine no longer knows is reopened at the saved position on Play.
- **Missing track-change events are recovered**: a track MusicKit leaves loading without announcing now starts after 300 ms.
- **Music-video crackle fixed.** Audio/video drift is closed by running the video 4-6% faster or slower instead of seeking the audio about twice a second.

### Music videos
- **A refused video licence falls back to the next lower tier** (H.264 preferred) instead of failing the video. Apple refuses the 4K keys to this client; the refusal is remembered per video for an hour.
- **Quality is logged clearly**: `[mv-quality]` lines show what was requested, what each tier allows (HDCP-LEVEL, ALLOWED-CPC key systems) and what plays.
- **An opt-in live check for 4K music videos** (`engine/core/e2e/mv_4k_integration_test.go`, skipped without `AM_TEST_TOKEN` and `AM_TEST_MUT`) opens videos whose master playlists offer 4K-class heights with a 2160 ceiling, logs the heights offered and the chosen variant's codec, streams the first 6 MB and checks that it decrypts to real fMP4 video. It reports whether the key request is accepted, and writes the results to `verification/mv-4k/`.

### DRM
- The music token request is built with cJSON, so long tokens are no longer truncated at 512 bytes; the subscription status read is bounds-checked; a failed FairPlay init releases its lock instead of hanging. Adapted from silentone12725/apple-music-linux#1.
