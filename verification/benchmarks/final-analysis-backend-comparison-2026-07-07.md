# ProcessBackend vs EmbeddedBackend — Final Benchmark Analysis

**Date:** 2026-07-07
**Engine commit:** (uncommitted working tree; qacompare cold-start fix + cmd/bench fixes applied)
**Machine:** Linux 7.1.2 (CachyOS), x86_64
**Wrapper:** wrapper/wrapper-rootless (Git LFS), single-user Apple account, storefront `in`
**Track:** adamID 1488408568 — *"Blinding Lights", The Weeknd* — ALAC 44100 Hz / 16-bit

> **Evidence policy:** every number below is **Runtime Verified** (measured this session)
> unless labelled otherwise. Where a metric was not measured, it says so explicitly.

---

## Environmental constraints (what shaped the methodology)

- **Single-user account** → only one wrapper may hold the session at a time. All
  runs are **one backend at a time**, with explicit wrapper teardown between
  iterations (kill + wait for port :30020 to free).
- **Network to Apple is slow and variable here** — measured CDN throughput
  0.2–1.5 MB/s; `init.itunes.apple.com` was intermittently unreachable early in
  the session, then recovered. A full ~41 MB ALAC track takes 25–200 s.
- **Bearer token in `config.yaml` is a placeholder.** The engine auto-fetches a
  real token via `ampapi.GetToken` at startup, so engine-driven playback works;
  `qacompare`'s hot-path (which reads the config token directly) cannot fetch
  the catalog. **Hot-path was therefore measured through the engine HTTP API
  (`cmd/bench`), not `qacompare`.**
- **Consequence:** hot-path streaming is **network-bound and identical for both
  backends** (same wrapper, same sockets, same CDN). The only metric that
  architecturally distinguishes the backends is **cold-start latency**
  (ProcessBackend `exec` subprocess vs EmbeddedBackend CGO `fork`).

---

## 1. Cold-start benchmark — the backend-differentiating metric

Metric: wall time from backend construction → FairPlay-ready. **20 independent
cold starts per backend**, one at a time, fresh wrapper each iteration.
Artifact: `coldstart-2026-07-07-171000.json` / `.md`.

| Backend | N | mean | median | p95 | p99 | min | max | σ |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| ProcessBackend  | 20 | **4.86 s** | 4.27 s | 7.03 s | 11.05 s | 3.27 s | 11.05 s | 1.77 s |
| EmbeddedBackend | 20 | **5.49 s** | 5.58 s | 8.10 s | 8.54 s | 3.52 s | 8.54 s | 1.46 s |

**Statistical significance:** mean gap = 0.63 s. Welch's t-test:
SE = √(1.77²/20 + 1.46²/20) = 0.51 s, t = 0.63/0.51 ≈ **1.23**, df ≈ 38 → **p ≈ 0.22**.
**Not statistically significant.** The gap is smaller than either standard
deviation. Cold-start is dominated by the wrapper's network-variable Apple
initialisation (`bag.xml` etc.), which swamps the exec-vs-fork cost.

**Nuance:** ProcessBackend has the lower central tendency (mean/median) but a
**fatter tail** (p99 11.05 s, max 11.05 s). EmbeddedBackend is **more consistent**
(σ 1.46 vs 1.77 s; p99 8.54 s; max 8.54 s). Neither difference is significant at n=20.

---

## 2. Hot-path benchmark — engine-over-HTTP, isolated PID sampling

One ALAC stream per backend through the engine HTTP API, sampling the **engine
child PID** (not the benchmark process). Artifacts:
`bench-http-2026-07-07-195131.json` (Process), `bench-http-2026-07-07-195322.json` (Embedded).

| Metric | ProcessBackend | EmbeddedBackend | Δ |
|---|--:|--:|--:|
| Engine HTTP ready | 3.38 s | 3.38 s | — |
| First byte (playback) | 6.16 s | 5.73 s | within noise |
| Bytes delivered | 6,701,176 | 6,701,176 | **identical** |
| Throughput | 0.2 MB/s | 0.2 MB/s | network-bound |
| Peak RSS | 42.0 MB | 40.1 MB | within noise |
| Avg CPU | 10.7 % | 9.9 % | within noise |
| Goroutines (start→final, peak) | 19→23, 25 | 16→23, 23 | within noise |
| Heap alloc peak | 15.4 MB | 15.4 MB | **identical** |
| GC collections | 48 | 53 | within noise |
| HTTP status-load (backend-agnostic) | 12,305 req/s, p99 0.4 ms | 13,947 req/s, p99 0.3 ms | parity |

**Key architectural finding:** EmbeddedBackend does **not** raise engine-PID RSS.
Both backends run the wrapper as a **separate child process** (ProcessBackend via
`exec`, EmbeddedBackend via CGO `fork`), so the wrapper's memory/CPU is outside
the engine PID in both cases. The hypothesis "Embedded RSS is higher because the
wrapper is in-process" is **disproven by measurement**.

**Note (measurement caveat, corrected):** `cmd/bench` hit the **default** `/audio`
endpoint, which for ALAC **transcodes to AAC via ffmpeg** for browser compat
(6,701,176 bytes = the *full* 3:21 track at 256 kbps AAC, ffprobe duration
201.59 s). An earlier draft misread this as a "partial delivery" by comparing
AAC bytes against lossless-ALAC bytes and trusting MP4Box's "0 samples" (a
fragmented-`empty_moov` artifact). Verified: `?raw=1` returns native ALAC
(41,630,658 bytes, 201.57 s) — both are complete. There is **no truncation bug**.
The transcode is identical for both backends, so the comparison is unaffected;
for raw-codec throughput numbers, `cmd/bench` should use `?raw=1`.

---

## 3. pprof captures

Steady-state + under-load profiles of the engine process, in `verification/pprof/`:
`engine-heap-2026-07-07-195524.pb`, `engine-goroutine-*.pb`, `engine-cpu-*.pb`
(10 s CPU profile under status-load).

---

## Final answers (measured)

| # | Question | Answer (evidence) |
|---|---|---|
| 1 | Which starts faster? | **No significant difference** (Process 4.86 s vs Embedded 5.49 s mean, p≈0.22). Process has lower median; Embedded has a tighter tail. |
| 2 | Which streams faster? | **Parity** — 0.2 MB/s both, identical bytes. Network-bound, not backend-differentiated. |
| 3 | Lower latency? | **Parity** — first-byte 6.16 s vs 5.73 s (single sample, within noise); HTTP status p99 0.3–0.4 ms both. |
| 4 | Less memory? | **Parity** — peak RSS 42.0 vs 40.1 MB; heap peak identical (15.4 MB). |
| 5 | Less CPU? | **Parity** — avg CPU 10.7 % vs 9.9 % during the stream. |
| 6 | Scales better? | **Not measured** — concurrency matrix deferred (network-bound, would not distinguish same-wrapper backends). Architecturally both spawn one wrapper child per context. |
| 7 | More stable? | **Slight edge: Embedded** on cold-start consistency (σ 1.46 vs 1.77 s; no fat tail). No goroutine/FD leaks seen in sampled windows for either. 5-min endurance not run. |
| 8 | Is EmbeddedBackend's complexity justified? | **Under the current architecture, both backends ultimately execute the same wrapper and DRM implementation, so backend choice has negligible impact on steady-state performance; measured cold-start differences were not statistically significant.** Its only real advantage is **packaging** (no external wrapper binary at runtime) — a deployment benefit, not a speed/efficiency one. This phrasing stays true even if the architecture later changes. |
| 9 | Should ProcessBackend remain default? | **Yes.** Parity performance, simpler (no CGO), slightly better cold-start central tendency. No measured reason to switch. |
| 10 | Dominant bottlenecks after backend differences removed? | (a) **Wrapper network init** (~3–5 s of cold start, `bag.xml`/Apple calls). (b) **CDN download throughput** (0.2–1.5 MB/s here) for hot-path. (c) Wrapper **readiness race** (~10–30 s to bind :30020; the eager `GetAccount` dials before it's up and logs a harmless "connection refused"). The engine HTTP layer itself is **not** a bottleneck (12–14k req/s, sub-ms). |

---

## Tooling issues found & fixed this session

1. **`qacompare` cold-start was broken** — `GetAccount` dialed :30020 once before
   the wrapper bound it and failed with "connection refused" (no retry). Fixed
   with a readiness-tolerant `awaitReady` + a `--cold-runs N` repetition mode
   (measurement-only; no engine behavior change).
2. **`cmd/bench` playback decoded `"id"`** but the API returns `"sessionId"`;
   also added `WaitDRMReady` (poll `drm/status` for `fairplay=ready`) before the
   playback scenario.

## Engine bug found and FIXED this session (not a backend difference)

**`ProcessBackend.Stop` orphaned the wrapper's forked worker.** wrapper-rootless
forks a `main` worker that holds :10020/:20020/:30020; Stop SIGKILLed only the
direct child, orphaning the worker to init (leaking ports + the single-user
session on every shutdown). Fixed by launching the wrapper in its own process
group (`Setpgid`) and SIGKILLing the negative PID on Stop (commit `4edc1fd`),
with a negative-control-verified regression test (`2d6d2e5`).

## Retracted: "partial ALAC delivery" was a measurement error

Initially flagged as a deterministic truncation (6.7 MB of 41 MB). It is **not a
bug** — the default `/audio` endpoint transcodes ALAC→AAC (6.7 MB = full 3:21
track at 256 kbps; ffprobe 201.59 s), and `?raw=1` returns full native ALAC
(41.6 MB, 201.57 s). The misread came from MP4Box reporting 0 samples on a
fragmented `empty_moov` mp4 and from comparing AAC bytes to lossless-ALAC bytes.

## Not run (and why)

- **100-sequential / 5-min endurance / concurrency 1–20:** deferred by plan.
  At 0.2–1.5 MB/s each ALAC stream is 25–200 s; these tiers would run for hours
  and measure network variance, not backend differences (same wrapper for both).
  Recommended only if a targeted signal (leak, retry storm) is suspected.
- **AAC/Atmos hot-path per backend:** ALAC (CBCS) exercises the wrapper path that
  involves the backend; AAC (CTR/Widevine) bypasses the wrapper entirely so is
  backend-agnostic by construction. Atmos is CBCS like ALAC — expected parity.
