package drm

// DRMEvent wraps a DRMSnapshot.
//
// Every state transition emits a full DRMSnapshot rather than a delta.
// This means clients reconnecting to SSE immediately receive a complete
// picture of current state without needing to replay event history.
//
// The Message field in the snapshot carries human-readable log text forwarded
// from the backend's stderr. It is never parsed for state; state always comes
// from the State field.
//
// IntentionalStop is set true when the process exited because Stop() was
// called (cancel() fired). It is false for crashes. DRMManager uses this to
// skip handleCrash when a stop is part of a planned credential relaunch.
type DRMEvent struct {
	Snapshot    DRMSnapshot
	Intentional bool // true when Stop() caused the exit, false for crashes
}

// DRMEventType is a semantic label for state transitions.
// The SSE layer always sends a full DRMSnapshot regardless of type; event types
// are used internally by DRMManager and backends to route and handle transitions.
//
// Snapshots are the source of truth. Events describe transitions between them.
type DRMEventType int

const (
	// ── Lifecycle ──────────────────────────────────────────────────────────
	EventStarted   DRMEventType = iota // backend process/runtime came up
	EventStopped                       // clean stop
	EventCrashed                       // unexpected exit; DRMManager will restart
	EventRecovered                     // restart succeeded after crash

	// ── Authentication ─────────────────────────────────────────────────────
	EventCredentialRequested // wrapper needs Apple ID + password
	EventTwoFactorRequested  // wrapper needs 2FA code
	EventAuthenticated       // authentication completed successfully
	EventAuthenticationFailed

	// ── Lease / FairPlay ───────────────────────────────────────────────────
	EventLeaseRefreshing // recovery worker is refreshing the FairPlay context
	EventLeaseRecovered  // lease refresh succeeded
	EventLeaseLost       // lease refresh failed permanently

	// ── Session ────────────────────────────────────────────────────────────
	EventSessionLoaded  // existing mpl_db session loaded at startup
	EventSessionExpired // Apple revoked or invalidated the session

	// ── Log ────────────────────────────────────────────────────────────────
	EventLogLine // human-readable stderr line; never parsed for state
)
