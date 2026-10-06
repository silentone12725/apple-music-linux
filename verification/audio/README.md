# Audio, mixer and responsiveness repair — 1.4.1

All local authentication, startup, keyboard, audio and responsiveness fixes are consolidated into the proposed 1.4.1 patch. Intermediate local builds identified as 1.4.2 in the authentication report are historical validation steps, not another upstream release.

## Root causes and changes

- Each VLC play reapplied a captured volume, forced unmute, then ran three `pactl` commands eight times. The renderer also reposted a stale per-track slider value after each load. Remove those overrides; expose live VLC volume/mute to synchronize the renderer. Set stable LibVLC application metadata so the mixer shows Apple Music Linux rather than VLC.
- Live programmatic queue/play entered loading without any track-change event or native session load. A delayed state-event fallback starts only a settled item whose ID the engine has not already handled; ordinary track-change events take precedence.
- Premature EOF recovery sent SetTime to an ended player. SetTime only runs once the player is already playing/paused; it never restarts an ended source. Reload the source at startMs, ignore a retry after a skip, handle VLC errors and bound status requests while continuing to poll through temporary outages.
- Cache downloads used independent 10–15-minute contexts. Bind them to the server lifetime and cancel that lifetime before joining VLC input threads. Protect requests racing with a closed VLC player. Terminate SSE streams on server cancellation so HTTP shutdown does not wait for an open renderer connection. Bound Chromium cookie flushing before the final app exit, allowing up to three seconds for normal engine teardown.
- Default Chromium prefers-reduced-motion reduces decorative artwork animation; users may disable the Display preference and restart to restore it. The full-screen artwork filter ignored the saved background blur and forced 80px. Honor the saved blur; active playback already warms its queue, so skip an unrelated ten-track startup warm and limit idle startup warming to three tracks.

## Measured checks

- `AML_TEST_PULSE=1 go test ./core/vlc -run TestSystemMixer -count=1`: before the change the real owned mixer stream's mute was overwritten; after the change volume 37% and mute remained across source replacement and the isolated stream name matched its test metadata. The test uses silent synthetic WAV data, a separate test application identity (so desktop restore settings cannot affect the real app) and targets only its own PID. The installed app name is checked separately.
- `AML_TEST_PULSE=1 go test -race ./core/vlc ./cmd`: passed, including callback read cancellation, media replacement, mixer persistence and closed-player request safety.
- `go test ./...`: passed with the bundled VLC plugins/libraries available.
- Renderer recovery tests cover mid-track EOF, delayed recovery after a skip, normal end, failed reload, missing track-change events and stale polling replies. Node checks: 74 passed, 3 checks skipped, no failures.
- Real Electron authentication smoke exercises popup ownership, Enter focus, sign-in and 2FA submission. Quit smoke passes both ordinary cookie flushing and a cookie flush promise that never resolves, with storage/engine cleanup preceding exit.
- A real licensed ALAC track was sought to 60 seconds and the native player deliberately stopped. The renderer reloaded it at the last observed position, preserved volume 37% and unmuted state, and playback continued beyond 179 seconds. This tests a controlled mid-track stop, not every natural network failure.
- Final installed build `e3d2eca` passed real ALAC stop/reload at about 89 seconds with externally selected mixer volume 37%; position advanced after recovery. A two-track queue then skipped to the next item and the real native stream retained 37% unmuted. PulseAudio named it Apple Music Linux. Settings showed Signed in/Sign Out and Reduce animations. No temporary renderer globals or account submissions were used.
- Explicit installed-app quit finished in 0.4 seconds and the engine exited with code 0, without SIGKILL. Fatal startup/playback markers were zero.
- The SSE shutdown regression failed before cancellation was added and passed after it.
- Initial installed-build sample: eight seconds on the visible Apple Music home page, 29.125% of one CPU core across app processes, 1183.8 MiB aggregate RSS (shared pages counted per process), renderer task time 0.165s and JavaScript 0.028s. This is one local sample, not a benchmark or proof of sustained improvement. A later paused-page sample measured 44.875% CPU and 1151.9 MiB aggregate RSS, with layout work dominating. The final installed paused-page sample measured 27.375% CPU, 1274.7 MiB aggregate RSS and no layout time. These samples do not establish sustained CPU improvement or memory reduction; Electron/web resource cost remains.

Live long-session playback and naturally occurring network/lease interruptions still need qualification. Synthetic recovery tests establish corrected control flow, not successful recovery from every Apple/CDN failure. The host also runs Unity and Rider, so end-to-end resource comparisons must be interpreted accordingly. No account secrets or raw private profiling logs are committed.

LibVLC identity uses the upstream [application metadata API](https://github.com/videolan/vlc/blob/master/include/vlc/libvlc.h).

Motion preference uses Chromium's [reduced-motion switch](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/gfx/switches.cc).

## Follow-up transport repair

The first patch was insufficient for the reported play/pause/skip failures. A real next-then-previous sequence left the second song playing because `_amlGoto` dropped the previous request while busy. MusicKit exposed only AUTOPLAY/REPEAT/SHUFFLE actions with a native session: the actual Play button remained disabled after pause and skip slots could be empty. The previous missing-event fallback started audio without the queue bookkeeping. Replacing a queue could also retain the old VLC audio proxy, leaving the SDK unable to prepare the new item.

The native session now owns three controls in the existing MusicKit transport slots. Their play/pause commands run in order; UI observations and SDK retries do not send new native commands. Queue changes share the detach sequence, navigation retains rapid requests and computes targets from the requested cursor, and fallback uses the full queue/track handler. Selecting the same track restarts its source directly; the first previous button restarts instead of being disabled. The adapter restores web controls when leaving native playback.

- Node suite: 83 passed, 2 intentionally runtime-only checks skipped. Transport regressions cover command ordering, duplicate suppression, stale track/restart commands, rapid next/previous, rejected navigation and a never-settling SDK promise.
- `electron verification/audio/transport-ui-smoke.mjs`: passed in actual Chromium with a disabled native Play button and empty skip slots, including single command dispatch, slot replacement/remount and restoration of web controls.
- Real licensed ALAC queue: six consecutive cycles through the actual transport Play/Pause buttons passed with native and UI state agreeing. Pause/resume observations took 2–20 ms in this cached local sample; these are observed API/UI checks, not general audio latency guarantees.
- Actual Next/Previous buttons passed, including next immediately followed by previous (final item correctly first), then normal next/previous. The cached samples completed in about 0.65–0.91 seconds. Seek to 20 seconds and first-track restart passed; system mixer volume remained 37% throughout. Startup/runtime fatal markers were zero.

These checks use an authenticated local profile and cached licensed tracks. Cold downloads, other codecs/video/radio variants and long network interruption sessions remain qualification gaps.

The Stop → Play check also exposed retained seek-recovery state: after seeking to 20 seconds and restarting at zero, the old recovery window treated zero as a failed seek and reloaded 20 seconds. Stop, restart and queue replacement now clear the seek window and invalidate delayed seek responses. A regression covers this stale-target rewind. Explicit Stop stops polling before stopping VLC, preserves the session/queue, and Play reloads the source at zero. The real stop/restart check passed, returning to approximately 250 ms with volume 37% and matching UI/native playing state.

Final installer build `b2539d0` (1.4.1) was installed with a private authenticated-profile backup. External renderer bytes matched the checkout. The complete real transport sequence passed again on this installed package, including Stop → Play at approximately 250 ms with volume 37%. Explicit quit took 0.4 seconds, the engine exited with code 0, and no fatal playback markers occurred. The normal relaunch restored logged-in/ready/valid DRM state without credential submission and without a debugging port.

## Follow-up natural EOF / repeated tail repair

A real ALAC track reported 212310 ms but ended with the last observed position 208948 ms. The old three-second cutoff classified that 3362 ms difference as premature EOF and issued a new native load at 208948 ms. The near-tail regression failed on the original code. Repeated source reloads at EOF explained the user's repeated ending before advancement.

Natural EOF (including a stopped state observed after EOF) now has a final-window tolerance up to ten seconds, capped to 10% of the track duration. Explicit VLC errors keep the stricter three-second recovery threshold. Earlier EOF still reloads at the last position, and recovery no longer snaps the visible position to the duration. The tolerance is a classification policy for duration/poll differences, not a claim that all media uses ten-second fragments.

Node checks: 87 passed, 2 runtime-only checks skipped. Regressions cover natural EOF with 3.5/5/7.5/10 seconds remaining, true errors near the end, EOF outside the window and proportionally smaller tolerance for short tracks. Existing mid-track recovery and transport checks also pass.

With the corrected renderer, the same real two-track ALAC queue was sought to 195 seconds and allowed to reach natural EOF. The final observed position was again 208948 ms; the next track entered native/UI playing state roughly 0.68 seconds after the observed end. Recorded native source loads were exactly `[0, 0]` (first track, next track), with no near-tail reload. The log recorded one auto-advance, zero false-end recoveries and zero fatal markers. This is a real decoder EOF check, not a simulated stop.

The final 1.4.1 installer (`a512311`) was installed and its external renderer bytes matched the checkout. Repeating the natural EOF check on the installed package again produced exactly two zero-position source loads, one advance and zero false-end/fatal markers. The diagnostic instance was closed and the app reopened normally with the existing configuration.
