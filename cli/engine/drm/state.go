package drm

import (
	"encoding/json"
	"strings"
	"time"
)

// DRMState is a multi-dimensional snapshot of the DRM subsystem.
// Every axis is an independent state dimension.
// The manager may be Ready while the process is Stopped (lazy start);
// FairPlay may be Initializing while Authentication is LoggedIn.
//
// CapabilityState is NOT embedded here. Capabilities are derived properties
// (FairPlay ready + subscription tier), not state transitions. They belong
// at the DRMSnapshot level, alongside State.
type DRMState struct {
	Manager        ManagerState  `json:"manager"`
	Process        ProcessState  `json:"process"`
	Authentication AuthState     `json:"authentication"`
	FairPlay       FairPlayState `json:"fairplay"`
	Session        SessionState  `json:"session"`
	Recovery       RecoveryState `json:"recovery"`
}

// ─── ManagerState — DRMManager engine lifecycle ──────────────────────────────

// ManagerState describes the DRMManager's own lifecycle, which is distinct
// from the backend process lifecycle. The manager may be Ready while the
// backend process is Stopped (lazy start design).
type ManagerState int

const (
	ManagerUnknown      ManagerState = iota // 0
	ManagerDisabled                         // 1 (DRM not configured)
	ManagerInitializing                     // 2 (Starting up)
	ManagerReady                            // 3 (Healthy)
	ManagerShuttingDown                     // 4
	ManagerFailed                           // 5
)

func (s ManagerState) String() string {
	return [...]string{"unknown", "disabled", "initializing", "ready", "shutting_down", "failed"}[s]
}

func (s ManagerState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── ProcessState — backend process health ───────────────────────────────────

// ProcessState describes the health of the backend process (ExternalBackend
// subprocess or EmbeddedBackend CGO runtime). It is independent of whether
// the DRMManager itself is configured.
type ProcessState int

const (
	ProcessUnknown ProcessState = iota
	ProcessStopped
	ProcessStarting
	ProcessRunning
	ProcessFailed
)

func (s ProcessState) String() string {
	return [...]string{"unknown", "stopped", "starting", "running", "failed"}[s]
}

func (s ProcessState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── AuthState — authentication flow ────────────────────────────────────────

// AuthState tracks where the authentication flow is. AuthChallenging means
// the backend has emitted an AuthChallenge and is waiting for a reply via
// SubmitChallenge. The DRMSnapshot.Challenge field carries the challenge
// detail when this state is active.
type AuthState int

const (
	AuthUnknown AuthState = iota
	AuthLoggedOut
	AuthLoggingIn
	AuthChallenging // waiting for AuthChallenge reply
	AuthLoggedIn
	AuthFailed
)

func (s AuthState) String() string {
	return [...]string{"unknown", "logged_out", "logging_in", "challenging", "logged_in", "failed"}[s]
}

func (s AuthState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── FairPlayState — FairPlay initialisation ─────────────────────────────────

type FairPlayState int

const (
	FairPlayUnknown FairPlayState = iota
	FairPlayInitializing
	FairPlayReady
	FairPlayFailed
)

func (s FairPlayState) String() string {
	return [...]string{"unknown", "initializing", "ready", "failed"}[s]
}

func (s FairPlayState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── SessionState — persistent session validity ──────────────────────────────

// SessionState reflects what the engine knows about session persistence.
// SessionValid means there is a valid mpl_db AND a successful DRM operation
// has been observed recently (or GetAccount succeeds). Filesystem checks
// alone are insufficient; behavioral confirmation is required.
type SessionState int

const (
	SessionUnknown SessionState = iota
	SessionEmpty
	SessionValid
	SessionExpired
)

func (s SessionState) String() string {
	return [...]string{"unknown", "empty", "valid", "expired"}[s]
}

func (s SessionState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── RecoveryState — lease recovery ─────────────────────────────────────────

// RecoveryState mirrors the recovery state machine in main.cpp.
// During RecoveryRefreshing, the backend gates new decryption requests
// (is_recovery_active returns 1 inside the C code).
type RecoveryState int

const (
	RecoveryUnknown RecoveryState = iota
	RecoveryIdle
	RecoveryScheduled
	RecoveryRefreshing
	RecoveryFailed
)

func (s RecoveryState) String() string {
	return [...]string{"unknown", "idle", "scheduled", "refreshing", "failed"}[s]
}

func (s RecoveryState) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// ─── CapabilityState — feature availability ──────────────────────────────────

// CapabilityState decouples feature availability from process state.
// The backend may be Running while FairPlay is still Initializing, in which
// case CBCS is false even though the process is up.
//
// ALAC, Atmos, and HiRes additionally require CBCS to be true and the
// account to have the appropriate subscription tier.
type CapabilityState struct {
	CBCS  bool `json:"cbcs"`
	ALAC  bool `json:"alac"`
	Atmos bool `json:"atmos"`
	HiRes bool `json:"hiRes"`
}

// ─── DRMSnapshot — immutable point-in-time picture ───────────────────────────

// DRMSnapshot is a complete, immutable point-in-time picture of the DRM
// subsystem. All DRM events publish a full snapshot so that clients
// reconnecting to SSE immediately have a complete current picture without
// needing to replay event history.
//
// The Message field is a human-readable log line forwarded from the backend's
// stderr. It is never parsed by the state machine; state always comes from
// the State field.
type DRMSnapshot struct {
	State        DRMState        `json:"state"`
	Capabilities CapabilityState `json:"capabilities"`        // derived; at snapshot level, not state
	Challenge    *AuthChallenge  `json:"challenge,omitempty"` // non-nil only when Auth == AuthChallenging
	Timestamp    time.Time       `json:"timestamp"`
	Message      string          `json:"message,omitempty"` // log text; never parsed for state
}

// ─── State file parsing ───────────────────────────────────────────────────────

// stateFileStrings maps the string values written by write_drm_state() in
// main.c to ProcessState and FairPlayState values.  The wrapper writes these
// strings to {BaseDir}/drm-state.
var stateFileStrings = map[string]stateFileResult{
	"STARTING":              {Process: ProcessStarting, FairPlay: FairPlayUnknown},
	"LOGIN":                 {Process: ProcessStarting, FairPlay: FairPlayUnknown, Auth: AuthLoggingIn},
	"WAITING_2FA":           {Process: ProcessStarting, FairPlay: FairPlayUnknown, Auth: AuthChallenging},
	"INITIALIZING_FAIRPLAY": {Process: ProcessRunning, FairPlay: FairPlayInitializing, Auth: AuthLoggedIn},
	"RUNNING":               {Process: ProcessRunning, FairPlay: FairPlayReady, Auth: AuthLoggedIn},
	"RECOVERY":              {Process: ProcessRunning, FairPlay: FairPlayReady, Recovery: RecoveryRefreshing},
	"FAILED":                {Process: ProcessFailed},
	"STOPPED":               {Process: ProcessStopped},
}

type stateFileResult struct {
	Process  ProcessState
	FairPlay FairPlayState
	Auth     AuthState
	Recovery RecoveryState
}

// ParseStateFile interprets the content of the drm-state file written by
// main.c's write_drm_state() and returns the corresponding sub-states.
// Returns zero values if the content is unrecognised.
func ParseStateFile(content string) stateFileResult {
	return stateFileStrings[strings.TrimSpace(content)]
}
