# WC (WebCodecs) MV path — hardening scope

Goal: make the WebCodecs canvas path good enough to be the **single default** MV
video backend — the only path that structurally cannot hit `code=3`
(CHUNK_DEMUXER) *and* cannot go black on seek (the canvas is our frame buffer).

Three workstreams: **worker paint**, **A/V sync**, **soak harness**. Scoped
against the current spike, not the analysis doc.

---

## 0. Current state (what already exists)

The spike is more complete than the analysis doc implies. Reality:

- `_setupWebCodecsVideo` — [engine-playback.js:3593](electron/src/engine-playback.js:3593).
  Creates a 2D canvas in `mvContainer`, hides the empty MSE `<video>`, runs a
  decode queue + rAF render loop keyed to `mkAudio.currentTime`.
- ES wire format `AME1` → codec → avcC → samples, parsed in `drain()`
  ([:3731](electron/src/engine-playback.js:3731)); backpressure caps decode-ahead
  to ~5s / 60 frames / `QUEUE_MAX=24`.
- Engine `/video-es` — [handlers_playback.go:635](engine/handlers_playback.go:635).
  Three sub-paths: full-play from dec-cache, **indexed seek from dec-cache**
  (`ServeMVDecFrom` + `MVDecIndexExists`, [:672](engine/handlers_playback.go:672)) —
  accurate real-timeline seek, no FFmpeg re-run — and direct
  CBCS→`DemuxFMP4ToES` for uncached.
- Seek: `onWcSeek` → `_commitWcSeek` ([:3810](electron/src/engine-playback.js:3810))
  closes decoder, clears queue, restarts `start(t)`. Skips restart if target is
  inside the queued window.
- Stall/rebuffer choreography: `_wcStalled`, `_wcRebuffering`, 8s hang timeout,
  3× decode-error retry.

**What already works:** first-frame gate, B-frame reorder (VideoDecoder emits in
display order), buffer bar (`_wcBufferedSec`), MK spinner mirroring, indexed
cache seek. Flip is `const _wcVideo = false` → `true`
([:1957](electron/src/engine-playback.js:1957)).

**What's fragile / why it isn't default:**
1. Render loop + `drawImage` run on the **main thread** → judder under load.
2. A/V sync is **hand-rolled and audio-mastered** — the entire stall machinery
   exists to paper over the fact that video can't keep up with the audio clock.
   No drift correction, only underrun pausing.
3. **Zero automated coverage** — no headless `code=3`/decode/soak test. Making it
   default without one is how a regression ships silently.
4. Dead heuristic: `_wcKeyframeEstimate` ([:1970](electron/src/engine-playback.js:1970))
   is declared and read in `onWcSeek`'s `nearKeyframe` branch but never seeded
   from real keyframe positions — it's effectively always 0. Cut or implement.

---

## A. Worker paint (OffscreenCanvas + Worker)

**Problem:** decode output handling, the rAF render loop, and `drawImage` all sit
on the renderer main thread, contending with AM's React UI. Under a busy page or
a slow decode this is where visible judder and dropped frames come from.

**Design:**
- Transfer the canvas to a Worker via `canvas.transferControlToOffscreen()`; the
  Worker owns `getContext('2d')` and the rAF paint loop.
- Move the `fetch(reader)` + `drain()` + `VideoDecoder` into the Worker too —
  `VideoDecoder`, `EncodedVideoChunk`, `fetch`, `ReadableStream` all exist in
  worker scope. Keeps the encoded bytes and `VideoFrame`s off the main thread
  entirely (no `postMessage` of frames → no copies).
- Main thread ↔ Worker messages (small, JSON-ish only):
  - main→worker: `{cmd:'start', esUrl, seekSec}`, `{cmd:'seek', t}`,
    `{cmd:'clock', ct}` (audio time, ~10–20 Hz), `{cmd:'abort'}`.
  - worker→main: `{ev:'firstframe', w, h}`, `{ev:'buffered', sec}`,
    `{ev:'stall'}`, `{ev:'playing'}`, `{ev:'hang'}`.
- Main thread keeps: audio element ownership, the stall→`mkAudio.pause()` action
  (audio can't move to the worker), scrubber, spinner, MPRIS dispatch. Worker
  only *signals* underrun; main acts on it.

**Clock:** the render loop needs `mkAudio.currentTime`. Two options:
- (simple) post `clock` every ~50ms; worker interpolates with
  `performance.now()` between ticks. Good enough for frame selection.
- (better) also post `{playing, rate, baseCt, basePerfNow}` on play/pause/seek so
  the worker runs a local predicted clock and only resyncs on events. Less
  message traffic, smoother. **Recommend this.**

**Files:** new `electron/src/engine/wc-worker.js` (esbuild-bundled like the other
`src/engine/*` modules — see the Sync rule in CLAUDE.md); `_setupWebCodecsVideo`
shrinks to a thin main-side shim that spawns the worker and relays clock/seek.

**Effort:** ~1.5–2 days. **Risk:** medium — worker lifecycle/teardown on track
change + seek races. The existing `aborted()`/`fetchCtrl` discipline maps cleanly
to worker `abort`.

**Exit:** frame pacing holds steady with AM UI busy; no `VideoFrame` crosses
`postMessage`; teardown leaks nothing (frame `.close()` on abort verified).

---

## B. A/V sync hardening

**Problem:** today video is slaved to audio, and the only correction is "queue
empty → pause audio" (`render`, [:3648](electron/src/engine-playback.js:3648)).
There is no drift metric, no soft correction, no rate nudge. On a slow link or a
decode hiccup you get stall→resume pumping instead of smooth catch-up.

**Design (keep audio as master — correct for a music app):**
1. **Drift metric:** each paint, compute `drift = paintedFrame.tUs/1e6 - ct`.
   Track a short rolling median (reuse the pattern; a 10-sample ring is plenty).
2. **Three-zone correction:**
   - `|drift| < ~40ms` (≈1 frame @24fps): do nothing (in sync).
   - `40ms–250ms`: soft — drop or hold one frame in the paint selector
     (already half-done: `render` skips stale frames; add "hold" for the
     ahead case). No audio touch.
   - `> 250ms` sustained: hard — the current stall path (pause audio / or a
     small `mkAudio.currentTime` nudge). This becomes the *rare* path, not the
     routine one.
3. **Underrun vs. drift split:** separate "no frames at all" (underrun → spinner
   + pause, existing) from "frames present but behind/ahead" (drift → silent
   correction). Right now both collapse into the stall.
4. **Seek settle:** after `_commitWcSeek`, suppress drift correction until N
   frames painted post-seek (extend the existing `_wcRebuffering` guard with a
   frame counter, not just the 8s timeout).
5. **Kill or implement `_wcKeyframeEstimate`** — decide during this workstream;
   if implemented, seed it from the ES keyframe flags the decoder already sees.

**Files:** the `render`/`start`/`onWcSeek` cluster (moves into the worker from A —
**do A first** so this is written once in its final home).

**Effort:** ~2–3 days incl. tuning thresholds against real content.
**Risk:** medium-high — this is the genuinely hard part; thresholds need soak
data (workstream C) to tune, so B and C interleave.

**Exit:** on a bandwidth-throttled link, sustained playback shows median
|drift| < 40ms, zero stall-pumping (no >1 stall/resume cycle per genuine
underrun), and seek settles to in-sync within ~1s of first post-seek frame.

---

## C. Soak / regression harness

**Problem:** no automated proof the path is `code=3`-free, decodes real B-frame
content, and survives seek storms. This is the gate that lets us make WC default
with confidence — build it **first** enough to run A and B against it.

**Two layers:**

1. **Engine-side ES validation (Go, cheap, CI-able).** A test that runs
   `DemuxFMP4ToES` over a captured decrypted fMP4 fixture and asserts: valid
   `AME1`/codec/avcC header, monotonic non-negative PTS after CTO handling, first
   sample is a keyframe, sane sample count. Catches wire-format regressions
   without a browser. Lives in `engine/utils/aacstream/*_test.go` (that package
   already owns `DemuxFMP4ToES`).

2. **Headless renderer soak (Electron/Chromium — the real decoder).** A driver
   (`electron/test/wc-soak.mjs`, run under `xvfb-run` like the `run` skill's
   Electron pattern) that:
   - loads the WC module against a **local fixture ES server** (a tiny Go/node
     stub serving a captured `/video-es` byte stream + a throttle knob) so the
     test is deterministic and offline — no DRM, no network;
   - drives: cold start → play 30s → seek storm (10 random seeks) → play to end;
   - asserts via console-log scrape (the path already logs everything):
     `first frame decoded`, no `decode error`/`code=3`, no `hang timeout`,
     `_wcBufferedSec` advances, drift stays bounded (add a `[wc-metric]` log line
     in the render loop for the harness to parse).
   - throttle mode replays the bandwidth-bound case (the black-screen scenario).

**Fixtures:** capture one real decrypted ES stream once
(`curl https://127.0.0.1:20026/.../video-es > fixture.es`), commit a short clip
(a few MB) or keep it out-of-tree and gate the soak test on its presence.

**Effort:** layer 1 ~0.5 day; layer 2 ~1.5–2 days (the fixture server + xvfb
harness is the bulk). **Risk:** low-medium — mostly plumbing.

**Exit:** `go test ./utils/aacstream/...` covers ES validity; `npm run wc-soak`
green (start + seek storm + throttled run, zero code=3/hang, bounded drift).

---

## Sequencing

```
G4 (dead-code prune)     ── DONE first: one source of truth before it's copied into the worker
G1 (codec pre-check)     ── isConfigSupported() guard before configure; prerequisite for a clean fallback
G2 (path selection)      ── try-WC → fall back to native on unsupported/hard-fail; the safety net
C1 (engine ES test)      ── cheap, do immediately, catches wire-format regressions
C2 (fixture + harness)   ── build BEFORE tuning B; it's the measurement rig
A  (worker paint)        ── move render/decode into worker (final home for B's code)
B  (A/V sync)            ── written once, in the worker; tuned against C2's throttle mode
flip WC default          ── only after C green on real content AND G1+G2 give a real fallback
```

Do **G4 → G1 → G2 → C2 → A → B**, with C1 upfront. B and C2 interleave (B needs
C2's numbers). G1+G2 come before A because the thing being hardened must be able
to **degrade instead of blacking out** before it's worth moving into a worker; G4
comes first so the dead/duplicate WC code isn't ported twice.

**Total: ~6–8 focused days.** Biggest risk is B (sync thresholds); C2 de-risks it
by making the behavior measurable instead of eyeballed.

## What this explicitly does NOT fix

Seek **latency** on an uncached beyond-buffer target is bandwidth (~8MB 1080p
segment, ~15s). WC makes that wait show the **last frame** instead of black, but
does not shorten it. Faster seek needs the indexed dec-cache (already exists for
replays) or a persistent decoded-segment buffer — a later, separate effort.

## Gaps found (audit) — not in the original three workstreams

Ranked by what would bite when WC becomes default. These are additive to A/B/C.

**1. No codec pre-check, no decode fallback (HIGH — blocks default).**
`myDec.configure(...)` ([:3745](electron/src/engine-playback.js:3745)) has **no**
`VideoDecoder.isConfigSupported()` guard. On HEVC / Dolby Vision, or any codec a
given Linux Chromium build can't decode, `configure` throws → `fetchCtrl.abort()`
→ **silent black while audio keeps playing.** The MSE path already guards this
(`MediaSource.isTypeSupported`, [:3286](electron/src/engine-playback.js:3286), with
the "HEVC on Linux" fallback comment). WC must: `await isConfigSupported()` before
configure, and on unsupported → fall back (see gap 2), not black out.

**2. No path-selection / fallback mechanism (HIGH — blocks default).**
`_wcVideo` / `_nativeVideo` / `_mp4Video` are compile-time `const`s
([:1956–1961](electron/src/engine-playback.js:1956)); exactly one is true.
"Make WC default" today literally means flipping the const and **deleting native's
guarantee as a safety net.** The `autoSelectPath` from analysis §3.1 was never
built. Minimum viable: try WC; on unsupported-codec or hard failure, fall back to
`_setupNativeVideo()` for that session. Without this, gap 1 and gap 8 have nowhere
to fall.

**3. `/video-es` is fetched over plain HTTP (MEDIUM — verify).**
`videoUrl` uses `ENGINE` (http :20025, [:3310](electron/src/engine-playback.js:3310));
native deliberately uses `ENGINE_HTTPS` (:20026,
[:4080](electron/src/engine-playback.js:4080)). `fetch()` to loopback http from the
https AM page *probably* rides Chrome's loopback "potentially-trustworthy"
exemption, but it's (a) unverified for the streaming-fetch case and (b)
inconsistent with the whole reason native moved to HTTPS. Switch WC to
`ENGINE_HTTPS` or explicitly confirm the exemption before trusting it as default.
(The HTTPS listener shares the same mux, so `/video-es` is already served there.)

**4. Dead / duplicate WC code (LOW — prune before A).**
`window._amlTestWebCodecs` ([:849–916](electron/src/engine-playback.js:849)) is a
DevTools-only probe that **duplicates the demux+decode logic** of the real path.
`_wcKeyframeEstimate` ([:1970](electron/src/engine-playback.js:1970)) is dead
(never seeded from real keyframes). `_wcCleanup` is also reused as the mp4box
path's cleanup name ([:4065](electron/src/engine-playback.js:4065)). Consolidate to
**one** source of truth before moving code into the worker, or you port the bug
twice.

**5. WC scrubber duration isn't authoritative (LOW).**
Native uses `_durationSec` first ([:2626](electron/src/engine-playback.js:2626),
[:3883](electron/src/engine-playback.js:3883)) precisely because the element's
duration is unreliable. WC still reads `mkAudio.duration` first
([:2620](electron/src/engine-playback.js:2620),
[:3882](electron/src/engine-playback.js:3882)) → during streaming that can be
NaN/growing → scrubber `max` jitter. Give WC the same `_durationSec`-first
treatment as native.

**6. Decoder churn under seek storm (MEDIUM — soak assertion).**
Each seek does `dec = new VideoDecoder` + close-old
([:3701](electron/src/engine-playback.js:3701),
[:3815](electron/src/engine-playback.js:3815)), debounced only 50ms. Rapid
scrubbing → overlapping create/close cycles. `myDec` locals keep *correctness*,
but resource churn/leaks are exactly what workstream C must assert: every abort
path closes its `VideoFrame`s and no `VideoDecoder` leaks across a 10-seek storm.

**7. Sync state must not split across the worker boundary (MEDIUM — shapes A).**
The underrun decision lives in `render` (moves to the worker in A) but the action
is `mkAudio.pause()` on main + the `_msePaused` play-proxy
([:729](electron/src/engine-playback.js:729)). Keep **all** sync *state*
(`_wcStalled` / `_wcRebuffering` / drift) in the worker and expose only *intents*
(`stall` / `playing`) to main — do not read `_msePaused` from two threads. Fold
this constraint into A's message contract.

**8. No terminal give-up → infinite restart risk (MEDIUM).**
Hang recovery ([:3685](electron/src/engine-playback.js:3685)) restarts via
`_commitWcSeek`; a genuinely broken stream (no keyframe from server) can loop
restart→hang→restart with audio playing over a frozen frame forever. Native's
`error` handler **advances the track**; WC has no terminal state. Add bounded
restart attempts → then fall back (gap 2) or advance the track.

---

## Cheap stopgap (independent of all the above)

If you want the black-screen win *now* without the hardening: flip `_wcVideo` on
and ensure the canvas is never cleared on seek (it already holds the last
`drawImage`). ~1 line of intent. Ships the perceived fix; A/B/C make it robust
enough to trust as the permanent default.
