# Engine → Legacy Dependency Audit

> **Purpose:** Classify every remaining import of legacy packages from the
> engine layer.  Each dependency is labelled:
>
> - **ISL** — Intentional Shared Library: functionality is correct, stable,
>   and the engine deliberately reuses it.  No action needed today.
> - **TB** — Temporary Bridge: legacy code that works but should eventually
>   move into the engine.  Removal requires preconditions (see
>   `docs/decommissioning.md` Phase 3/4).
> - **TD** — Technical Debt: code that duplicates functionality already
>   available in the engine or stdlib, kept only for backward compatibility.
> - **RM** — Removable Now: no callers outside the package; safe to delete.
>
> **Findings from `git grep` as of 2026-07-02.**
> Re-run `grep -rn "main/utils/" engine/ --include="*.go"` to keep current.

---

## engine/fairplay/cbcs.go → utils/runv2

| Call site | Symbol | Classification | Rationale |
|-----------|--------|---------------|-----------|
| `cbcs.go:69` | `runv2.ErrTimeout` | ISL | Sentinel shared between `stallDetector` and legacy `TimedResponseBody`; both fire the same cancel cause. Could be a local `var` in cbcs.go but sharing it avoids divergence. |
| `cbcs.go:169` | `runv2.Close` | TB | Writes 5-byte CLOSE signal to TCP socket. Simple (5 zero bytes); move to `engine/fairplay` when Phase 3 executes. |
| `cbcs.go:178` | `runv2.ReadInitSegment` | TB | Reads ftyp+moov from fMP4 stream, up to 64 boxes (C1-fixed). Functionally identical to `runv3/stream.go:readInitSegment`; consolidate in engine during Phase 3. |
| `cbcs.go:185` | `runv2.TransformInit` | TB | Strips DRM boxes from moov. Non-trivial; verified working (ALAC output correct). Move to engine in Phase 3. |
| `cbcs.go:191` | `runv2.SanitizeInit` | TB | Removes duplicate codec boxes. Move with TransformInit in Phase 3. |
| `cbcs.go:200` | `runv2.ReadNextFragment` | TB | Reads moof+mdat fragment. Move to engine in Phase 3. |
| `cbcs.go:213` | `runv2.SwitchKeys` | TB | Writes 4-byte SWITCH_KEYS. Trivial; runtime-verified by `TestSwitchKeys_*`. Move to engine in Phase 3. |
| `cbcs.go:216,218,220` | `runv2.SendString` | TB | Writes 1-byte length + string. Trivial; runtime-verified by `TestSendString_*`. Move in Phase 3. |
| `cbcs.go:223` | `runv2.DecryptFragment` | TB | Full CBCS per-fragment decrypt dispatcher (full-subsample and stripe paths). Non-trivial; contains `cbcsFullSubsampleDecrypt` and `cbcsStripeDecrypt`. Wire-verified for ALAC (full-subsample); Atmos stripe path is reverse engineered. Move to engine in Phase 3 after Atmos wire verification. |

**Summary (cbcs.go → runv2):** 0 ISL (the ErrTimeout could become local), 9 TB.  
All 9 are candidates for Phase 3 of the decommissioning plan.  
`runv2` cannot be deleted while any of these remain in `engine/fairplay/cbcs.go`.

---

## engine/fairplay/license.go → utils/runv3

| Call site | Symbol | Classification | Rationale |
|-----------|--------|---------------|-----------|
| `license.go:52` | `runv3.AcquireKey` | ISL | Context-aware Widevine key acquisition via wrapper server. Runtime-verified (AAC, MV). The engine's sole interface to the CTR key path. Encapsulates resty, Widevine CDM, PSSH — not trivial to move. |
| `license.go:67` | `runv3.DecryptMP4Streaming` | ISL | Fragment-by-fragment streaming CTR/CBCS decrypt. Runtime-verified (AAC, MV). The streaming pipeline the engine depends on. |
| `license.go:88` | `runv3.DownloadSegments` | ISL | Context-aware AIMD parallel segment download with on-disk cache. Runtime-verified (C2 fix; cancellation tests). The engine's sole segment download interface. |

**Summary (license.go → runv3):** 3 ISL, 0 TB.  
These are the core CTR path. `runv3` cannot be deleted while any of these remain.  
Phase 4 of the decommissioning plan moves them into the engine when/if the decision is made to self-contain the engine.  Until then, treating them as ISL is correct.

---

## engine/apple/provider.go → utils/ampapi

| Call site | Symbol | Classification | Rationale |
|-----------|--------|---------------|-----------|
| `provider.go:91` | `ampapi.GetSongRespContext` | ISL | Context-aware Apple Music catalog lookup. Runtime-verified. The engine's correct entry point for song metadata. |
| `provider.go:188` | `ampapi.GetMusicVideoRespContext` | ISL | Same, for MV catalog. Runtime-verified. |

**Summary (provider.go → ampapi):** 2 ISL.  
`ampapi` provides clean, context-aware catalog access. The engine is correct to use it directly. No change needed.

---

## Overall classification

| Package | ISL | TB | TD | RM | Total call sites |
|---------|-----|----|----|----|-----------------:|
| `utils/runv2` | 0¹ | 9 | 0 | 0 | 9 |
| `utils/runv3` | 3 | 0 | 0 | 0 | 3 |
| `utils/ampapi` | 2 | 0 | 0 | 0 | 2 |
| **Total** | **5** | **9** | **0** | **0** | **14** |

¹ `runv2.ErrTimeout` could become a local `var` in `cbcs.go` to eliminate the import; left as ISL because the shared sentinel reduces divergence risk until Phase 3.

---

## Retirement checklist

### Before `utils/runv2` can be deleted from the engine:

- [ ] Phase 3 complete: 9 TB symbols moved into `engine/fairplay/`
- [ ] Atmos stripe decrypt (`cbcsStripeDecrypt`) wire-verified
- [ ] ALAC output hash: engine == legacy for same adamID
- [ ] `go test -race ./engine/fairplay/` passes with runv2 no longer imported
- [ ] `go build ./...` succeeds
- [ ] `engine/archtest` updated to ban `engine → utils/runv2`

### Before `utils/runv3` can be deleted from the engine:

- [ ] Phase 4 complete: 3 ISL symbols moved into `engine/fairplay/`
- [ ] AIMD downloader + cache + streaming decrypt self-contained in engine
- [ ] CTR path (AAC, MV) verified end-to-end with moved code
- [ ] `go test -race ./engine/fairplay/` passes with runv3 no longer imported
- [ ] `engine/archtest` updated to ban `engine → utils/runv3`

### Before `utils/ampapi` can be deleted from the engine:

- [ ] CLI fully migrated to engine HTTP API (or engine gets its own catalog client)
- [ ] `engine/apple` no longer imports `utils/ampapi`
- [ ] No callers outside `main.go` / `tui.go`

---

## No action needed now

None of the 14 call sites represent bugs or incorrectness.  
The 9 TB items represent the Phase 3 work that is explicitly deferred until:
1. Atmos wire trace performed
2. Byte-for-byte ALAC/Atmos output comparison passes
3. Decision is made to self-contain the engine (vs keeping legacy layer)
