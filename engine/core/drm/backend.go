package drm

import (
	"context"
	"net"
)

// DRMBackend is the swappable transport interface.
// Phase 1: ProcessBackend (subprocess + TCP sockets, existing wrapper binary).
// Phase 2: EmbeddedBackend (CGO, wrapper compiled into the engine binary).
// The interface above DRMBackend is identical in both phases.
//
// Neither DRMManager nor any code above it knows which backend is active.
// Transport details (ports, file paths, connection management) are
// entirely internal to the backend implementation.
//
// Lifecycle contract:
//
//	Start() — launch the backend. The backend determines whether authentication
//	          is needed: if a session exists, the wrapper runs immediately;
//	          if not, it fires AuthSource.Challenge(ChallengeCredentials) and
//	          blocks until credentials are provided.
//
//	Stop()  — shutdown. Used for both "stop for restart" and "stop for logout".
//	          Does NOT clear mpl_db — SessionManager owns that.
//
// Authentication is entirely challenge-driven and backend-owned:
//
//	Start()
//	  └─ wrapper → credentialHandler → Challenge(ChallengeCredentials)
//	                                        └─ AuthCoordinator → credentials
//	  └─ wrapper → credentialHandler → Challenge(ChallengeTwoFactor)
//	                                        └─ AuthCoordinator → 2FA code
//
// The manager never decides "should we authenticate?" — that belongs to the
// backend and ultimately to storeservicescore. The manager supplies credentials
// (via AuthCoordinator) when asked, and signals intent by calling Start().
type DRMBackend interface {
	// Start launches the backend. Used for both session reuse and fresh
	// authentication — the wrapper itself decides whether credentials are
	// needed by calling AuthSource.Challenge(ChallengeCredentials) if no
	// valid mpl_db session is present.
	//
	// Authentication is entirely challenge-driven and backend-owned:
	//   Start()
	//     └─ wrapper → credentialHandler → Challenge(ChallengeCredentials)
	//                                           └─ AuthCoordinator → credentials
	//     └─ wrapper → credentialHandler → Challenge(ChallengeTwoFactor)
	//                                           └─ AuthCoordinator → 2FA code
	//
	// DRMManager.Login sets credentials via AuthCoordinator.SetCredentials
	// before calling Start, so the backend can answer a ChallengeCredentials
	// request immediately without blocking.
	Start(ctx context.Context, cfg BackendConfig) error

	// Authenticate ensures an authenticated DRM context exists. This is an
	// intent, not a mechanism: the backend decides how to satisfy it.
	//
	//   ProcessBackend: restarts the subprocess. The wrapper checks mpl_db on
	//                   startup; valid session → runs immediately; no session →
	//                   fires credentialHandler → Challenge(ChallengeCredentials).
	//   EmbeddedBackend (Phase 2): calls wrapper_authenticate() in-place.
	//   Future backends: may reuse an already-authenticated runtime or delegate
	//                   to an OS keychain. The mechanism is opaque to callers.
	//
	// After Authenticate returns nil, the backend is ready to decrypt.
	// DRMManager.Authenticate sets credentials via AuthCoordinator before calling
	// this, so the backend can answer Challenge(ChallengeCredentials) immediately.
	Authenticate(ctx context.Context) error

	// Stop shuts down the backend. Used for both restart and logout.
	// Does NOT clear mpl_db — SessionManager owns session lifecycle.
	Stop() error

	// Running reports whether the backend is currently operational.
	Running() bool

	// SetAuthSource registers the AuthSource that the backend calls when
	// the wrapper needs any authentication input (credentials, 2FA, device
	// approval). Must be called before Start.
	SetAuthSource(AuthSource)

	// DRM operations — transport details invisible to callers.
	Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error)
	GetM3U8(ctx context.Context, adamID uint64) (string, error)
	GetAccount(ctx context.Context) (AccountInfo, error)

	// DialCBCS opens one CBCS decryption connection (satisfies fairplay.CBCSDialer).
	// Phase 1: returns a TCP connection to the wrapper's port 10020.
	// Phase 2 (EmbeddedBackend): returns an in-process net.Conn backed by CGO.
	DialCBCS(ctx context.Context) (net.Conn, error)

	// Events returns a channel that emits DRMEvents as backend state changes.
	// The channel is closed when the backend is stopped.
	Events() <-chan DRMEvent
}

// BackendConfig carries the configuration the backend needs to start.
// It is identical for all backend implementations (ProcessBackend, EmbeddedBackend).
// Transport-specific details (executable path, TCP addresses, ports) are owned
// by each backend implementation and never appear here.
type BackendConfig struct {
	// BaseDir is the directory containing mpl_db/ and derived token files.
	// Typically: /data/data/com.apple.android.music/files (inside chroot).
	BaseDir string

	// DeviceInfo is the 9-field slash-separated device identifier string
	// passed to storeservicescore. Uses the backend default if empty.
	DeviceInfo string

	// Credentials is the single-use Apple ID for a fresh login. When set,
	// ProcessBackend passes --login email:password to the wrapper so that
	// storeservicescore performs a full authentication instead of resuming
	// the existing mpl_db session.
	//
	// DRMManager.Authenticate() sets this for the duration of one Start() call.
	// It is never stored in b.cfg — crash restarts always use session-reuse
	// (no --login) because mpl_db will have been written by the initial login.
	Credentials Credentials
}

// ─── Authentication challenge model ──────────────────────────────────────────

// AuthSource is called by the backend when authentication input is needed.
// ProcessBackend calls Challenge when the wrapper-state file transitions to
// LOGIN or WAITING_2FA (detected via inotify). EmbeddedBackend calls Challenge
// directly from the CGO callback registered with credentialHandler.
type AuthSource interface {
	// Challenge is called when the backend needs input to proceed.
	// It blocks until SubmitChallenge is called on the AuthCoordinator
	// or ctx is cancelled. The returned string is the reply to the challenge.
	Challenge(ctx context.Context, req AuthChallenge) (reply string, err error)
}

// AuthChallenge is a backend-neutral structured authentication prompt.
// New Apple authentication challenges (device approval, biometric, etc.)
// are handled by adding new AuthChallengeType values and Metadata keys
// without changing the interface.
type AuthChallenge struct {
	Type        AuthChallengeType `json:"type"`
	Title       string            `json:"title"`
	Description string            `json:"description,omitempty"`
	// Metadata carries structured per-challenge-type fields.
	// Examples:
	//   ChallengeTwoFactor:      {"issuer": "Apple ID"}
	//   ChallengeDeviceApproval: {"device": "MacBook Pro", "timeout": "120"}
	Metadata map[string]string `json:"metadata,omitempty"`
}

// AuthChallengeType identifies the kind of authentication prompt.
type AuthChallengeType int

const (
	// ChallengeCredentials requests Apple ID email and password.
	// Reply format: "email\x00password" (null-byte separated).
	ChallengeCredentials AuthChallengeType = iota

	// ChallengeTwoFactor requests a 6-digit 2FA code.
	// Reply: the 6-digit string, e.g. "123456".
	ChallengeTwoFactor

	// ChallengeDeviceApproval requests approval from a trusted device.
	// Reply: "approved" or "denied".
	// Metadata: {"device": "<device name>", "timeout": "<seconds>"}
	ChallengeDeviceApproval
)

func (t AuthChallengeType) String() string {
	return [...]string{"credentials", "two_factor", "device_approval"}[t]
}

func (t AuthChallengeType) MarshalJSON() ([]byte, error) {
	b := []byte(`"` + t.String() + `"`)
	return b, nil
}

// ─── Credentials ─────────────────────────────────────────────────────────────

// Credentials holds Apple ID login information for a single authentication
// attempt. The engine stores this only in memory; it is never persisted.
type Credentials struct {
	Email    string
	Password string
}
