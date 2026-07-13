# Legacy Decommissioning Plan

> **Not yet executable.** This document defines the preconditions and sequence
> for safely removing legacy code.  No legacy code should be deleted until every
> precondition in the relevant phase is satisfied and runtime-verified.

---

## Dependency graph (engine → legacy)

```
engine/fairplay/cbcs.go
    → utils/runv2  (ReadInitSegment, ReadNextFragment, TransformInit,
                    SanitizeInit, FilterSbgpSgpd, DecryptFragment,
                    cbcsFullSubsampleDecrypt, cbcsStripeDecrypt,
                    SwitchKeys, SendString, Close, ErrTimeout)

engine/fairplay/license.go
    → utils/runv3  (AcquireKey, DownloadSegments, DecryptMP4Streaming)

engine/apple/provider.go
    → utils/ampapi (GetSongRespContext, GetMusicVideoRespContext)

main.go, tui.go, stream.go, scheduler.go
    → utils/runv2  (Run, ReadInitSegment, etc.)
    → utils/runv3  (Run, RunStream, GetWebplayback, ExtMvData,
                    ExtMvDataResumable, StreamMvData, SelectVariantForCodec)
    → utils/ampapi (all)
    → utils/lyrics (all)
    → utils/task   (all)
```

The engine depends on runv2 for **all CBCS decryption**, and on runv3 for
**key acquisition, segment downloading, and CTR streaming**.  Neither package
can be deleted while the engine is in use.

---

## Dead code (candidates for removal — no callers found)

| Symbol | Location | Evidence | Action |
|--------|----------|----------|--------|
| `downloadSegmentCached` | `utils/runv3/cache.go:253` | `git grep` finds no callers outside the package; `downloadSegment` already checks cache inline | Remove after confirming no external callers |
| `RunStream` | `utils/runv3/runv3.go:366` | Called only from `main.go:1012` (`--mode=stream`); no other callers | Mark as deprecated; keep for now |
| `StreamTrackData` | `utils/runv3/runv3.go:750` | Not called from main.go or engine (confirmed by grep) | Remove after confirming no external callers |
| `filterResponse` (runv2) | `utils/runv2/runv2.go:333` | Only called from `parseMediaPlaylist`; `parseMediaPlaylist` only called from `runAttempt` | Keep — called transitively |

**Confirming dead code before removal:**

```bash
git grep -n "downloadSegmentCached" .    # expect only its definition
git grep -n "StreamTrackData" .          # expect only its definition
```

---

## Phase 1: Remove downloadSegmentCached (safe, zero risk)

**Precondition:** `git grep "downloadSegmentCached"` returns only the definition
in `utils/runv3/cache.go`.

**Action:** Delete `downloadSegmentCached` and the `// downloadSegmentCached wraps`
comment block.  No callers → no behavioral change.

**Test:** `go test ./...` passes.

---

## Phase 2: Remove StreamTrackData (low risk)

**Precondition:** `git grep "StreamTrackData"` returns only its definition.

**Action:** Delete `StreamTrackData` from `utils/runv3/runv3.go`.  This function
uses `selectHighestBandwidthVariant` and `Run(mvmode=true)` — if those have no
other callers after this deletion, they can be removed in the same commit.

**Test:** `go test ./...` passes; `go build ./...` passes.

---

## Phase 3: Internalise runv2 CBCS functions into engine/fairplay

**Current state:** `engine/fairplay/cbcs.go` imports `utils/runv2` and calls
11 functions directly.  This creates an import dependency on legacy code.

**Goal:** Move the CBCS decryption functions needed by the engine into
`engine/fairplay/` so that `engine` no longer depends on `utils/runv2`.

**Functions to move:**

| Function | Destination | Notes |
|----------|-------------|-------|
| `ReadInitSegment` | `engine/fairplay/cbcs.go` or new `engine/fairplay/mp4.go` | Already improved (C1); sync with runv3/stream.go version |
| `ReadNextFragment` | Same | |
| `TransformInit` | Same | Requires `mp4.DecryptTrackInfo` — internal type |
| `SanitizeInit` | Same | |
| `FilterSbgpSgpd` | Same | |
| `DecryptFragment` | Same | Calls `cbcsFullSubsampleDecrypt` + `cbcsStripeDecrypt` |
| `cbcsFullSubsampleDecrypt` | Same (unexported) | |
| `cbcsStripeDecrypt` | Same (unexported) | |
| `cbcsDecryptRaw`, `cbcsDecryptSample`, `cbcsDecryptSamples` | Same (unexported) | |
| `SwitchKeys`, `SendString`, `Close` | Same | Simple wire helpers |
| `ErrTimeout` | Keep in runv2 (exported; used by legacy) | Re-export from engine if needed |

**Preconditions:**
1. Engine CBCS path runtime-verified with socat trace (OQ2 from parity matrix)
2. Byte-for-byte ALAC output comparison: legacy vs engine hashes match (OQ3)
3. `TestReadInitSegment_*` suite passes in new location
4. `TestClose_*`, `TestSwitchKeys_*`, `TestSendString_*` pass in new location

**Risk:** Medium.  The functions are non-trivial (especially `DecryptFragment`
and the stripe decrypt).  Move one function at a time, test after each.

**Test:** `go test -race ./engine/...` passes; ALAC output hash unchanged.

---

## Phase 4: Internalise runv3 AcquireKey and DownloadSegments into engine

**Current state:** `engine/fairplay/license.go` imports `utils/runv3` and calls
`AcquireKey`, `DownloadSegments`, and `DecryptMP4Streaming` directly.

**Goal:** Move these three functions (and their dependencies: `aimdLimiter`,
`downloadAndAssemble`, `downloadSegment`, `SegmentCache`, `fileWriter`,
`DecryptMP4Streaming`, `readInitSegment`, `readNextFragment`, `isNoSencBox`,
`ErrNoSencBox`) into the engine.

**Preconditions:**
1. All OQ items from parity matrix resolved (runtime-verified)
2. `go test -race ./...` clean
3. No callers of runv3 from engine after move (arch test updated)

**Risk:** High.  The AIMD downloader, cache, and streaming decrypt are
well-exercised but depend on the mp4ff and m3u8 libraries.

---

## Phase 5: Deprecate utils/runv2 Run and runAttempt for CLI

**Current state:** `main.go` still calls `runv2.Run` for ALAC downloads.

**Options:**
- (A) Keep runv2 for CLI (legacy layer remains); engine uses own copy from Phase 3
- (B) Migrate CLI to engine HTTP API and delete runv2

Option A is safer and requires no CLI rewrite.  Recommended.

**Precondition:** Phase 3 complete (engine no longer imports runv2).

---

## Phase 6: Final legacy removal (long-term, after full parity)

**Sequence:**
1. Delete `utils/runv2` after: (a) CLI migrated to engine, OR (b) CBCS functions
   moved to engine and CLI rewritten to call engine API.
2. Delete `utils/runv3` after: AcquireKey/DownloadSegments moved to engine AND
   CLI migrated away from runv3.Run/RunStream/ExtMvData.

**Gate:** Each deletion requires:
- `git grep <package>` confirms zero callers
- `go build ./...` succeeds
- `go test -race ./...` passes
- Runtime smoke test: ALAC, AAC, Atmos, MV all play correctly

---

## What must NOT be deleted until runtime-verified

| Do NOT delete until | Reason |
|---------------------|--------|
| `cbcsStripeDecrypt` | Atmos wire path not independently verified (OQ1) |
| `runv2.DecryptFragment` | Engine calls this directly; no independent impl |
| `runv3.DownloadSegments` | Engine calls this directly; AIMD logic non-trivial |
| Anything in `utils/runv3/resume.go` | No engine equivalent; MV resume needed by CLI |
| `runv3.ExtMvDataResumable` | Same as above |

---

## Removal readiness summary

| Package / Symbol | Callers | Removal readiness |
|-----------------|---------|------------------|
| `utils/runv2` (entire) | engine/fairplay, main.go, stream.go | After Phase 3 + CLI migration |
| `utils/runv3` (entire) | engine/fairplay, main.go | After Phase 4 + CLI migration |
| `runv3.downloadSegmentCached` | None found | **Ready now** (Phase 1) |
| `runv3.StreamTrackData` | None found | **Ready now** (Phase 2) |
| `runv3.RunStream` | main.go:1012 only | After main.go migrated |
| `runv3.Run` | main.go × many, stream.go | After CLI migrated |
| `runv3.DecryptMP4` | main.go, ExtMvData | After CLI migrated |
| `runv3.GetWebplayback` | main.go via Run/RunStream | After CLI migrated |
| `utils/ampapi` (entire) | engine/apple, main.go | Not until CLI migrated |
| `utils/lyrics` (entire) | engine (apiserver), main.go | Not until CLI migrated |
| `scheduler.go` | main.go | Not until CLI migrated |
| `stream.go` | main.go, tui.go | Not until CLI migrated |
