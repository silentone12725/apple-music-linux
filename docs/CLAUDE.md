# Claude Code Instructions

## Repository layout

**Legacy layer** (`main.go`, `stream.go`, `utils/runv2/`, `utils/runv3/`, `utils/task/`, `utils/ampapi/`)
— original download/stream CLI; not being removed, still used for ALAC/Atmos.

**Engine layer** (`engine/`)
— new structured playback engine exposed as an HTTP API via `--api <port>`.

## Engine package map

| Package | Role |
|---------|------|
| `engine/media` | `Provider` interface, `Session`, `Track`, `OpenRequest` |
| `engine/pipeline` | `Source`, `Stage`, `Decryptor`, `Stream`, `Run()` |
| `engine/hls` | Pure HLS parser — no DRM, no downloading |
| `engine/fairplay` | `LicenseProvider` interface + Widevine CTR implementation |
| `engine/apple` | `media.Provider` implementation for Apple Music |
| `engine/playback` | `Manager` — coordinates provider + pipeline; serves the HTTP API |

## Architecture freeze

The engine architecture is **frozen**. Do not perform architectural refactors or
change public interfaces unless a test reveals a real defect.

Import graph enforced by `engine/archtest/`:
`playback → apple → fairplay → runv3`; `apple → hls`; `playback → media`

**Approved relaxation (2026-07-08):** DRM backend selection now uses a policy
(preferred + automatic startup fallback) with an exclusive session lock. This was
a bounded, additive change — no public interface changed, DRMManager untouched
(`fallbackBackend` is itself a `DRMBackend`). Rationale + the deferred
BackendSupervisor: `docs/design/backend-supervisor.md`.

## Current understanding of Apple Music DRM (see also docs/investigations/2026-07-02-drm-paths.md)

Two distinct key delivery formats have been observed at runtime. This is current
understanding based on one song (adamID 1488408568) — the full picture may differ
for other content types.

**CTR format** — implemented in engine:
- Source: webplayback API `Assets` array, `FlavorCTR256 = "28:ctrp256"`
- CDN: `aod-ssl.itunes.apple.com`
- EXT-X-KEY: `URI="data:;base64,[kid]"` — comma splits into prefix + KID
- Key acquisition: Widevine CDM via wrapper server (HTTP endpoint)
- Verified for: standard AAC-LC 256 kbps

**CBCS format** — implemented in engine; runtime verified (wire) for ALAC (one track):
- Source (observed for adamID 1488408568): catalog `ExtendedAssetUrls.EnhancedHls` master → variants
- CDN: `aod.itunes.apple.com`
- EXT-X-KEY: `URI="skd://itunes.apple.com/…"` — no comma → `EncryptionInfo = nil` in engine/hls
- Key acquisition: FairPlay streaming via TCP socket at `Config.DecryptM3u8Port`
- Observed codecs in catalog: ALAC, Atmos, and all AAC tiers share the same CBCS format
- WebPlayback CBCS assets also exist (`30:cbcp256`, `34:cbcp64`) with content-specific `skd://` URIs
- Whether webplayback ALAC/Atmos assets exist (for other tracks, storefronts, or account tiers): unknown
- TCP socket protocol: see `docs/investigations/2026-07-02-tcp-socket-protocol.md`
- **Atmos stripe decryption protocol**: runtime verified at output level only (MP4Box).
  The ALAC full-subsample path was traced via socat. Atmos uses a different socket framing
  (non-contiguous encrypted blocks per `runv2.cbcsStripeDecrypt`); that path has not been
  independently traced. The Atmos output is correct, but the socket-level stripe protocol
  for Atmos is reverse engineered from legacy code — not wire-verified.

**Asset flavor constants** are defined in `engine/apple/provider.go`:
```go
FlavorCTR256  AssetFlavor = "28:ctrp256"  // CTR/Widevine 256 kbps — verified working
FlavorCTR64   AssetFlavor = "32:ctrp64"   // CTR/Widevine 64 kbps
FlavorCBCS256 AssetFlavor = "30:cbcp256"  // CBCS/FairPlay 256 kbps
FlavorCBCS64  AssetFlavor = "34:cbcp64"   // CBCS/FairPlay 64 kbps
```

## Evidence quality levels

Labels used throughout this file:

- **Runtime verified** — observed directly during execution: socat trace, HTTP
  response captured, MP4Box output measured, or engine HTTP API exercised
  end-to-end.  Sub-labels used where precision matters:
  - *Wire* — byte-level socat capture
  - *Output* — output file measured with MP4Box (fragment count, duration, codec)
  - *Engine* — exercised through the engine HTTP API (`POST /api/v1/playback` → `GET audio/video`)

- **Reverse engineered** — derived from reading the legacy implementation
  (`utils/runv2/`, `utils/runv3/`) or from code inspection; consistent with
  wire evidence but not independently observed at runtime.

- **Hypothesis** — implemented and compiling; expected to work based on the
  above evidence but not yet exercised against the running system for this
  specific scenario.

## Runtime verified

Evidence for each claim is in `docs/investigations/` and the test suite.

**FairPlay wrapper connectivity** — Runtime verified (wire). TCP socket at `Config.DecryptM3u8Port` (127.0.0.1:10020) accepts connections and returns decrypted bytes.

**TCP protocol framing (ALAC path)** — Runtime verified (wire) 2026-07-02 via 341 MB socat trace + `cmd/protoinspect`.
All message boundaries located: key setup, SwitchKeys, Close signal.
Byte-level cross-check: 41,611,808 total wire bytes; tool-parsed: 41,611,708 sample data + 100 bytes protocol overhead.
Key session structure: 2 sessions — preshare key (161 samples, HLS seg 0), real key (2010 samples, HLS segs 1-13).
Only 1 SWITCH_KEYS for the entire stream; segments 1-13 share one key session.
See `docs/investigations/2026-07-02-tcp-socket-protocol.md`.

**ALAC playback — legacy pipeline** — Runtime verified (wire + output). socat trace captured; MP4Box measured:
40 MB fMP4. Box layout: ftyp + moov + 14×(moof+mdat), contiguous. 2171 samples, 00:03:21.569. alac, 44100 Hz, 24-bit.

**ALAC playback — engine** — Runtime verified (engine + output). Same track (adamID 1488408568):
`POST {"capabilities":{"lossless":true}}` → HTTP 201. `GET /audio` → 40 MB fMP4, same fragment count and duration as legacy output.
Note: output files match for this one track; no byte-for-byte comparison or protocol trace of the engine path has been done.

**Atmos playback — engine** — Runtime verified (engine + output). Same track:
`POST {"capabilities":{"atmos":true}}` → HTTP 201. `GET /audio` → 19 MB fMP4, 14 fragments, 6252 samples, 00:03:20.064. ec-3, 48000 Hz, 6ch.
Note: Atmos socket-level stripe decryption (non-contiguous block protocol) is reverse engineered from legacy only — not wire-verified. The output is correct; the wire path is inferred.

**AAC playback — engine** — Runtime verified (engine). 256 kbps AAC, CTR/Widevine path. ffprobe: codec=aac, 44100 Hz, ~262 kbps, correct duration.
(Note: ffprobe unreliable for CMAF fMP4 duration; use MP4Box for duration claims on fragmented files.)

**Music Video playback — engine** — Runtime verified (engine + output) 2026-07-02 (adamID 1495409676).
`POST {"capabilities":{"video":true}}` → HTTP 201, type=mv, audio+video.
Audio: 27 fragments, 12308 samples, 00:04:22 (MP4Box), aac 48000 Hz stereo.
Video: h264, 1912×1072, CTR/Widevine. Stream plays in VLC; MPV does not handle the live HTTP endpoint.

**Lyrics — engine** — Runtime verified (engine) 2026-07-02. LRC and TTML formats; missing song returns 404. Storefront-restricted by Apple.

**Engine architecture** — Enforced by `engine/archtest/arch_test.go`. Import graph violations are compile-time failures.

**ReadInitSegment — flexible box order** — Runtime verified (tests). `utils/runv2/runv2_test.go`:
`TestReadInitSegment_UnknownBoxBeforeSequence` passes, confirming that unknown boxes before ftyp+moov are
consumed rather than rejected. Regression for C1 fix.

**Context propagation into segment downloads** — Runtime verified (tests). `utils/runv3/context_test.go`:
`TestDownloadSegments_ContextCancellation` output: `started=4, completed=0` — all in-flight HTTP requests
aborted on cancellation. Regression for C2 fix.

**CBCSSource retry loop** — Runtime verified (tests). `engine/fairplay/cbcs_test.go`:
`TestCBCSSource_RetryOnHTTPFailure`: exactly 3 server calls for 3 exhausted retries.
`TestCBCSSource_CancelDuringRetryBackoff`: returns in 51ms vs 1s backoff window.

**Stall detector timer-on-EOF behavior** — Runtime verified (tests). `TestStallDetector_TimerNotStoppedOnEOF`:
`cause = context.Canceled` (not `ErrTimeout`) — confirms deferred `cancel(nil)` fires before the 30s timer.
Same behavior as `runv2.TimedResponseBody`. Both implementations leave timer running on EOF.

**Wrapper process-group teardown on shutdown** — Runtime verified (wire + tests) 2026-07-08.
`wrapper-rootless` is a launcher that forks a `main` worker holding the DRM ports
(:10020/:20020/:30020). Previously `ProcessBackend.Stop` SIGKILLed only the direct
child, orphaning the worker to init (leaking ports + the single-user session on every
shutdown). Fixed: launch the wrapper with `Setpgid` (own process group) and
`syscall.Kill(-pid, SIGKILL)` on Stop. Verified: engine SIGTERM releases all three
ports with no surviving wrapper. Regression: `engine/drm/orphan_integration_test.go`
`TestProcessBackend_StopReapsForkedWorker` (integration-tagged; mock forks a worker via
`MOCK_FORK_WORKER=1`) — negative-control confirmed (FAILS pre-fix, PASSES post-fix).
Linux-only (project is already Linux-only: CGO/bionic embedded backend, /proc usage).

Also applied as defense-in-depth: `ProcessBackend`'s wrapper launch now sets
`Pdeathsig: SIGKILL` (kernel-enforced — if the *engine itself* dies abruptly
without calling `Stop()`, the wrapper is killed automatically, not just on the
graceful-shutdown path).

**EmbeddedBackend process-group teardown** — 2026-07-08. Same class of risk as
above: the CGO container (`drm_embed.c`) forks an intermediate waiter which
forks again (new PID namespace) and execve's the grandchild into
`/system/bin/main` — the real DRM worker. `EmbeddedBackend.Stop()` tracked and
killed only the waiter's PID. Note on rigor: repeated controlled trials found
the worker is already reliably reaped in this path (drm_embed.c's existing
`PR_SET_PDEATHSIG` covers it for the binary as currently built) — so this is
**defense-in-depth, not a fix for an observed failure** (an earlier single
manual observation suggesting an active orphan did not reproduce under
controlled retesting). The change: `child_main()` now calls `setpgid(0,0)`
before its inner fork so the worker inherits the same process group, and
`Stop()` does a group kill (`-pid`) instead of relying on `PR_SET_PDEATHSIG`
surviving exec (a kernel guarantee conditional on the worker binary's privilege
attributes — see `drm_embed.c` for detail). Regression:
`engine/drm/embedded_orphan_integration_test.go`
`TestEmbeddedBackend_StopReapsWorker` (integration-tagged; needs a real
wrapper+rootfs+session, skips otherwise) — locks in the "Stop() leaves nothing
behind" invariant; unlike the ProcessBackend test, old code also passes it, so
this doesn't by itself prove a regression fix.

**Backend policy: legacy bool was silently a no-op** — 2026-07-08. Found while
auditing `cmd/startupbench`: `resolveBackendPolicy` never actually read
`Config.UseEmbeddedBackend` — the "auto" default applied regardless of the
bool's value, so `use-embedded-backend: false` silently did nothing (the
engine would still try Embedded first via auto, contrary to old exact
semantics). Fixed by moving the policy into a pure, testable function
(`drm.ResolveBackendPolicy`, `engine/drm/policy.go` — `apiserver.go`'s
`resolveBackendPolicy` duplicate removed) with explicit precedence: explicit
`backend.preferred` > legacy `true` (embedded, no fallback — exact pre-fallback
semantics) > unset/false (the new auto default: embedded, process fallback).
9 unit tests cover every branch (`policy_test.go`) — this function couldn't be
tested in `package main` (module named "main", see below).

**Test suite** — `go test -race ./...` passes for all packages with tests.
`utils/runv2` (14 tests), `utils/runv3` (compare + context tests), engine packages.
Integration suite: `go test -tags integration ./engine/drm/` (mock wrapper).

## Reverse engineered

Derived from code inspection of legacy; consistent with available evidence but not independently runtime-observed.

- **Atmos socket-level stripe protocol** — `cbcsStripeDecrypt` framing (non-contiguous encrypted blocks per `runv2.cbcsStripeDecrypt`). Output correct; wire-level trace not performed for Atmos.
- **CBCS socket protocol for other tracks** — Wire-traced for one track (adamID 1488408568). Key rotation pattern (prefetch + one content key) assumed; number of key sessions for other tracks unknown.
- **DRM packet semantics** — Behavior of wrapper server on decryption failure (wrong adamID, expired lease, socket EOF) is inferred from code; not exercised at runtime.
- **Remaining legacy helper equivalence** — MP4 transformations, box filtering, subsample patterns: output matches for tested tracks; underlying behavior on edge-case inputs reverse engineered.

## Hypothesis (not yet exercised against the running system)

- **Byte-identical outputs** — ALAC/AAC/Atmos engine output not compared byte-for-byte against legacy output hashes.
- **Multi-storefront behavior** — Engine exercised only in "us"/"in" storefronts; behavior in other regions unknown.
- **Memory / FD leaks** — No pprof goroutine or FD snapshot taken under sustained workload.
- **Production-scale concurrency** — No load test with dozens/hundreds of concurrent sessions.
- **Long-duration stress** — Session TTL eviction not exercised at 4-hour boundary.
- **Engine CBCS path for other tracks** — Unknown: tracks with >2 key sessions, different rotation cadence, non-byterange playlists.
- **Engine CTR path for other tracks** — Exercised for one AAC track; tracks with multiple KIDs untested.
- **Connection recovery** — Behavior on wrapper server restart or mid-stream socket error not exercised.

## Remaining verification needed

These require interaction with Apple's actual service. They are not coding tasks.

1. **Atmos wire trace** — Capture socat trace of Atmos download through the engine and compare with legacy framing. Currently reverse engineered only.
2. **CBCS engine protocol trace** — Capture socat trace of engine CBCS path and feed to `cmd/protoinspect`. Compare KEY_SESSION structure with legacy trace.
3. **Byte-for-byte output comparison** — For same adamID: SHA-256 legacy output vs engine output, for ALAC, AAC, Atmos, MV. Use `cmd/mvcompare` framework.
4. **Key rotation edge cases** — Tracks with 0 or >2 key sessions; non-standard segment counts.
5. **Multi-storefront testing** — US, UK, JP, IN storefronts for at least ALAC and AAC.
6. **Resource leak validation** — pprof goroutine count + FD count before and after 100 concurrent engine sessions.
7. **Wrapper error signals** — Wrong adamID, expired lease, socket EOF: what does the wrapper return and does the engine propagate it correctly?
8. **Connection reuse** — Can one TCP socket serve multiple sequential tracks?
9. **MUT end-to-end (blocker for removing WebView login recommendation)** — Start with an
   empty session (`rm -rf <sessionDir>`), empty `media-user-token`/`storefront` in
   `config.yaml`, authenticate only via `POST /api/v1/drm/authenticate` + challenge.
   Verify: MUSIC_TOKEN and STOREFRONT_ID created; `POST /api/v1/playback` returns 201;
   `GET /api/v1/metadata/<id>`, `/lyrics/<id>`, `/artwork/<id>` return 200. Then restart
   the engine (without re-authenticating) and confirm playback still succeeds (session
   reuse path). Also verify **override precedence**: set `media-user-token: INVALID` in
   config while a valid session exists — playback should fail (Config wins over session,
   per the documented contract in `mediaUserToken()`).
10. **Storefront normalization corpus** — Confirm `NormalizeStorefrontID` handles all
    storefront formats produced in practice. Only one format observed so far
    (`"143467-2,31"`). Test against a second account or storefront to validate the
    split-on-`-` assumption is stable.

## Missing tooling

- **Protocol trace parser** — `cmd/protoinspect` — **COMPLETE**. Parses socat -x -v traces into KEY_SETUP /
  KEY_SESSION / SWITCH_KEYS / CLOSE / SUMMARY events. Uses `length=N` from direction headers for exact byte
  extraction. Runtime verified against 341 MB ALAC trace: 2171 samples, correct key session boundaries.
  Usage: `go run ./cmd/protoinspect <trace.txt> [--json]`
- **Protocol diff tool**: compares two traces (e.g., legacy vs engine for the same track) to surface divergence.
- **Regression fixtures for protocol captures**: synthetic traces for unit testing the parser.

## Known non-issues

- **ibhp format** (`37:ibhp256`, `38:ibhp64`): investigated 2026-07-02 — see
  `docs/investigations/2026-07-02-ibhp.md`. AES-128 identity-based HLS playback;
  key delivered via direct HTTPS GET to `play.itunes.apple.com/identityKeyRequest/…`.
  Not implemented: requires direct Apple server call (no wrapper path). Not needed:
  same content available via cbcp256/ctrp256.
- **Lyrics endpoint**: implemented 2026-07-02. `GET /api/v1/lyrics/{id}?sf=&format=lrc|ttml&type=lyrics|syllable-lyrics`.
  Defaults: sf=Config.Storefront, format=Config.LrcFormat (or "lrc"), type=Config.LrcType (or "lyrics").
  Note: lyrics availability is storefront-restricted by Apple; use the account's own storefront.
- **`/audio` default transcodes ALAC/Atmos → AAC** (investigated 2026-07-08). The
  default `GET /api/v1/playback/{id}/audio` pipes ALAC/Atmos through ffmpeg to AAC
  fMP4 for browser compatibility (Chromium has no ALAC/E-AC-3 decoder). Use
  `?raw=1` for the native codec (ALAC/E-AC-3), `?transcode=flac` for FLAC.
  A "partial ALAC delivery" scare (6.7 MB vs 41 MB) was a **measurement error**:
  6.7 MB is the *complete* 3:21 track at 256 kbps AAC (ffprobe 201.59s); `?raw=1`
  returns full native ALAC (41.6 MB, 201.57s). MP4Box "0 samples" is a fragmented
  `empty_moov` artifact, not corruption. No truncation bug exists. When
  benchmarking the DRM/streaming path, use `?raw=1` so ffmpeg time does not
  dominate (cmd/bench defaults to raw for this reason).

## Key files

- `engine/apple/provider.go` — `AssetFlavor` constants, `openSong` (AAC→CTR, ALAC/Atmos→CBCS),
  `openMV`, `makeTrackOpener`, `makeCBCSTrackOpener`, `fetchWebplayback` / `webplaybackURL` / `webplaybackAssetURL`
- `engine/hls/hls.go` — `OpenMaster`, `OpenMedia` (CTR), `OpenMediaCBCS` (FairPlay), `EncryptionInfo` (comma-split)
- `engine/fairplay/license.go` — `LicenseProvider`, `HLSSource`, Widevine CTR impl
- `engine/fairplay/cbcs.go` — `CBCSSource` — retry/cancel/stall runtime-verified by tests; socket framing and output reverse engineered (see docs/parity-matrix.md §1)
- `engine/archtest/arch_test.go` — import boundary enforcement
- `main.go` — token fix at startup: `Config.AuthorizationToken = "Bearer " + token`
- `engine/drm/process.go` — `ProcessBackend`; wrapper launched with `Setpgid` +
  `Pdeathsig`, Stop reaps the process group (`syscall.Kill(-pid, SIGKILL)`)
- `engine/drm/embedded.go` + `drm_embed.c` — `EmbeddedBackend`; container child
  is its own process group (`setpgid(0,0)` in `child_main`), `Stop()` group-kills
  it — see EmbeddedBackend process-group teardown above
- `engine/drm/fallback.go` — `fallbackBackend`: preferred backend + startup-only
  fallback (itself a `DRMBackend`, so DRMManager is unchanged)
- `engine/drm/policy.go` — `ResolveBackendPolicy`: pure, unit-tested backend
  selection logic (preferred/fallback/legacy-bool precedence)
- `engine/drm/sessionlock.go` — `SessionLock`: exclusive flock on the session dir
  (one engine instance owns the single-user session); acquired in `apiserver.Start`
- `apiserver.go` — calls `drm.ResolveBackendPolicy`/`buildDRMBackend` (backend
  policy → Embedded-preferred + Process-fallback default); session lock in Start/Stop;
  `APIServer` holds `session *drm.SessionManager`; `mediaUserToken()` / `storefront()`
  accessors read MUSIC_TOKEN / STOREFRONT_ID from session as canonical source
  (`Config.MediaUserToken` / `Config.Storefront` are overrides, not required when a
  session exists). Storefront normalization via `drm.NormalizeStorefrontID`. All handler
  call sites use these accessors — no startup init needed. Precedence contract:
  Config > session (documented in accessor comments). Deferred: `SessionProvider`
  interface to hide filesystem layout from the HTTP layer (not urgent — single impl).
- `cmd/startupbench/main.go` — statistically rigorous startup benchmark (the
  n=99 result above); `Pdeathsig` on its own engine subprocess + a signal
  handler so Ctrl-C/SIGTERM mid-run can't leak an engine/wrapper process
- `utils/manifest/manifest.go` — `FetchMaster`, `SelectVariant`, `ResolveMediaURL`
  (extracted from main.go `extractMedia`; shared by the legacy CLI and cmd/parity)
- `verification/harness/{engine,sampler}.go` — engine-subprocess lifecycle +
  child-PID metric sampler (used by cmd/bench)
- `apiserver.go` — additive diagnostics: `GET /api/v1/debug/runtime` (scalar
  runtime metrics), `GET /debug/pprof/*`; `?raw=1`/`?transcode=aac|flac` on /audio

## Diagnostic tools

- `cmd/hlscompare` — fetches and prints EXT-X-KEY from both webplayback and catalog
  paths for any adamID. Useful for checking: did Apple change the playlist format?
  which flavors exist? is a regression in Apple or our code?
  ```
  go run ./cmd/hlscompare <adamID> [storefront]
  ```
  Auto-fetches bearer token; reads MUT from `config.yaml`.

- `cmd/drminspect` — full DRM enumeration: every catalog variant + every webplayback asset
  for any adamID, with complete EXT-X-KEY attributes and comma-split analysis.
  ```
  go run ./cmd/drminspect <adamID> [storefront]
  ```

- `cmd/mvcompare` — structural comparison of `DecryptMP4` vs `DecryptMP4Streaming`.

- `cmd/playcheck` — end-to-end playback validation (ALAC/Atmos/AAC). Saves decrypted
  fMP4, metadata.json, and timings.json per run. Exit 0 = all checks passed.
  ```
  go run ./cmd/playcheck --alac  <adamID>
  go run ./cmd/playcheck --atmos <adamID>
  go run ./cmd/playcheck --aac   <adamID>
  ```

- `cmd/qacompare` — in-process benchmark comparing ProcessBackend vs
  EmbeddedBackend side-by-side (startup, GetAccount, GetM3U8, DialCBCS,
  first-fragment, playback-ready). `--cold-runs N` repeats independent cold
  starts for statistics (readiness-tolerant + wrapper teardown between runs);
  `--report` writes JSON+Markdown to verification/benchmarks; `--pprof` writes
  CPU/heap/goroutine profiles to verification/pprof.
  ```
  go run ./cmd/qacompare                                    # cold start only
  go run ./cmd/qacompare --adam <adamID> --format alac      # includes first-fragment
  go run ./cmd/qacompare --backend process --cold-runs 20 --report  # cold-start stats
  ```
  Note: hot-path (`--adam`) uses the config bearer token directly; if that is a
  placeholder use the engine path (cmd/bench) which auto-fetches via GetToken.

- `cmd/parity` — legacy-vs-engine output comparison (CLAUDE.md "Remaining
  verification #3"). Runs the legacy path (`ampapi`+`manifest.ResolveMediaURL`+
  `runv2.Run` for CBCS, `runv3.Run` for AAC) and the engine path for the same
  adamID, comparing SHA-256, MP4 structure, and wall time. Emits JSON+Markdown
  (schema `parity/v1`) with a PASS/STRUCTURAL/FAIL verdict.
  ```
  go run ./cmd/parity --adam <adamID> --format alac --repeat 3
  ```
  Status: compiles + gofmt/vet-clean; not yet exercised against a live session.

- `cmd/bench` — Engine-over-HTTP benchmark runtime. Runs the engine as a
  subprocess via `--api`, waits for readiness, drives HTTP scenarios, and samples
  the **child PID** (RSS/CPU/FDs from /proc, goroutines/heap/GC from
  `/api/v1/debug/runtime`) — honest engine-process telemetry, uncontaminated by
  the benchmark. Playback defaults to the **raw native codec** (`?raw=1`, measures
  CBCS/DRM/streaming); `--transcode` measures the browser AAC path (ffmpeg).
  Reusable lifecycle lives in `verification/harness/` (Start→WaitReady→drive→Stop).
  ```
  go run ./cmd/bench --duration 5s --conc 4                 # startup + HTTP load + shutdown
  go run ./cmd/bench --adam <adamID> --format alac          # + raw ALAC playback
  go run ./cmd/bench --adam <adamID> --format alac --transcode  # + AAC transcode path
  ```

- `cmd/startupbench` — statistically rigorous Process-vs-Embedded startup
  benchmark: randomized/interleaved run order (so temporal drift in Apple's
  servers doesn't bias one backend), Welch's t-test, Cohen's d, 95% CI. This is
  the tool behind the n=99 result below. Each run launches the engine as its
  own process group with `Pdeathsig: SIGKILL` (so a `kill -9` on startupbench
  itself can't orphan the engine — verified) and forces true single-backend
  isolation via an explicit `backend: {preferred: ...}` config with no
  fallback key (the legacy `use-embedded-backend` bool would silently let
  "ProcessBackend" runs fall through to auto's Embedded-preferred default —
  see the policy fix below). Requires `gonum.org/v1/gonum` (hence `go 1.24.0`
  in go.mod — gonum itself requires it).
  ```
  go run ./cmd/startupbench                      # 100 runs/backend
  go run ./cmd/startupbench --runs 500 --seed 42  # reproducible, more runs
  ```

## ProcessBackend vs EmbeddedBackend — benchmark result

**Runtime verified 2026-07-08** (single-user account, one backend at a time).

Startup, **n=99 per backend, interleaved/randomized order** (`cmd/startupbench`,
the strongest run): Process mean 10,764 ms / Embedded 10,803 ms → diff 38.7 ms,
**Welch's t = −0.086, p = 0.931**, Cohen's d = 0.012 (negligible), 95% CI
[−924, +847 ms]. Phase split is backend-independent (API-ready ~3.2 s both;
API→DRM ~7.5 s both). A smaller n=20 sequential run (`qacompare --cold-runs`)
agreed (p≈0.22). Both runs: **no statistically significant mean difference.**

**One nuance:** Embedded is more *consistent* — lower variance and no fat tail
(σ 2256 ms, p99 19.4 s) vs Process (σ 3848 ms, p99 31 s, occasional 20–31 s
outliers). Neither is faster on average; Embedded's startup is more predictable.

Hot-path (raw ALAC, isolated PID sampling): peak RSS 42.0 vs 40.1 MB, CPU 10.7%
vs 9.9%, heap peak 15.4 MB both — parity within noise. Both backends fork the
wrapper as a **separate child process** (Process via `exec`, Embedded via CGO
`fork`), so resource attribution is identical. (Absolute startup times vary with
network — the wrapper's Apple init dominates; only the *comparison* is stable.)

**Conclusion:** under the current architecture both backends execute the same
wrapper and DRM implementation, so backend choice has negligible impact on
steady-state performance; measured mean differences were not significant.
Artifacts (local, uncommitted): `verification/benchmarks/startup-*.{json,md}`
(n=99), `coldstart-*.{json,md}` (n=20), `final-analysis-backend-comparison-2026-07-07.md`.

**Decision (2026-07-08):** because performance is parity, the choice is by
architecture. Default is now **EmbeddedBackend preferred, ProcessBackend
automatic startup-fallback** (`backend.preferred`/`backend.fallback` config;
`fallbackBackend` composite). Rationale: Embedded is the simpler packaging (no
external launcher binary) and the future home for native DRM; Process stays a
transparent compatibility path. Fallback is startup-only (no hot-swap). An
exclusive **session lock** (`engine-session.lock`, flock) prevents two engine
instances from owning the single-user session. See
`docs/design/backend-supervisor.md`. NOTE: today both backends still fork the
same wrapper — the "simpler/one-process" benefit is realized only with future
native DRM.

**Open follow-up (recommended, not yet built):** startup *latency* parity is
established (n=99), but startup *success rate* is now the more relevant
question for keeping Embedded as the preferred default — cold-start requires
the CGO namespace/chroot dance to succeed on the host kernel (unprivileged
userns, nested PID namespace), which is a plausible axis of difference even
with identical latency when it works. A ~1000-startup-per-backend run with
`cmd/startupbench` (tracking failure/timeout counts, not just latency of
successful runs) would settle this. A complementary `cmd/reliability` tool —
repeated Start→Authenticate→GetAccount→GetManifest→Shutdown cycles measuring
success/failure/timeout/panic rates and resource drift (RSS, goroutines, FDs,
leaked processes) over hundreds–thousands of iterations — would answer "how
robust," a different question from startupbench's "how fast."

## wrapper-manager architecture (WorldObservationLog/wrapper-manager)

Cloned to `/home/Git Projects/wrapper-manager`. Key design decisions relevant to our engine:

**Instance lifecycle:**
- Each wrapper instance (`WrapperInstance`) gets unique ephemeral decrypt + M3U8 ports.
- `WrapperStart`/`WrapperInitial` launch the wrapper via `pty.Start` (pseudo-TTY required
  for the credential prompt flow); our `ProcessBackend` uses `exec.CommandContext` + stderr
  pipe. Both approaches are valid; pty is needed if the wrapper prompts interactively.

**Dispatcher — instance selection:**
- `selectInstance(adamId)` uses a three-tier priority:
  1. Same-adamID instance (TCP connection already has the key context loaded).
  2. Idle instance whose region covers the track's storefront.
  3. Random candidate from all region-compatible instances.
- Relevance for our engine: `CBCSSource` already follows this pattern — one TCP dial per
  stream (one adamID per connection), so key context is never shared across tracks.

**DecryptInstance — persistent TCP connection:**
- One `net.Conn` per `WrapperInstance`, opened once and reused for all fragments.
- `switchContext(adamId, key)` sends SwitchKeys (`{0,0,0,0}`) then the new adamID + keyURI
  before any decrypt — same protocol as `runv2.SwitchKeys` + `runv2.SendString`.
- Our `CBCSSource` correctly mirrors this: single `DialCBCS` per stream, key sent once,
  SwitchKeys sent only at key rotation boundaries (matching runv2 wire protocol).

**Throughput claim:** 40 MB/s per wrapper instance (from README). Not independently
measured for our engine. Consistent with ALAC output sizes observed (40 MB in ~2s).

**Multi-user scaling:** wrapper-manager pools instances across multiple Apple ID accounts.
For our single-user engine, one instance per DRM session is the correct model — already
implemented by DRMManager + ProcessBackend/EmbeddedBackend.

## AAC fetching route

Standard AAC (256 kbps) uses the CTR/Widevine path exclusively — no wrapper needed:

1. `engine/apple/provider.go openSong` → `webplaybackAssetURL(28:ctrp256)` → media playlist URL
2. `engine/hls/hls.go OpenMedia` → parses EXT-X-KEY `URI="data:;base64,[kid]"` → `EncryptionInfo{KIDBase64, URIPrefix}`
3. `engine/fairplay/license.go Open` → `runv3.AcquireKey` → Widevine L3 CDM challenge → Apple license endpoint → key bytes
4. `engine/fairplay/license.go HLSSource` → `runv3.DownloadSegments` → AIMD parallel download → decrypt in-process

The catalog `ExtendedAssetUrls.EnhancedHls` always uses CBCS (`skd://`) for all codecs
including AAC. Using the catalog URL for AAC would require the wrapper — regression.
The webplayback `28:ctrp256` path is the only wrapper-free AAC route and is already optimal.

The Widevine CDM keys (`DefaultPrivateKey`, `DefaultClientID`) live in
`utils/runv3/cdm/constants.go` (L3 keys from any Android device). These are the only
credentials the CTR path needs beyond the bearer token.

## EmbeddedBackend latency profile

**State file watching** (2026-07-07 fix):
EmbeddedBackend `embedWatchStateFile` was previously 250ms polling. Replaced with
inotify-based fsnotify watcher (same approach as ProcessBackend.watchStateFile).
Effect: auth state transition latency reduced from ~125ms average to ~0.
Fallback: if inotify unavailable (non-Linux), falls back to 250ms poll.

**Port probe intervals:**
- EmbeddedBackend: 500ms (faster than ProcessBackend's 5s because it's also used for initial startup detection)
- ProcessBackend: 5s (stall detection only — initial startup detected faster via forwardStderr)

**Other latency sources (not yet optimized):**
- CGO fork/exec: inherent; one-time cost per Start()
- `Authenticate()` wait: hard-coded `time.After(2 * time.Second)` before restart — could use `<-done` instead; low priority since Authenticate is rare
- `ensureRunning` startup timeout: 60s (DefaultRestartPolicy); actual wrapper startup is typically <5s

## Wrapper server constraint

Cannot make direct DRM calls to Apple servers. All key acquisition goes through the
wrapper server: HTTP endpoint for Widevine CTR (`runv3`), TCP socket for FairPlay
CBCS (`runv2`, `Config.DecryptM3u8Port`).

## Running tests

```bash
go test ./engine/...        # all engine unit + arch tests
go test -race ./engine/...  # race detector
go build .                  # full build check
```
