# AML RAM reduction — where the GB goes and how to claw it back

Goal: cut the ~1 GB resident set **without losing perf or functionality**; bonus
for faster-with-less. Ranked by (impact × safety). Grounded in the actual config,
not guesses. **Note:** app wasn't running at analysis time, so the per-process
split below is structural reasoning, not a live measurement — step 0 fixes that.

## 0. Measure first (do this before changing anything)

For an Electron app wrapping `music.apple.com`, the resident set is almost
certainly dominated by the **Chromium renderer** (the PWA + WebGL animated
background + decoded artwork), with the Go engine, VLC and GPU process behind it.
Confirm the split live:

```sh
ps -eo rss,args | grep -iE "apple-music|resources/engine|vlc" | grep -v grep \
  | awk '{printf "%6.0f MB  %s\n", $1/1024, $2}' | sort -rn
```

Also `chrome://memory-internals`-style: Electron exposes
`app.getAppMetrics()` (per-process `memory.workingSetSize`) — add a dev IPC to
dump it. This tells you which of the wins below is worth your time. Everything
after assumes the renderer is the big one; the measurement confirms it.

---

## Tier 1 — safe, high-impact (do these)

### 1.1 Re-enable VA-API hardware video decode  ★ dual win (RAM **and** speed)
`VaapiVideoDecoder,VaapiVideoEncoder` is disabled at
[main.mjs:83](electron/main.mjs:83). The comment says why: a Chrome 138 Linux
regression where VA-API falls back mid-stream → `CHUNK_DEMUXER_ERROR` **on the
MSE path**. But:
- Software H.264 decode holds large YUV frame buffers in main memory and burns
  CPU; hardware decode keeps frames in GPU memory and is far lighter.
- The code=3 race was **MSE-specific** (ChunkDemuxer). The native `<video src>`
  and WebCodecs paths use different decode plumbing — the MSE fallback race may
  not apply to them at all.

**Action:** gate the disable to only what needs it. Test HW decode on the
native/WC MV path + normal AAC audio (audio decode is unaffected). If the native
path is clean with VA-API on, this is the single biggest dual win — less RAM,
less CPU, cooler laptop. **Needs a playback test to confirm no code=3
regression**, so it's action-gated, not blind-flip.

### 1.2 Engine: cap and return memory (`GOMEMLIMIT` + `FreeOSMemory`)
The Go engine sets **no** `GOMEMLIMIT`/`GOGC` (grep clean). Default GOGC=100 lets
the heap grow to ~2× live set before GC, and Go is lazy returning freed pages to
the OS — so after a big decrypt/cache burst the engine's RSS stays high.
- Set a soft `GOMEMLIMIT` (e.g. 256–384 MB) in `main.go` via
  `debug.SetMemoryLimit` — soft cap, GC works harder near it, no OOM.
- After the big one-shot operations (full-track ALAC decrypt-to-disk, MV cache
  commit) call `debug.FreeOSMemory()` once to hand pages back.

Engine-only, no renderer/perf risk if the limit is set with headroom.
**~50–150 MB** of idle engine RSS typically returns to the OS. Cheap.

### 1.3 Right-size `disk-cache-size`
Pinned to **1 GB** at [main.mjs:2500](electron/main.mjs:2500) (the earlier
"enlarge cache for MV fragments" change). This is *disk*, but Chromium keeps the
cache **index + hot entries in memory**, which scales with the cap. If MV is
moving to the native/WC path (which caches through the engine's own encrypted
disk cache, not Chromium's media cache), the 1 GB Chromium cache is now buying
little. Drop it to 256 MB and measure. Reversible one-liner.

---

## Tier 2 — medium impact, needs care

### 2.1 Release renderer memory when paused **and** hidden
There is **no** idle memory management: no `backgroundThrottling` handling, no
`session.clearCache`, no purge on hide-to-tray (grep clean). A tray-resident
music app holds the full render tree + decoded images for hours.

**Careful:** this is a *music* app — the window is often hidden while still
playing. Do **not** blanket-enable `backgroundThrottling` (it throttles timers/
rAF → can stall the MSE pipe, MPRIS position, progress). Only release memory when
**paused AND hidden**:
- on `win.on('hide')`/minimize *while paused*: `win.webContents.session
  .clearCache()` for the artwork/http cache is safe (re-fetched on demand).
- Chromium purges frozen renderers if you let it: add
  `--enable-features=MemoryPurgeOnFreeze` — but only pairs safely with freezing,
  which conflicts with background playback. Prefer the explicit paused+hidden
  hook over the flag.

**~100–200 MB** reclaimable during idle-in-tray, with correct gating.

### 2.2 Trim the WC decoded-frame queue (only when WC becomes default)
`QUEUE_MAX = 24` decoded `VideoFrame`s ([engine-playback.js](electron/src/engine-playback.js)).
At 1920×816 a decoded frame is ~6 MB (RGBA/NV12) → **~140 MB of decoded frames
held** at the cap. Fine on the desktop, but if WC ships as default, drop the cap
to ~12 (≈0.5 s at 24 fps) — the render loop only ever needs a small lead. Halves
that pool. (Moot while `_wcVideo=false`.)

---

## Tier 3 — real savings, but a functionality/UX tradeoff (offer as toggle)

### 3.1 Animated now-playing background
Apple Music's own animated background is WebGL (Pixi.js) — a known GPU+RAM hog
(the biggest single renderer cost after the base PWA). We don't own it (we inject
glass CSS in `vision-glass.js`), but we can suppress it via CSS/DOM when a
"Reduce motion / Low memory" setting is on. This is a **visible** change, so it
must be a user toggle, not a default. Biggest single renderer win if the user
opts in — potentially **150–300 MB** + GPU.

---

## What NOT to do (rejected — violate the "no perf/functionality loss" bar)

- **`--js-flags=--max-old-space-size=…`** on the renderer: the AM PWA is heavy;
  a tight V8 cap trades RAM for OOM crashes. No.
- **Blanket `backgroundThrottling: true`**: breaks background playback timing for
  a music app. No (see 2.1).
- **Killing/respawning the renderer on idle**: reload cost + state loss. No.
- **`AudioServiceOutOfProcess` is already disabled** — keeping audio in-process
  is *fewer* processes/less overhead; leave it.

---

## Recommended order

1. **0** measure (`getAppMetrics` dump) — 20 min, tells you if the rest is worth it.
2. **1.2** engine `GOMEMLIMIT` + `FreeOSMemory` — safe, engine-only, do now.
3. **1.3** disk-cache-size → 256 MB — one-liner, measure delta.
4. **1.1** VA-API HW decode on native/WC — highest dual win, gated on a playback
   test.
5. **2.1** paused+hidden cache release — medium effort, careful gating.
6. **3.1** animated-bg toggle — only if the user wants the tradeoff.

Realistic target without touching functionality: **~250–450 MB off idle RSS**
(1.1 + 1.2 + 1.3 + 2.1), and 1.1 also makes video playback *faster* and cooler —
the bonus.
