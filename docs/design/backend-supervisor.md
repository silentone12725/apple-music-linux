# Backend selection, fallback, and the future BackendSupervisor

_Status: partially implemented (2026-07-08). This documents what exists today and
the agreed target architecture for when the backends diverge._

## Context

The engine has two DRM backends behind one interface (`engine/drm.DRMBackend`):

- **EmbeddedBackend** — CGO launcher (`drm_embed_start` → `fork()+execve()`) that
  sets up a user+mount-namespace chroot and execs the wrapper. No external
  `wrapper-rootless` binary needed at runtime (rootfs/ still required).
- **ProcessBackend** — `exec`s the external `wrapper-rootless` launcher binary,
  which itself sets up the container and forks the `main` DRM worker.

**Both fork a separate wrapper process tree today** — neither runs the DRM
implementation in-process. The difference is packaging (embedded launcher vs
external launcher binary), not runtime topology.

A rigorous startup benchmark (n=99 per backend, interleaved; `cmd/startupbench`)
found **no statistically significant performance difference** (Welch p=0.931,
Cohen's d=0.012). EmbeddedBackend is slightly more *consistent* (lower startup
variance, no fat tail). So backend choice is an **architecture** decision, not a
speed one.

## Decision

Prefer **EmbeddedBackend**, with an **automatic startup fallback** to
ProcessBackend — Embedded is the simpler packaging (one fewer shipped binary) and
the natural home for a future native-DRM implementation; ProcessBackend remains a
transparent compatibility path. The frontend/API never know which is active.

> **Reliability gate (open):** performance is parity, so the deciding factor for
> the *default* is now startup **success rate**, not latency. Before treating
> Embedded-preferred as permanent, run a high-N reliability benchmark (≈1000
> startups per backend: failure / timeout / container / crash counts —
> `cmd/startupbench` is the tool). If Embedded's start-success rate is at least as
> good as Process, keep it preferred; if worse, set `preferred: process` until
> native DRM exists. The automatic fallback makes preferring Embedded low-risk in
> the meantime (an Embedded start failure transparently yields Process).

## Implemented today (bounded change)

1. **Backend policy** (`structs.BackendPolicy`, config `backend.preferred` /
   `backend.fallback`). Default and recommended value: **`preferred: auto`** —
   picks the best available backend (today Embedded, else Process); its order
   evolves as backends are added (native → embedded → process) with no config
   change. Explicit `embedded`/`process` are also accepted. The legacy
   `use-embedded-backend` bool is honored when the policy is unset.

2. **`fallbackBackend`** (`engine/drm/fallback.go`) — a composite `DRMBackend`
   that starts the preferred backend and, if its `Start()` returns an error,
   transparently starts the fallback. **Selection happens once** (first Start);
   crash-restarts reuse the chosen backend (covered by
   `TestFallbackBackend_RestartReusesActive`). DRMManager is unchanged and unaware
   two implementations exist. The composite **emits a DRMEvent** on selection
   (the DRM package does not log directly) and exposes `BackendSelection`
   (`ActiveName`/`FallbackReason`); `GET /api/v1/drm/status` returns
   `backend.selected` + `backend.fallbackReason` so an operator can see that (and
   why) a fallback occurred even though it was transparent to clients.

3. **Exclusive session lock** (`engine/drm/sessionlock.go`) — an `flock` on
   `<session-dir>/engine-session.lock`, held for the engine's lifetime. A second
   engine instance refuses to start (`Start()` errors), preventing two processes
   from owning the single-user Apple session (SQLite races, concurrent token
   refresh, wrapper session corruption).

   > **Ownership note:** the lock currently lives in `engine/drm` for proximity to
   > the session directory, but it is **not DRM-specific** — it protects
   > credentials, cookies, tokens, and account ownership, not decryption.
   > Architecturally it belongs above DRM, owned by `SessionManager` (Engine →
   > SessionManager → SessionLock → DRMManager). The implementation can stay put
   > for now; move it when SessionManager is promoted to own session state.

### Scope boundary (intentionally NOT built)

- **No runtime health-monitored hot-swap.** Fallback triggers only on a `Start()`
  error, i.e. "this backend can't run on this system." A backend that starts but
  later hangs/never-readies is handled by the existing crash/restart path, not by
  swapping backends.
- **No reverse failover** (re-trying the preferred backend after N minutes).
- **No `CredentialManager` owning the DB handle** — the wrapper owns mpl_db
  (inside the chroot); the engine owns only the exclusive lock.

The rationale: today both backends launch the *same* wrapper against the *same*
session, so runtime failover would switch launch mechanisms without changing the
DRM implementation underneath. The value isn't there yet.

## Target architecture (build when the backends diverge)

Trigger: when EmbeddedBackend gains a **native DRM** path that replaces the
wrapper, the two backends become meaningfully different and runtime failover
starts to matter.

```
Engine
 ├── API Server
 ├── Playback Manager
 ├── BackendSupervisor         ← new: selection, health, failover, restart policy
 │     ├── EmbeddedBackend      (native DRM, eventually)
 │     ├── ProcessBackend       (wrapper compatibility layer)
 │     └── CredentialManager    (owns DB handle + exclusive lock + migrations)
 └── Session Manager
```

`BackendSupervisor` would own: backend selection, health monitoring, runtime
hot-swap failover (Embedded↔Process), reverse failover, restart policy, and
credential ownership — leaving `DRMManager` to focus purely on DRM operations.

Config evolves naturally without frontend/API changes:

```yaml
backend: { preferred: embedded, fallback: process }   # today
backend: { preferred: native,   fallback: embedded }  # after native DRM
backend: { preferred: native,   fallback: process }   # eventually
```

## Note on the architecture freeze

CLAUDE.md freezes the engine architecture. This change is **preference-driven**
(the benchmark showed parity, not a defect), so it was made as a bounded,
consciously-approved relaxation: no public interface changed, DRMManager is
untouched, and the additions (`fallbackBackend`, `SessionLock`, policy config)
are additive. The full `BackendSupervisor` above remains deferred.
