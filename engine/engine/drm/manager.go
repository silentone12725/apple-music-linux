package drm

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

// DefaultRestartPolicy is used when no policy is specified.
var DefaultRestartPolicy = RestartPolicy{
	MaxCrashRestarts: 5,
	RestartBackoff:   []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second},
	StartupTimeout:   60 * time.Second,
	AuthTimeout:      120 * time.Second,
}

// RestartPolicy controls how DRMManager responds to backend crashes.
type RestartPolicy struct {
	// MaxCrashRestarts is the maximum number of consecutive crash restarts
	// before DRMManager enters ManagerFailed. 0 = unlimited.
	MaxCrashRestarts int

	// RestartBackoff is the wait between successive crash restarts.
	// Indexed by crash count; last entry is reused for all subsequent crashes.
	RestartBackoff []time.Duration

	// StartupTimeout is how long Start() waits for the backend to reach
	// ProcessRunning before returning an error.
	StartupTimeout time.Duration

	// AuthTimeout is how long Login() waits for the backend to reach
	// FairPlayReady after authentication completes.
	AuthTimeout time.Duration
}

// EventSink receives DRM events to forward to the SSE bus.
// The apiserver implements this by calling eventBus.emit("drm", snapshot).
type EventSink func(snapshot DRMSnapshot)

// ── Backend compatibility matrix ──────────────────────────────────────────────
//
// Every capability must pass on ProcessBackend before EmbeddedBackend begins.
// EmbeddedBackend is not "done" until every row is verified to behave identically
// to ProcessBackend for the same track and storefront.
//
//	Capability          ProcessBackend   EmbeddedBackend
//	─────────────────── ──────────────── ────────────────
//	Authenticate        ✓ verified       planned
//	Session reuse       ✓ verified       planned
//	GetAccount          □ pending        planned
//	GetM3U8             □ pending        planned
//	CBCS decrypt        □ pending        planned
//	ALAC playback       □ pending        planned
//	Atmos playback      □ pending        planned
//	Crash recovery      □ pending        planned
//	Fresh auth (2FA)    □ pending        planned
//
// ─────────────────────────────────────────────────────────────────────────────

// DRMManager is the engine's DRM coordinator. It:
//   - Owns the DRMBackend lifecycle (start, stop, restart, crash recovery)
//   - Owns the authentication flow (Login, 2FA, Logout)
//   - Owns the SessionManager
//   - Implements DRMProvider for the playback layer
//   - Forwards DRMEvents to the SSE bus via EventSink
//
// DRMManager is the only type in the engine that knows about the DRMBackend.
// PlaybackManager only sees DRMProvider.
type DRMManager struct {
	backend  DRMBackend
	session  *SessionManager
	auth     *AuthCoordinator
	sink     EventSink
	cfg      BackendConfig
	policy   RestartPolicy
	snapshot DRMSnapshot
	mu       sync.RWMutex

	// crash restart state
	crashCount int
}

// NewDRMManager creates a DRMManager with the given backend.
// sink receives every DRMSnapshot and forwards it to SSE.
func NewDRMManager(backend DRMBackend, session *SessionManager, sink EventSink, cfg BackendConfig, policy RestartPolicy) *DRMManager {
	m := &DRMManager{
		backend: backend,
		session: session,
		cfg:     cfg,
		policy:  policy,
		sink:    sink,
	}
	m.auth = NewAuthCoordinator(func(snap DRMSnapshot) {
		m.mergeAndEmit(snap)
	})
	backend.SetAuthSource(m.auth)
	m.setManagerState(ManagerReady)
	// Reflect session state at startup so GET /api/v1/drm/status shows the
	// correct state immediately — before any playback request fires ensureRunning.
	if session.HasSession() {
		m.snapshot.State.Session = SessionValid
		m.snapshot.State.Authentication = AuthLoggedIn
	} else {
		m.snapshot.State.Session = SessionEmpty
		m.snapshot.State.Authentication = AuthLoggedOut
	}
	go m.watchEvents()
	return m
}

// ── DRMProvider implementation ────────────────────────────────────────────────

// Decrypt auto-starts the backend if a session exists, then decrypts.
func (m *DRMManager) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	if err := m.ensureRunning(ctx); err != nil {
		return DecryptResponse{}, err
	}
	resp, err := m.backend.Decrypt(ctx, req)
	if err == nil {
		m.session.RecordSuccess()
	}
	return resp, err
}

// GetM3U8 auto-starts the backend if a session exists.
func (m *DRMManager) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	if err := m.ensureRunning(ctx); err != nil {
		return "", err
	}
	url, err := m.backend.GetM3U8(ctx, adamID)
	if err == nil {
		m.session.RecordSuccess()
	}
	return url, err
}

// GetAccount auto-starts the backend if a session exists.
func (m *DRMManager) GetAccount(ctx context.Context) (AccountInfo, error) {
	if err := m.ensureRunning(ctx); err != nil {
		return AccountInfo{}, err
	}
	info, err := m.backend.GetAccount(ctx)
	if err == nil {
		m.session.RecordSuccess()
	}
	return info, err
}

// ensureRunning auto-starts the backend (session reuse path) if not running.
// Returns ErrNotAuthenticated if no session exists.
// Never authenticates — that is Authenticate()'s job.
func (m *DRMManager) ensureRunning(ctx context.Context) error {
	if m.backend.Running() {
		return nil
	}
	if !m.session.HasSession() {
		return ErrNotAuthenticated
	}
	startCtx, cancel := context.WithTimeout(ctx, m.policy.StartupTimeout)
	defer cancel()

	if err := m.backend.Start(startCtx, m.cfg); err != nil {
		return err
	}
	// Session DB is present — reflect that immediately so the UI shows the
	// correct state without waiting for a wrapper-emitted event.
	m.mergeAndEmit(DRMSnapshot{
		State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
		Message: "session reuse — mpl_db present",
	})
	return nil
}

// ── Authentication intent API ─────────────────────────────────────────────────

// Login stores credentials and calls backend.Start(). Authentication is
// challenge-driven: if the wrapper needs credentials, it fires
// AuthSource.Challenge(ChallengeCredentials), and AuthCoordinator returns the
// stored values immediately. The manager never decides "should we authenticate?"
// — that belongs to the backend and ultimately to storeservicescore.
//
// Both session-reuse and fresh-login paths use Start(). The difference is
// purely in whether credentials are stored in AuthCoordinator:
//   - HasSession(): no credentials needed; wrapper uses existing mpl_db.
//   - !HasSession(): credentials are stored; wrapper's credentialHandler
//     fires Challenge(ChallengeCredentials) and AuthCoordinator replies.
func (m *DRMManager) Authenticate(ctx context.Context, creds Credentials) error {
	m.auth.SetCredentials(creds) // stored in AuthCoordinator; used if challenged
	m.setManagerState(ManagerInitializing)

	loginCtx, cancel := context.WithTimeout(ctx, m.policy.AuthTimeout)
	defer cancel()

	// Stop any running backend first so the fresh Start below gets a clean slate.
	// This also kills any adopted wrapper (one we didn't launch ourselves) so its
	// port is released before we try to start a fresh process with --login.
	if m.backend.Running() {
		_ = m.backend.Stop()
	}
	// Pass credentials in BackendConfig so ProcessBackend can append --login to
	// the wrapper argv. Credentials are NOT stored in m.cfg — they are consumed
	// by this one Start() call and the field is zero in all future restarts.
	loginCfg := m.cfg
	loginCfg.Credentials = creds
	authErr := m.backend.Start(loginCtx, loginCfg)
	if authErr != nil {
		m.setManagerState(ManagerFailed)
		return fmt.Errorf("authenticate: %w", authErr)
	}
	// If a session DB already exists the wrapper resumes it silently.
	// Reflect that immediately so the UI shows the correct state.
	if m.session.HasSession() {
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
			Message: "session reuse — mpl_db present",
		})
	}
	m.setManagerState(ManagerReady)
	return nil
}

// SubmitChallenge delivers a challenge reply (2FA code, device approval, etc.)
// from the browser. Call this after receiving a DRM SSE event with
// Authentication == AuthChallenging.
func (m *DRMManager) SubmitChallenge(_ context.Context, reply string) error {
	return m.auth.SubmitReply(reply)
}

// Logout stops the backend and clears the session.
// Does NOT call backend.Logout() — Stop() is sufficient since ProcessBackend
// is stateless at the process level. SessionManager.ClearSession removes
// the persisted mpl_db and derived files.
func (m *DRMManager) Logout(ctx context.Context) error {
	m.setManagerState(ManagerShuttingDown)
	if err := m.backend.Stop(); err != nil {
		return fmt.Errorf("logout stop: %w", err)
	}
	if err := m.session.ClearSession(); err != nil {
		return fmt.Errorf("clear session: %w", err)
	}
	m.mu.Lock()
	m.snapshot.State = DRMState{
		Manager:        ManagerReady,
		Process:        ProcessStopped,
		Authentication: AuthLoggedOut,
		FairPlay:       FairPlayUnknown,
		Session:        SessionEmpty,
		Recovery:       RecoveryUnknown,
	}
	m.snapshot.Capabilities = CapabilityState{}
	snap := m.snapshot
	m.mu.Unlock()

	m.sink(snap)
	return nil
}

// ClearSession clears the session without stopping the backend.
// The backend must be stopped before calling this, otherwise storeservicescore
// will re-create the session files.
func (m *DRMManager) ClearSession() error {
	return m.session.ClearSession()
}

// DialCBCS implements fairplay.CBCSDialer. It auto-starts the backend if a
// valid session exists, then opens one CBCS decryption connection.
// Called by fairplay.CBCSSource for each ALAC or Atmos stream attempt.
func (m *DRMManager) DialCBCS(ctx context.Context) (net.Conn, error) {
	if err := m.ensureRunning(ctx); err != nil {
		return nil, err
	}
	return m.backend.DialCBCS(ctx)
}

// Shutdown stops the backend process without clearing the session.
// Call this on clean server exit so the session DB persists for the next start.
// Unlike Logout, Shutdown does not remove mpl_db or any session files.
func (m *DRMManager) Shutdown() {
	m.setManagerState(ManagerShuttingDown)
	if m.backend.Running() {
		_ = m.backend.Stop()
	}
}

// Status returns the current DRM snapshot.
func (m *DRMManager) Status() DRMSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshot
}

// watchEvents drains the backend event channel and updates the DRMManager
// state accordingly. Handles crash detection and restart policy.
func (m *DRMManager) watchEvents() {
	for ev := range m.backend.Events() {
		snap := ev.Snapshot

		// Update process state.
		if snap.State.Process != 0 {
			m.mu.Lock()
			m.snapshot.State.Process = snap.State.Process
			m.mu.Unlock()
		}
		// Update FairPlay state.
		if snap.State.FairPlay != 0 {
			m.mu.Lock()
			m.snapshot.State.FairPlay = snap.State.FairPlay
			m.mu.Unlock()
			if snap.State.FairPlay == FairPlayReady {
				m.updateCapabilities()
			}
		}
		// Update auth state.
		if snap.State.Authentication != 0 {
			m.mu.Lock()
			m.snapshot.State.Authentication = snap.State.Authentication
			m.mu.Unlock()
		}
		// Update recovery state.
		if snap.State.Recovery != 0 {
			m.mu.Lock()
			m.snapshot.State.Recovery = snap.State.Recovery
			m.mu.Unlock()
		}
		// Update session state.
		if snap.State.Session != 0 {
			m.mu.Lock()
			m.snapshot.State.Session = snap.State.Session
			m.mu.Unlock()
		}

		// Crash detection: process stopped unexpectedly → apply restart policy.
		// Skip when IntentionalStop is set — the stop was planned (e.g. a
		// credential-triggered relaunch inside ProcessBackend). Calling
		// handleCrash in that case races the relaunch with wrong args.
		if snap.State.Process == ProcessStopped && !ev.Intentional {
			go m.handleCrash()
		}

		m.mergeAndEmit(snap)
	}
}

func (m *DRMManager) handleCrash() {
	m.mu.Lock()
	count := m.crashCount
	m.crashCount++
	m.mu.Unlock()

	if m.policy.MaxCrashRestarts > 0 && count >= m.policy.MaxCrashRestarts {
		m.setManagerState(ManagerFailed)
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Manager: ManagerFailed, Process: ProcessFailed},
			Message: fmt.Sprintf("backend crashed %d times; giving up", count),
		})
		return
	}

	idx := count
	if idx >= len(m.policy.RestartBackoff) {
		idx = len(m.policy.RestartBackoff) - 1
	}
	delay := m.policy.RestartBackoff[idx]

	m.mergeAndEmit(DRMSnapshot{
		State:   DRMState{Process: ProcessStopped},
		Message: fmt.Sprintf("backend crashed (attempt %d); restarting in %v", count+1, delay),
	})

	time.Sleep(delay)

	ctx, cancel := context.WithTimeout(context.Background(), m.policy.StartupTimeout)
	defer cancel()

	if err := m.backend.Start(ctx, m.cfg); err != nil {
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Process: ProcessFailed},
			Message: fmt.Sprintf("restart failed: %v", err),
		})
	}
}

func (m *DRMManager) updateCapabilities() {
	m.mu.Lock()
	defer m.mu.Unlock()
	fp := m.snapshot.State.FairPlay == FairPlayReady
	// Capabilities are at the Snapshot level (derived), not inside State.
	m.snapshot.Capabilities = CapabilityState{
		CBCS:  fp,
		ALAC:  fp,
		Atmos: fp,
		HiRes: fp, // account subscription check deferred to Phase 2
	}
}

// ── State helpers ─────────────────────────────────────────────────────────────

func (m *DRMManager) setManagerState(s ManagerState) {
	m.mu.Lock()
	m.snapshot.State.Manager = s
	m.mu.Unlock()
}

// mergeAndEmit merges non-zero fields from snap into the current snapshot,
// updates the timestamp, and forwards to the EventSink.
func (m *DRMManager) mergeAndEmit(snap DRMSnapshot) {
	m.mu.Lock()
	if snap.State.Manager != 0 {
		m.snapshot.State.Manager = snap.State.Manager
	}
	if snap.State.Process != 0 {
		m.snapshot.State.Process = snap.State.Process
	}
	if snap.State.Authentication != 0 {
		m.snapshot.State.Authentication = snap.State.Authentication
	}
	if snap.State.FairPlay != 0 {
		m.snapshot.State.FairPlay = snap.State.FairPlay
	}
	if snap.State.Recovery != 0 {
		m.snapshot.State.Recovery = snap.State.Recovery
	}
	if snap.State.Session != 0 {
		m.snapshot.State.Session = snap.State.Session
	}
	if snap.Challenge != nil {
		m.snapshot.Challenge = snap.Challenge
	} else if snap.State.Authentication != AuthChallenging {
		m.snapshot.Challenge = nil
	}
	m.snapshot.Timestamp = time.Now()
	m.snapshot.Message = snap.Message
	out := m.snapshot
	m.mu.Unlock()

	if m.sink != nil {
		m.sink(out)
	}
}
