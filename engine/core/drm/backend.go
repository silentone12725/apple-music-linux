package drm

import (
	"context"
	"net"
)

// DRMBackend is the swappable transport interface. The sole implementation
// is HybrisBackend, which loads libdrm-native.so in-process via CGO.
//
// Neither DRMManager nor any code above it knows which backend is active.
// Transport details are entirely internal to the backend implementation.
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
	// HybrisBackend calls drm_lib_shutdown + drm_lib_init for credential refresh.
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
	GetProgressiveMVURL(ctx context.Context, adamID uint64) (url string, downloadKey string, err error)
	DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error)

	// DialCBCS opens one CBCS decryption connection (satisfies fairplay.CBCSDialer).
	// HybrisBackend returns an in-process net.Pipe() backed by hybrisCBCSServe.
	DialCBCS(ctx context.Context) (net.Conn, error)

	// Events returns a channel that emits DRMEvents as backend state changes.
	// The channel is closed when the backend is stopped.
	Events() <-chan DRMEvent
}

// BackendConfig carries the configuration the backend needs to start.
// Transport-specific details are owned by each backend and never appear here.
type BackendConfig struct {
	// BaseDir is the directory containing mpl_db/ and derived token files.
	// Typically: /data/data/com.apple.android.music/files (inside chroot).
	BaseDir string

	// DeviceInfo is the 9-field slash-separated device identifier string
	// passed to storeservicescore. Uses the backend default if empty.
	DeviceInfo string

	// Credentials is the single-use Apple ID for a fresh login. When set,
	// the backend passes them to drm_lib_init for a full auth; session-reuse
	// restarts leave this empty — mpl_db was written by the initial login.
	//
	// DRMManager.Authenticate() sets this for the duration of one Start() call.
	// It is never stored in m.cfg — crash restarts always use session-reuse.
	Credentials Credentials
}

// ─── Authentication challenge model ──────────────────────────────────────────

// AuthSource is called by the backend when authentication input is needed.
// HybrisBackend calls Challenge directly from the CGO callback registered
// with drm_lib_config_t.auth_cb (hybrisBridgeAuth).
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
