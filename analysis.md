# Apple‑Music‑Linux – MV Video Playback Paths Analysis

*Compiled from the session discussion (2025‑08‑27).*

---

## 1.  Three video‑rendering paths

| Path | Identifier in code | What it does |
|------|-------------------|--------------|
| **MSE (Media Source Extensions)** | `_mp4Video = false` (default) / `_nativeVideo = false` / `_wcVideo = false` | Audio rides the MSE `SourceBuffer` (AAC). Video is rendered either via a **plain `<video>` element** (progressive stream) or via the **mp4box.js** remux spike. Starts playing after the first fragment (~0.5 s). Seeks inside the buffered range are instant; outside → re‑buffer or re‑stream with `?t=<seconds>`. |
| **Native (download‑then‑serve)** | `_nativeVideo = true` | Engine downloads the full fMP4 to a disk cache (`~/.cache/apple-music-linux/…`). Subsequent plays serve the fast‑start MP4 via the privileged `aml‑video://` protocol. The browser’s native `<video>` seeks byte‑range instantly if `Accept‑Ranges: bytes` is present. |
| **WC (WebCodecs + canvas)** | `_wcVideo = true` (feature‑flagged) | Engine streams encrypted fMP4 to the client. A `VideoDecoder` decodes frames into a hidden canvas. Audio is driven from the MK audio element; the canvas is the visual master. Seeks **restart the decoder** with a new `?t=<seconds>` from the engine. More CPU/main‑thread work and explicit A/V‑sync management. |

---

## 2.  Drawbacks / hindrances of each path

| Path | Main hindrances |
|------|-----------------|
| **MSE** | • `CHUNK_DEMUXER_ERROR_APPEND_FAILED` on Apple‑Music B‑frame H.264 content.<br>• `buffered` grows progressively → scrubber range limited until the file is cached.<br>• Audio‑video drift needs a manual nudge (0.35 s threshold). |
| **Native** | • First‑play latency: must stream while caching (~0.5 s initial buffer).<br>• The `firstByteWriter` hard‑codes `Accept‑Ranges: none`, which **pre‑vents Chrome from computing a large `buffered` range** until the file is fully cached.<br>• Disk‑cache size is LRU‑bound (default 2 GiB for MV video segments). |
| **WC** | • Complex A/V sync logic (`_wcStalled`, `_wcRebuffering`, 8‑s hang detection).<br>• Initial‑frame delay – canvas blank until the first keyframe.<br>• Manual memory management (`QUEUE_MAX = 24` frames, `f.frame.close()`).<br>• Seek requires decoder abort + engine round‑trip (slower than a simple `currentTime` set).<br>• No native `buffered` attribute; UI must track `_wcBufferedSec` manually.<br>• Runs on the JS main thread via `VideoDecoder` – potential CPU contention. |

---

## 3.  “Best‑of‑all‑three” hybrid design

The goal: **get the fast first‑play of MSE, the instant seek of Native on repeat plays, and keep WC isolated behind a flag** for edge‑case content.

### 3.1  Automatic path selection (runs once after the engine mounts)

```js
// In electron/src/engine-playback.js, after window.__amlEngineMounted = true;
const useNativeIfCached = () => {
  // The engine writes a side‑car index file when the MV cache commits.
  return require('fs').existsSync(`${cacheDir}/${_sessionId}.idx`);
};
const autoSelectPath = () => {
  if (useNativeIfCached()) {
    _nativeVideo = true; _wcVideo = false; _mp4Video = false;
    console.log('[AML] → native video (cache warm)');
  } else {
    _nativeVideo = false; _mp4Video = false;
    console.log('[AML] → MSE video (first play)');
  }
};
autoSelectPath();
```

*Result* – **First play** → MSE video (quick start). **Repeat play** (same session) → Native video (instant seek).

### 3.2  WC feature flag (optional)

```js
if (navigator.videoDecoder && localStorage.getItem('wc_mv') === '1') {
  _wcVideo = true;
  _setupWebCodecsVideo();
}
```

*Result* – Only users who explicitly enable `wc_mv` see the WebCodecs canvas; everybody else stays on MSE/Native.

### 3.3  Making the native buffer full‑sized (single‑line change)

In `engine/handlers_playback.go` modify `firstByteWriter` to accept an `acceptRanges` string (default `"none"`). In `streamMediaCoalesced` pass `"bytes"` when the caller is the video‑native path, and in `handlePlaybackVideoNative` change the call to:

```go
streamMediaCoalesced(w, r, func(dst io.Writer) error {
    return transcodeVideoForMSE(r.Context(), videoSrc, dst, tsOffset, durationSec)
}, "video/mp4", true)   // third arg = videoNative
```

*Result* – Chrome now reports a `buffered` range that spans the whole file from the first second, and the scrubber shows the full duration immediately. Instant seeks on first play as well.

### 3.4  Optional B‑frame guard for MSE

In the MSE startup (around line 3280) add:

```js
if (_mp4Video || /* B‑frame detection */) {
    _mp4Video = true;   // triggers the mp4box‑remux branch
}
```

*Result* – Prevents the `CHUNK_DEMUXER_ERROR_APPEND_FAILED` that otherwise forces a fallback to the native path.

---

## 4.  Seeking behaviour in the combined system

| Situation | Video path activated | Seek mechanics | Buffered range after seek |
|-----------|----------------------|----------------|--------------------------|
| **First play, no cache** | MSE video | `player.currentTime = seekSec`. If inside buffered part → instant. If outside → engine receives `?t=<seekSec>` and starts streaming from that fragment. | Grows as fragments arrive; scrubber filled proportionally. |
| **Repeat play, cache warm** | Native video | `player.currentTime = seekSec` → browser byte‑range seek on the fast‑start MP4. | **Full‑range** from the first frame (because `Accept‑Ranges: bytes` is now sent). |
| **WC flag enabled** | WC video | Abort current `VideoDecoder`, send `?t=<seekSec>` to engine, start new decoder; canvas re‑draws from the nearest key‑frame. | No native `buffered`; UI tracks `_wcBufferedSec` manually. |
| **Audio (always MSE)** | MSE audio pipe | `player.currentTime = seekSec` → SourceBuffer seeks; if outside buffered → engine `StreamFrom` with `seekSec`. | A/V‑sync nudge keeps audio aligned with video regardless of video path. |

### 4.1  Scrubber UI impact

| Path | Scrubber `max` | Visual buffered bar |
|------|----------------|---------------------|
| **MSE (first play)** | `_durationSec` (MK’s track length) | Filled portion grows as fragments arrive. |
| **Native (cache warm)** | `_durationSec` **and** bar is **full** from the start. | Immediate full‑length bar; thumb jumps to any position instantly. |
| **WC** | `_durationSec` + small overlay `_wcBufferedSec / _durationSec` | Manual UI element; not a native `buffered` attribute. |

---

## 5.  Summary of required code changes (≈ 35 lines total)

| File | Change | ≈ lines |
|------|--------|----------|
| `electron/src/engine-playback.js` | Auto‑select routine (`useNativeIfCached`, `autoSelectPath`). | 12 |
| `electron/src/engine-playback.js` | WC feature flag (`localStorage.getItem('wc_mv')`). | 5 |
| `engine/handlers_playback.go` | Add `acceptRanges` field to `firstByteWriter` and force `"bytes"` in the video‑native path. | 10 |
| `engine/handlers_playback.go` | Update `handlePlaybackVideoNative` call to pass `true` for video‑native flag. | 2 |
| `engine/handlers_playback.go` (optional) | B‑frame guard `if (_mp4Video …)`. | 3 |

These modifications give AML the ability to **start quickly (MSE), seek instantly on repeat plays (Native), and keep the WebCodecs path isolated (WC)** without forcing any single path’s drawbacks on every user.

---

## 6.  Final takeaway

- **Audio** stays on the robust MSE pipe forever (low latency, consistent A/V sync).  
- **Video** automatically picks the best path: MSE on first play, Native on repeat plays (once the on‑disk cache index exists), WC only when the user flips a feature flag.  
- A **single `Accept‑Ranges: bytes` change** makes the native buffer as large as the file, eliminating the “Chrome buffer very small” issue.  
- The combined system therefore delivers **instant first‑play** *and* **instant repeat seeks** while keeping the codebase simple (≈ 35 lines of glue).

--- 

*Generated on 2025‑08‑27 from the session discussion.*

## 7. WC Worthwhileness & Custom Pipeline Feasibility

### 7.1  Does WC present any worthwhile improvements?
- **Reliable B‑frame playback** – The only user‑visible win: WC avoids Chromium’s `CHUNK_DEMUXER_ERROR_APPEND_FAILED` on Apple Music’s B‑frame H.264 content. All other benefits are niche.
- **First‑play latency** – WC is slower (waits for first keyframe), while MSE starts after the first fragment (~0.5 s).
- **Seek speed** – WC seeks require decoder abort + engine round‑trip; Native is instant, MSE is instant within buffered range.
- **CPU / battery** – WC runs `VideoDecoder` on the main JS thread, increasing CPU usage and power draw.
- **Buffer visibility** – No native `buffered` attribute; UI must manually track `_wcBufferedSec`.
- **A/V sync complexity** – Manual `_wcStalled`/`_wcRebuffering` flags, 8‑s hang detection, audio pause/resume choreography.
- **Implementation cost** – ~300 lines of dedicated code, state machine, error‑retry loops.

**Bottom line:** WC’s main advantage (B‑frame‑safe playback) is narrow; for most users the MSE → Native hybrid gives a better overall experience.

### 7.2  Can we craft our own WC pipeline from scratch?
- **Yes, but it is a substantial effort.** The AML codebase already contains a fully‑functional WC spike (`_setupWebCodecsVideo`, decoder configuration, canvas render loop, seek/retries, A/V sync). Re‑implementing from scratch would duplicate most of that work.
- **What you would really gain:**
  * Different pixel format (HEVC/10‑bit) – not supported by Chrome’s `VideoDecoder` on desktop; would require a software GPU pipeline.
  * Custom post‑processing / AR overlays – possible by tapping the `output` callback and drawing extra canvas layers.
  * Full control of seek granularity – still limited by key‑frame interval; sub‑frame seeks need manual frame decoding.
  * Reduced bundle size – unlikely; the existing spike is ~30 KB minified; a new pipeline would likely be larger.
- **Incremental improvements to the existing WC pipeline (much lower effort):**
  * Expose the canvas for custom overlays (spectrum analyser, etc.) – 1‑2 days.
  * Add a “nearest key‑frame” seek button – 2‑3 days.
  * Make WC the default for all tracks (remove feature flag) – 1 day + QA.
  * Add hardware‑acceleration hint – < 1 day.
  * UI “skip‑to‑next‑keyframe” button – 1 day.
- **Quick “starter kit” if you want to experiment:**
  1. Copy the WC block from `engine‑playback.js` into a new file.
  2. Keep the decoder configuration as AML does (parses `avcC` bytes).
  3. Add your own `output` hook for custom overlays.
  4. Implement a lightweight seek that re‑configures the decoder with a new timestamp instead of full abort‑restart.
  5. Wire the new pipeline into the auto‑select logic via a tiny flag.

### 7.3  Recommendation for AML
| Goal | Recommended path |
|------|------------------|
| **Maximise compatibility & lowest latency** | MSE → Native hybrid (auto‑select + `Accept‑Ranges: bytes` fix). |
| **Eliminate B‑frame errors without extra libraries** | Keep WC behind the `wc_mv` feature flag **or** use the mp4box.js remux (`_mp4Video = true`). |
| **Custom visualisation on the video** | Extend the existing WC canvas hooks rather than building a new pipeline. |
| **Support a new video codec (HEVC, 10‑bit, etc.)** | Do not rely on WC; use the native fast‑start MP4 path or a server‑side transcoder. |
| **Smallest code surface & fastest delivery** | Stick with the MSE → Native hybrid (only ~35 lines of glue). |

--- 

*Generated on 2025‑08‑27 from the session discussion.*