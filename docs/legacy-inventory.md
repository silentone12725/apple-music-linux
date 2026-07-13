# Legacy Function Inventory

> **Phase 1 of the migration verification pass.**
> Every significant function in the legacy layer is mapped here.
> Implementation work is deferred to Phase 10.
> Evidence labels follow CLAUDE.md conventions.

---

## How to read this table

| Column | Meaning |
|--------|---------|
| Legacy function | Package-qualified name |
| Purpose | What it does |
| Callers | Who calls it (legacy and/or engine) |
| Engine replacement | Engine equivalent, if any |
| Status | See key below |

**Status key**

| Label | Meaning |
|-------|---------|
| RV | Runtime verified — observed directly during execution |
| RE | Reverse engineered — derived from code inspection only |
| HY | Hypothesis — compiling but not exercised against the system |
| MI | Missing — no engine equivalent exists |
| PA | Partial — engine equivalent exists but coverage is incomplete |
| DE | Dead code — no callers found |
| LE | Legacy entry point — intentionally not in engine (CLI / TUI specific) |

---

## runv2 (ALAC / CBCS download and decryption)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `Run` | 3-retry wrapper: download fMP4, send through TCP socket, write to file | `main.go:1204`, `stream.go:prepareAlacStreamFile` | `CBCSSource.Stream` (engine/fairplay/cbcs.go) | HY — modeled after, not runtime-compared |
| `runAttempt` | Single download+decrypt attempt | `Run` | `CBCSSource.streamAttempt` | HY |
| `downloadAndDecryptFile` | Fragment-by-fragment CBCS decrypt loop | `runAttempt` | `CBCSSource.streamAttempt` fragment loop (calls runv2.DecryptFragment directly) | RV — ALAC output verified for one track |
| `TimedResponseBody` | CDN stall guard — resets timer on every ≥256-byte Read | `runAttempt` | `stallDetector` (engine/fairplay/cbcs.go) | HY — timer-on-EOF behavior same as legacy; not runtime-compared |
| `ReadInitSegment` | Read exactly 2 boxes (ftyp + moov) from fMP4 | `runAttempt`, `CBCSSource.streamAttempt` | Called directly by engine | RV — ALAC output correct; rigid 2-box assumption undocumented (see gap §3.1) |
| `ReadNextFragment` | Read one moof+mdat from fMP4 | `runAttempt`, `CBCSSource.streamAttempt` | Called directly by engine | RV — ALAC path |
| `TransformInit` | Strip DRM boxes from moov; build track→sinf map | `runAttempt`, `CBCSSource.streamAttempt` | Called directly by engine | RV — ALAC path |
| `SanitizeInit` | Remove duplicate codec boxes from moov children | `runAttempt`, `CBCSSource.streamAttempt` | Called directly by engine | RV — ALAC path |
| `FilterSbgpSgpd` | Remove sbgp/sgpd from stbl children | `TransformInit` | Called transitively by engine | RV — ALAC path |
| `DecryptFragment` | Per-fragment CBCS decrypt dispatch (calls cbcsDecryptSamples) | `downloadAndDecryptFile`, `CBCSSource.streamAttempt` | Called directly by engine | RV — ALAC path (ALAC = full-subsample); Atmos path (stripe) is RE |
| `cbcsFullSubsampleDecrypt` | Send encrypted payload to TCP socket; read decrypted response in-place | `cbcsDecryptRaw` | Called transitively by engine | RV — wire-traced for ALAC |
| `cbcsStripeDecrypt` | Pattern (stripe) CBCS decrypt — sends only encrypted blocks, interleaves skip | `cbcsDecryptRaw` | Called transitively by engine | RE — used for Atmos; wire-level behavior not independently traced |
| `cbcsDecryptRaw` | Dispatch between full-subsample and stripe based on skipBlockLen | `cbcsDecryptSample` | Called transitively | RV (full-subsample); RE (stripe) |
| `cbcsDecryptSample` | Per-sample CBCS decrypt with subsample pattern handling | `cbcsDecryptSamples` | Called transitively | RV (ALAC) |
| `cbcsDecryptSamples` | Iterate FullSamples; call cbcsDecryptSample per sample | `DecryptFragment` | Called transitively | RV (ALAC) |
| `SwitchKeys` | Write 4 zero bytes to TCP socket (SWITCH_KEYS signal) | `CBCSSource.streamAttempt`, `downloadAndDecryptFile` | Called directly by engine | RV — wire-traced |
| `SendString` | Write 1-byte length + N bytes to TCP socket | `CBCSSource.streamAttempt`, `downloadAndDecryptFile` | Called directly by engine | RV — wire-traced |
| `Close` | Write 5 zero bytes (SWITCH_KEYS + empty adamID = CLOSE) to TCP socket | `CBCSSource.streamAttempt` via `runv2.Close` | Called directly by engine | RV — wire-traced |
| `filterResponse` | Strip non-streamingkeydelivery EXT-X-KEY lines from ALAC playlist | `parseMediaPlaylist` | `engine/hls.filterStreamingKeyDelivery` | PA — engine version exists; equivalence not tested |
| `parseMediaPlaylist` | Parse ALAC HLS media playlist; return segment list | `runAttempt` | `engine/hls.OpenMediaCBCS` | PA — engine covers byterange ALAC; non-byterange hypothetical |
| `alacClient` | Custom HTTP transport: no-compression, 30s dial/keepalive, MaxIdleConns=8 | `runAttempt` | `cbcsHTTPClient` (engine/fairplay/cbcs.go) | HY — fields copied by code inspection; not runtime-compared |
| `ErrTimeout` | Sentinel for CDN stall timeout | `runAttempt`, `stallDetector` | Reused by engine | RV |

**runv2 gaps identified:**

- §3.1 `ReadInitSegment` reads exactly 2 boxes. If Apple ever emits pssh before moov (observed in some variants) this will fail. `runv3/stream.go:readInitSegment` reads up to 64 boxes and is more robust. The engine CBCS path uses the rigid runv2 version.
- §3.2 `downloadAndDecryptFile` writes to disk via `os.Create`; engine streams to io.Writer. Behavior equivalent for the decode path, but buffering differs.
- §3.3 `Run` retry sleeps use `time.Sleep` (not ctx-aware). Engine `CBCSSource.Stream` uses ctx-aware select. Difference documented, not runtime-compared.

---

## runv3 (CTR / Widevine AAC and Music Video)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `AcquireKey` | Context-aware Widevine key acquisition via wrapper server | `engine/fairplay/license.go` | This IS the engine interface — used directly | RV — AAC, MV |
| `DownloadSegments` | Context-aware AIMD parallel segment download + cache | `engine/fairplay/license.go HLSSource` | This IS the engine interface — used directly | RV — AAC, MV; context gap: see §3.4 |
| `DecryptMP4Streaming` | Fragment-by-fragment streaming CTR/CBCS decrypt | `StreamMvData`, engine via `runv3.stream.go` | This IS the engine streaming path | RV — AAC, MV |
| `StreamMvData` | Parallel download via io.Pipe → DecryptMP4Streaming | `main.go` (MV stream), engine (MV stream) | Used directly by engine | RV — MV |
| `downloadAndAssemble` | AIMD parallel download → in-order segment reassembly | `DownloadSegments`, `StreamMvData`, `ExtMvData`, resume | Engine calls via DownloadSegments | RV — MV; context gap §3.4 |
| `downloadSegment` | Single segment: cache check → 4-retry HTTP download | `downloadAndAssemble` | Engine uses this transitively | RV (happy path); RE (retry behavior) |
| `fileWriter` | Reorder out-of-order segments; write in sequence | `downloadAndAssemble` | Engine uses this transitively | RV |
| `aimdLimiter` | AIMD concurrency control (initial=8, min=2, max=32) | `downloadAndAssemble`, `StreamMvData` | Engine uses this transitively | RV |
| `SelectVariantForCodec` | Resolve master playlist → media playlist by codec string | `main.go` (legacy) | `engine/hls.OpenMaster + SelectByCodec` | PA — engine version is separate impl |
| `selectHighestBandwidthVariant` | Resolve master playlist → highest-bandwidth variant | `StreamTrackData` | Not used by engine | LE |
| `ExtMvData` | Non-resumable MV download: parallel download → DecryptMP4 (full-buffer) | `main.go`, station | Not in engine | LE |
| `ExtMvDataResumable` | Resumable MV download with crash-safe manifest | `main.go` | Not in engine | MI |
| `StreamTrackData` | Legacy streaming of ALAC/AAC via webplayback+CBCS path (not used by engine) | `main.go` | Not in engine | LE |
| `Run` (runv3) | Legacy full-file AAC download + decrypt; MV key acquisition | `main.go`, `stream.go` | `engine/apple/provider.go openSong/openMV` (separate path) | LE — intentionally kept for legacy download CLI |
| `RunStream` (runv3) | Legacy streaming AAC (no retry, no ctx, uses http.Get) | `main.go:1012` | `engine` CTR path | LE — superseded; still called by `--mode=stream` |
| `GetWebplayback` | Webplayback API (not context-aware, uses http.DefaultClient) | `Run`, `RunStream` | `engine/apple/provider.go fetchWebplayback` | PA — engine version is ctx-aware; http.DefaultClient shared (see gap §3.5) |
| `BeforeRequest` | Construct Widevine license request JSON | `AcquireKey`, `key.GetKey` | Used transitively by engine | RV |
| `AfterRequest` | Parse Widevine license response | `AcquireKey`, `key.GetKey` | Used transitively by engine | RV |
| `getPSSH` | Build Widevine PSSH bytes from KID | `AcquireKey`, `Run`, `RunStream` | Used transitively by engine | RV |
| `extractKidBase64` | Parse HLS media playlist for EXT-X-KEY; extract KID+URL+prefix | `Run` (MV mode) | `engine/hls.OpenMedia` (separate impl) | LE |
| `extsong` | Full-file download with 3 retries (500ms/1s backoff), progress bar | `Run` (non-MV) | Not in engine | LE |
| `DecryptMP4` | Full-file in-memory decrypt (loads entire file into memory) | `Run`, `ExtMvData` | Not in engine (engine uses streaming) | LE |
| `mvHTTPClient` | Custom transport: no-compression, HTTP/2 forced, 60s timeout, MaxIdleConns=64 | `extsong`, `downloadSegment` | Not directly in engine (engine HLSSource uses `DownloadSegments` which uses mvHTTPClient transitively) | RV |
| `SegmentCache` (struct + methods) | LRU on-disk segment cache with SHA-256 integrity | `downloadSegment`, `GetCachedSegment`, `PutCachedSegment` | Engine uses transitively via DownloadSegments | RV |
| `downloadSegmentCached` (cache.go) | Cache-wrapping segment download — NOT called by downloadAndAssemble | none found | None | DE — dead code; downloadSegment already checks cache inline |
| `WarmCache` / `init()` | Rebuild in-memory LRU from on-disk files at startup | `init()` auto-runs | Engine benefits transitively | RV |
| `SaveManifest`, `LoadManifest`, `DeleteManifest` | Crash-safe JSON resume manifest I/O | `ExtMvDataResumable` | Not in engine | MI |
| `writeSegment`, `verifySegment` | Atomic segment write + SHA-256 verify | `ExtMvDataResumable` | Not in engine | MI |
| `resumeDownload` | Resume download from manifest | `ExtMvDataResumable` | Not in engine | MI |
| `retryFetchBytes` | Single-URL fetch with 3 retries (for resume path) | `resumeDownload` | Not in engine | MI |
| `segmentsReader` | Sequential file reader over saved segment files | `ExtMvDataResumable` | Not in engine | MI |
| `ErrNoSencBox` | Sentinel: fragment has no senc box (unencrypted) | `DecryptMP4`, `DecryptMP4Streaming` | Used transitively by engine | RV |
| `isNoSencBox` | String-match sentinel because mp4ff returns plain error | Both decrypt paths | Used transitively | RV |
| `readInitSegment` (unexported, stream.go) | Read up to 64 boxes until moov — more robust than runv2 version | `DecryptMP4Streaming` | Used by engine CTR path | RV |
| `readNextFragment` (unexported, stream.go) | Read moof+mdat; skip CMAF styp/sidx | `DecryptMP4Streaming` | Used by engine CTR path | RV |

**runv3 gaps identified:**

- §3.4 **Context not propagated into segment downloads.** `downloadSegment` creates requests with `http.NewRequest` (no context). `downloadAndAssemble` checks `ctx.Err()` only once before launching goroutines (line 473) and does not pass ctx to goroutines. Cancellation does not abort in-flight HTTP requests; only after all complete. `DownloadSegments` returns `ctx.Err()` but by then all segments have been fetched or timed out by the 60s client timeout. Impact: cancelling engine stream doesn't immediately stop network I/O.
- §3.5 **`fetchWebplayback` uses `http.DefaultClient`** (engine/apple/provider.go:313). No timeout, no custom transport. runv3.GetWebplayback also uses http.DefaultClient. Neither path has a request timeout; a hung Apple server would block indefinitely.
- §3.6 **`RunStream` (legacy) uses `http.Get`** with no timeout or retry. Still called from `main.go` `--mode=stream`. Superseded by engine but not removed.
- §3.7 **Resume download** (`ExtMvDataResumable`) has no engine equivalent. MV downloads that fail mid-way cannot be resumed through the engine.

---

## stream.go (TUI playback, mpv control, disk cache)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `PlayerSession` | mpv IPC wrapper (Stop/Next/Previous/TogglePause/WaitDone) | `main.go`, `tui.go` | None — engine is headless HTTP API | LE |
| `PlayMedia` | Block on mpv (or ffplay) for single file | `main.go` | None | LE |
| `PlayMediaBackground` | Launch mpv in background, return IPC handle | `main.go`, `tui.go` | None | LE |
| `PlayMediaPlaylist` | Launch mpv with multiple files as playlist | `main.go` | None | LE |
| `traitsToFormat` | Map audioTraits → mpv sampleRate+format string | `PlayMedia*` | None | LE |
| `thresholdWriter` | Signal ch once N bytes written (MV start trigger) | `main.go` MV streaming | None | LE |
| `waitForIPC` | Poll for mpv IPC socket readiness (300ms deadline) | `PlayMedia*` | None | LE |
| `startPrefetchTrack` | Background download+decrypt+MP4Box for next track | `main.go` | None | LE |
| `takePrefetchResult` | Retrieve and clear prefetch result | `main.go` | None | LE |
| `prepareAlacStreamFile` | Download ALAC → temp file → MP4Box normalize | `startPrefetchTrack` | None — engine streams, never writes temp file | LE |
| `ResetStreamPlaylist`, `AddToStreamPlaylist` | Accumulate playlist paths for mpv playlist mode | `main.go` | None | LE |
| `streamDiskCachePath` | Derive cache file path for track+format | `checkDiskCache`, `saveToDiskCache` | None | LE |
| `checkDiskCache` | Return valid cached file path or "" | `main.go` | None | LE |
| `saveToDiskCache` | Atomic rename of temp file into stream cache dir | `main.go` | None | LE |
| `evictCacheIfNeeded` | LRU eviction when cache dir exceeds `StreamCacheSize` MB | `saveToDiskCache` | None | LE |
| `copyFile` | Fallback copy when rename crosses filesystem | `saveToDiskCache` | None | LE |

---

## scheduler.go (parallel metadata prefetch)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `PrefetchMeta` | Start background lyrics+album-data fetch for one track | `main.go` download loop | None | MI |
| `TakeMeta` | Block-retrieve prefetched result | `main.go` download loop | None | MI |
| `PrefetchAlbumMeta` | Launch lookahead prefetches for album/playlist | `main.go` | None | MI |

Note: The engine has no prefetch scheduler. For single-track streaming this is irrelevant. For album/playlist playback via the engine API, each track would require a separate `POST /api/v1/playback` call — no lookahead.

---

## utils/lyrics (lyrics fetch and TTML→LRC conversion)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `Get` | Fetch lyrics (not ctx-aware) | `main.go` | `GetContext` (via apiserver) | LE |
| `GetContext` | Fetch lyrics (ctx-aware) | `scheduler.go`, `apiserver.go handleLyrics` | Used directly by engine | RV |
| `getSongLyrics`, `getSongLyricsContext` | Apple Music timed-lyrics API fetch | `Get`, `GetContext` | Used transitively | RV |
| `TtmlToLrc` | TTML → LRC format conversion | `GetContext` | Used transitively | RV |
| `conventSyllableTTMLToLRC` | Syllable-level TTML → LRC | `GetContext` | Used transitively | RV |
| `containsCJK` | Detect CJK characters (used for syllable timing threshold) | `conventSyllableTTMLToLRC` | Used transitively | RV |

---

## utils/ampapi (Apple Music catalog API)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `GetSongResp` | Song catalog lookup (not ctx-aware) | `main.go` | `GetSongRespContext` | LE |
| `GetSongRespContext` | Song catalog lookup (ctx-aware) | `engine/apple/provider.go`, `apiserver.go` | Used directly by engine | RV |
| `GetAlbumResp` | Album catalog lookup | `main.go`, `utils/task` | Not in engine (engine has no album endpoint) | MI |
| `GetAlbumRespByHref` | Album catalog lookup by href | `main.go` | Not in engine | MI |
| `GetAlbumRespByHrefContext` | Album catalog lookup by href (ctx-aware) | `utils/task/track.go` | Not in engine | MI |
| `GetMusicVideoResp` | MV catalog lookup (not ctx-aware) | `main.go` | `GetMusicVideoRespContext` | LE |
| `GetMusicVideoRespContext` | MV catalog lookup (ctx-aware) | `engine/apple/provider.go`, `apiserver.go` | Used directly by engine | RV |
| `GetPlaylistResp` | Playlist catalog lookup | `main.go`, `utils/task` | Not in engine (no playlist endpoint) | MI |
| `GetStationResp` | Station catalog lookup | `main.go` | Not in engine | MI |
| `GetStationAssetsUrlAndServerUrl` | Station HLS URL + wrapper server URL | `main.go` | Not in engine | MI |
| `GetStationNextTracks` | Next tracks in station rotation | `main.go` | Not in engine | MI |
| `Search` | Catalog search (songs, albums, MV, playlists, artists) | `main.go`, `tui.go` | Not in engine | MI |
| `GetToken` | Fetch Apple Music bearer token from apple.com | `ampapi` callers, `main.go` | Used transitively (engine uses Config.AuthorizationToken) | RV |

---

## utils/task (task structs — track, album, playlist)

| Legacy function | Purpose | Callers | Engine replacement | Status |
|-----------------|---------|---------|-------------------|--------|
| `Track.GetAlbumData` | Fetch album data for a playlist track | `main.go` | Not in engine | LE |
| `Track.GetAlbumDataContext` | Same, ctx-aware | `scheduler.go` | Not in engine | LE |
| `Album.GetResp` | Fetch album contents (tracks) | `main.go` | Not in engine | MI |
| `Album.ShowSelect` | Interactive album track selector | `main.go`, `tui.go` | Not in engine | LE |
| `Album.GetArtwork` | Artwork URL from album response | `main.go` | Not in engine | LE |
| `Playlist.GetResp` | Fetch playlist tracks | `main.go` | Not in engine | MI |
| `Playlist.ShowSelect` | Interactive playlist track selector | `main.go`, `tui.go` | Not in engine | LE |
| `Playlist.GetArtwork` | Artwork URL from playlist response | `main.go` | Not in engine | LE |

---

## engine packages (new — for completeness)

### engine/hls

| Function | Status |
|----------|--------|
| `OpenMaster` — fetch + parse master HLS | RV |
| `SelectByCodec` — find variant by codec string | RV |
| `SelectAudioVariant` — find audio rendition by group priorities | RV (MV) |
| `SelectVideoVariant` — find video variant up to maxHeight | RV (MV) |
| `OpenMedia` — fetch + parse CTR media playlist; extract EncryptionInfo | RV (AAC, MV) |
| `OpenMediaCBCS` — fetch + parse CBCS media playlist; extract key URIs + file URL | RV (ALAC, Atmos) |
| `filterStreamingKeyDelivery` — strip non-streamingkeydelivery EXT-X-KEY lines | RV (used by OpenMediaCBCS) |

### engine/fairplay

| Function | Status |
|----------|--------|
| `LicenseProvider.Open` → Widevine CTR decryptor | RV |
| `HLSSource` → pipeline.Source (calls DownloadSegments) | RV |
| `CBCSSource` → pipeline.Source (download + TCP socket decrypt) | HY — one track verified at output level; no protocol trace of engine path |
| `stallDetector` | HY — timer-on-EOF same as legacy; not runtime-compared |

### engine/apple

| Function | Status |
|----------|--------|
| `openSong` — AAC (CTR) and ALAC/Atmos (CBCS) | RV — AAC, ALAC, Atmos output-verified (one track each) |
| `openMV` — MV (CTR video + CTR audio) | RV (one MV) |
| `makeTrackOpener` — CTR track pipeline factory | RV |
| `makeCBCSTrackOpener` — CBCS track pipeline factory | RV |
| `fetchWebplayback` | RV; fixed to use webplaybackClient (30s timeout) — gap H1 closed |
| `webplaybackURL` | RV (MV) |
| `webplaybackAssetURL` | RV (AAC) |

### engine/playback

| Function | Status |
|----------|--------|
| `Manager.Open` | RV |
| `Manager.Stream` | RV |
| `Manager.Release` | RV |
| `reap` (TTL eviction goroutine) | HY — not exercised at 4h boundary |

### apiserver.go

| Endpoint | Status |
|----------|--------|
| `GET /api/v1/status` | RV |
| `GET /api/v1/capabilities` | RV |
| `GET /api/v1/events` (SSE) | RV |
| `POST /api/v1/playback` | RV — AAC, ALAC, Atmos, MV |
| `GET /api/v1/playback/{id}/audio` | RV |
| `GET /api/v1/playback/{id}/video` | RV (MV) |
| `DELETE /api/v1/playback/{id}` | RV |
| `GET /api/v1/metadata/{id}` | RV |
| `GET /api/v1/artwork/{id}` | RV |
| `GET /api/v1/lyrics/{id}` | RV |
| Search endpoint | MI |
| Album endpoint | MI |
| Playlist endpoint | MI |
| Station endpoint | MI |
| Download endpoint | MI |

---

## Summary of gaps

### Critical (C) — breaks existing behavior or correctness

| ID | Gap | Location | Impact | Fixed |
|----|-----|----------|--------|-------|
| C1 | `runv2.ReadInitSegment` reads exactly 2 boxes — fails if pssh precedes moov | `engine/fairplay/cbcs.go:streamAttempt` | Silent failure on tracks where Apple changes box order | ✓ 3ab6ba2 |
| C2 | `downloadSegment` not context-aware — cancellation does not abort in-flight segment HTTP requests | `runv3/runv3.go:downloadSegment` | Engine stream cancel does not stop network I/O; goroutine leak until 60s timeout | ✓ 7710044 |

### High (H) — correctness risk or significant behavior difference

| ID | Gap | Location | Impact | Fixed |
|----|-----|----------|--------|-------|
| H1 | `fetchWebplayback` uses http.DefaultClient (no timeout) | `engine/apple/provider.go` | Hung Apple server blocks engine Open indefinitely | ✓ 022af13 |
| H2 | `runv3.GetWebplayback` uses http.DefaultClient (no timeout) | `runv3/runv3.go:127` | Same as H1 for legacy CLI path | open — legacy path only |
| H3 | CBCS engine path has no protocol trace — only output verified | `engine/fairplay/cbcs.go` | Socket framing bugs would not be detected until track fails |
| H4 | Atmos stripe decryption path (`cbcsStripeDecrypt`) not wire-verified | `runv2/runv2.go:518` | Stripe protocol bugs undetected |

### Medium (M) — missing features, no legacy equivalent in engine

| ID | Gap | Description |
|----|-----|-------------|
| M1 | Resume download not in engine | `runv3/resume.go` — no engine path |
| M2 | Metadata prefetch scheduler not in engine | `scheduler.go` |
| M3 | Disk stream cache not in engine | `stream.go:checkDiskCache` etc. |
| M4 | Search not in engine API | `ampapi/search.go` |
| M5 | Album/playlist endpoints not in engine API | `ampapi/album.go`, `task/album.go` |
| M6 | Station playback not in engine API | `ampapi/station.go` |
| M7 | Engine session reap goroutine not tested at TTL boundary | `engine/playback/manager.go:reap` |

### Low (L) — documentation or test gaps

| ID | Gap | Description |
|----|-----|-------------|
| L1 | No byte-for-byte comparison between legacy and engine outputs | Across all content types |
| L2 | No multi-storefront verification | All engine and legacy paths |
| L3 | Engine CBCS path exercised for one track only | `CBCSSource` |
| L4 | No cancellation regression tests | Context propagation through pipeline |
| L5 | No retry regression tests | CBCSSource, downloadSegment |
| L6 | No socket timeout/failure tests | TCP socket protocol |
| L7 | `cbcsHTTPClient` transport not runtime-compared against `alacClient` | `engine/fairplay/cbcs.go` |
| L8 | Session TTL eviction not exercised | `engine/playback/manager.go:reap` |
