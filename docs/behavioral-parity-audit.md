# Behavioral Parity Audit — ALAC, Atmos, Music Video

> Evidence labels: **RV** = Runtime Verified · **RE** = Reverse Engineered · **HY** = Hypothesis
>
> All findings are classified before any fix is applied.
> "First divergence" refers to the earliest point in the call graph where
> engine behaviour differs from legacy, regardless of whether it is the
> proximate cause of the observed failure.

---

## Execution paths audited

### ALAC / Atmos (legacy)

```
runv2.Run(adamId, playlistUrl, outfile, Config)
  └─ runv2.runAttempt(...)                           ← retry wrapper
       ├─ http.NewRequest GET playlistUrl            ← fetch CBCS media playlist
       ├─ alacClient.Do(req)                         ← custom HTTP client
       ├─ parseMediaPlaylist(resp.Body)              ← filter + parse → []MediaSegment
       │    └─ filterResponse(r)                     ← strip non-streamingkeydelivery keys
       ├─ url.Parse(playlistUrl).Parse(seg[0].URI)   ← resolve byterange file URL
       ├─ context.WithCancelCause(context.Background()) ← NOT the caller's context
       ├─ time.AfterFunc(30s, cancel(ErrTimeout))    ← stall timer started BEFORE HTTP download
       ├─ alacClient.Do(req) → resp.Body             ← start download
       ├─ TimedResponseBody{body: resp.Body, ...}    ← wrap with stall detection
       ├─ if ContentLength < MaxMemoryLimit(4096MB)  ← ALWAYS true for ALAC (~40MB)
       │    io.Copy(buf, body)                       ← BUFFER ENTIRE FILE FIRST
       │    body = &buf                              ← body is now in-memory bytes.Buffer
       ├─ net.Dial("tcp", Config.DecryptM3u8Port)    ← TCP dial after full download
       └─ downloadAndDecryptFile(conn, body, ...)
            ├─ ReadInitSegment(inBuf)
            ├─ TransformInit(init)
            ├─ SanitizeInit(init)
            ├─ init.Encode(outBuf)
            └─ for i := 0; ; i++
                 ├─ ReadNextFragment(inBuf, offset)
                 ├─ segment = playlistSegments[i]
                 │    └─ if nil → error "segment number out of sync"
                 ├─ if key != nil
                 │    ├─ if i != 0 → SwitchKeys(rw)
                 │    ├─ if key.URI == prefetchKey → SendString("0")
                 │    │   else → SendString(adamId)
                 │    └─ SendString(key.URI)
                 │    [Flush happens inside DecryptFragment below]
                 ├─ DecryptFragment(frag, tracks, rw)
                 │    └─ cbcsFullSubsampleDecrypt / cbcsStripeDecrypt
                 │         └─ conn.Flush()           ← single flush per sample block
                 └─ frag.Encode(outBuf)
```

### ALAC / Atmos (engine)

```
CBCSSource.Stream(ctx, w)                            ← ctx = HTTP request context
  └─ CBCSSource.streamAttempt(ctx, w)               ← retry wrapper (same count/backoff)
       ├─ context.WithCancelCause(ctx)               ← DIVERGENCE 1: uses caller's ctx
       ├─ http.NewRequestWithContext(dlCtx, ...)
       ├─ cbcsHTTPClient.Do(req) → resp.Body         ← start download (STREAMING)
       ├─ newStallDetector(resp.Body, ...)            ← wrap with stall detection
       ├─ net.Dialer{}.DialContext(ctx, "tcp", ...)  ← DIVERGENCE 2: dial DURING download
       ├─ ReadInitSegment(inBuf)                     ← reads from live HTTP stream
       ├─ TransformInit / SanitizeInit / init.Encode
       └─ for i := 0; ; i++
            ├─ ReadNextFragment(inBuf, offset)       ← reads from live HTTP stream
            ├─ if i < len(keyURIs) && keyURIs[i] != ""
            │    ├─ if i != 0 → SwitchKeys(rw)
            │    ├─ if keyURIs[i] == prefetchKey → SendString("0")
            │    │   else → SendString(adamID)
            │    └─ SendString(keyURIs[i])
            ├─ DecryptFragment(frag, tracks, rw)
            └─ frag.Encode(outBuf)
```

---

## Divergence table — ALAC / Atmos

| # | Location | Legacy behaviour | Engine behaviour | Evidence | Severity |
|---|----------|-----------------|------------------|----------|---------|
| **D1** | Context for HTTP download | `context.Background()` — lives forever | Caller's HTTP request context — dies if browser disconnects | RE | Medium |
| **D2** | TCP dial timing | **After full file in memory** (`net.Dial` called after `io.Copy` completes) | **During HTTP download** (`DialContext` called before any fragment is read) | RE | **Critical** |
| **D3** | Full-file buffering | `io.Copy(buf, body)` before TCP dial — entire fMP4 in `bytes.Buffer` | No buffering — streaming fragment-by-fragment while downloading | RE | **Critical** |
| **D4** | TCP dial API | `net.Dial("tcp", addr)` — no context, no timeout | `(&net.Dialer{}).DialContext(ctx, tcpAddr)` — inherits caller context | RE | Low |
| **D5** | stall timer start | Timer started **before** `alacClient.Do` — covers connection time too | Timer started **after** `Do` returns — covers read time only | RE | Low |
| **D6** | Playlist fetch client | `alacClient` (custom transport) | `fetch()` → `http.DefaultClient` (no custom transport) | RE | Medium |
| **D7** | Retry on partial write | N/A: output is bytes.Buffer or file; each retry is clean | Output is HTTP response; retry writes init segment **again** after partial write | RE | **Critical** |
| **D8** | Output flushing | `outBuf.Flush()` at end only; TCP write happens first | `outBuf.Flush()` at end + auto-flush as bufio fills; firstByteWriter triggers HTTP flush on first auto-flush | RE | Medium |

**D2 + D3** together are the most likely cause of the wrapper lease issue:
- Legacy: wrapper TCP session is opened only AFTER the full 40 MB file is in memory.
  Download typically takes several seconds. When the wrapper gets the connection, it
  requests the Apple lease. The wrapper holds that lease only for the duration of the
  decryption (fast, since data is already buffered).
- Engine: wrapper TCP session is opened DURING the download. The wrapper requests the
  Apple lease while the download is still running. If the download takes 10-30 seconds,
  the wrapper holds the Apple lease for the entire download duration, increasing the
  window where a second connection (retry or concurrent request) appears as a second device.

**D7** is the most likely cause of stream corruption:
- If the first attempt writes the init segment to the HTTP response and then fails mid-stream,
  the retry writes the init segment AGAIN. The browser receives:
  `[init][frag0][frag1] [init][frag0][frag1]...` which is not valid fMP4.

---

## Execution paths audited — Music Video

### Legacy MV (engine-facing path via webplayback)

```
openMV(ctx, req)
  ├─ webplaybackURL(ctx, adamID, token, mut)         ← POST webPlayback API
  │    └─ webplaybackClient.Do(req)                  ← 30s timeout (H1 fix)
  ├─ hls.OpenMaster(ctx, masterURL)                  ← fetch HLS master playlist
  ├─ master.SelectVideoVariant(req.MVMaxHeight=2160) ← highest bw video ≤ 2160p
  ├─ master.SelectAudioVariant(MVAudioPriorities)    ← ["audio-atmos","audio-ac3","audio-stereo-256"]
  ├─ makeTrackOpener(lp, assetID, token, mut, videoURL, KindVideo, CodecH264)
  └─ makeTrackOpener(lp, assetID, token, mut, audioURL, KindAudio, CodecAAC)
       └─ (called during manager.Open, not during Stream)
            ├─ hls.OpenMedia(ctx, audioURL)          ← fetch audio media playlist
            ├─ if med.Encryption == nil → error      ← audioURL might be CBCS not CTR
            └─ lp.Open(ctx, licenseRequest)          ← acquire Widevine key

When streaming audio:
  pipeline.Run(ctx, audioStream, w)
    └─ runChain → pipe → HLSSource.Stream → runv3.DownloadSegments
                       → DecryptStage → runv3.DecryptMP4Streaming
```

### MV divergence candidates

| # | Location | Legacy (CLI) | Engine | Evidence | Severity |
|---|----------|-------------|--------|----------|---------|
| **D9** | Audio selection | CLI uses custom priority via `MVAudioType` config | Engine uses fixed `["audio-atmos","audio-ac3","audio-stereo-256"]` | RE | Low |
| **D10** | Audio URL resolution | CLI's webplayback master: audio renditions are in EXT-X-MEDIA groups | Engine: `SelectAudioVariant` picks highest-rank URI from matching group | RE | Low |
| **D11** | QA console sync | No sync between audio/video elements before fix | After fix: `video.onplay → audio.play()` | RE | **Critical for UX** |
| **D12** | Audio element hidden | Not applicable (no HTML) | Audio element auto-hidden for video sessions in old JS | RE | Fixed |

**D11** is the primary reason "only video playing" was observed: the JS fix was needed and is now applied.

---

## Migration table — functions

| Legacy Function | File | Engine Function | Engine File | Status | Modification | Reason |
|----------------|------|----------------|-------------|--------|-------------|--------|
| `Run` | runv2/runv2.go | `CBCSSource.Stream` | engine/fairplay/cbcs.go | Modified | Retry count same; sleep ctx-aware | Interface adaptation |
| `runAttempt` | runv2/runv2.go | `CBCSSource.streamAttempt` | engine/fairplay/cbcs.go | **Rewritten** | Missing full-file buffer (D3); wrong TCP timing (D2) | **Bug: D2, D3 unresolved** |
| `downloadAndDecryptFile` | runv2/runv2.go | Fragment loop in `streamAttempt` | engine/fairplay/cbcs.go | Modified | Output is io.Writer not file; no segment nil-check | Interface adaptation |
| `TimedResponseBody` | runv2/runv2.go | `stallDetector` | engine/fairplay/cbcs.go | Modified | CancelCauseFunc instead of AfterFunc restart; timer-on-EOF same | Equivalent behaviour |
| `alacClient` | runv2/runv2.go | `cbcsHTTPClient` | engine/fairplay/cbcs.go | Copied | MaxIdleConns=8, same fields | Direct copy |
| `ReadInitSegment` | runv2/runv2.go | Called directly | — | Reused | C1 fix: reads up to 64 boxes | Bug fix on copy |
| `ReadNextFragment` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `TransformInit` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `SanitizeInit` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `DecryptFragment` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `SwitchKeys` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `SendString` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `Close` | runv2/runv2.go | Called directly | — | Reused | Same | Direct reuse |
| `filterResponse` | runv2/runv2.go | `filterStreamingKeyDelivery` | engine/hls/hls.go | Rewritten | String-split vs bufio.Scanner | Functionally equivalent |
| `parseMediaPlaylist` | runv2/runv2.go | `hls.OpenMediaCBCS` | engine/hls/hls.go | Rewritten | Engine also resolves file URL; no nil-segment check | D-class gap: nil check missing |
| `extractMedia` | main.go | `hls.OpenMaster + SelectByCodec` | engine/hls/hls.go | Rewritten | Legacy respects `AlacMax`; engine picks highest bw regardless | **Variant may differ for hi-res** |

---

## Identified bugs

### BUG-1 (D2 + D3): TCP connection opened before file is in memory
**Severity:** Critical — probable cause of wrapper lease conflict  
**Evidence:** RE (code inspection of both paths confirms timing difference)  
**Fix:** Buffer entire fMP4 response before opening TCP socket. Match legacy `io.Copy(buf, body); body = &buf` pattern.

### BUG-2 (D7): Retry after partial HTTP write corrupts stream
**Severity:** Critical — browser receives duplicate init segments  
**Evidence:** RE  
**Fix:** `CBCSSource.Stream` must not retry if any bytes have been written to the output writer. Detect via `firstByteWriter.started` before retrying.

### BUG-3: `OpenMediaCBCS` does not check for nil segments
**Severity:** Low — would cause "index out of range" on malformed playlists  
**Evidence:** RE  
**Fix:** Align with legacy: return error if fragment index exceeds segment count.

### BUG-4 (D6): Playlist fetch uses `http.DefaultClient`
**Severity:** Medium — no timeout, no custom transport for playlist HTTP requests  
**Evidence:** RE  
**Fix:** Use `alacClient` (or equivalent) for playlist fetches in `fetch()`.

---

## Remaining runtime validation work

| Item | What to capture | Tool |
|------|----------------|------|
| OQ-ALAC-1 | Wire trace of engine CBCS path after BUG-1 fix | socat + cmd/protoinspect |
| OQ-ALAC-2 | Byte-for-byte output comparison: legacy vs engine | sha256sum both outputs |
| OQ-ATMOS-1 | Confirm Atmos stripe protocol frames identically in engine | socat trace |
| OQ-MV-1 | Confirm audio stream is actually delivered after QA console fix | Chromium DevTools Network |
| OQ-WRAPPER-1 | Confirm wrapper lease not re-requested on retry after BUG-1 fix | netstat or socat during retry |
