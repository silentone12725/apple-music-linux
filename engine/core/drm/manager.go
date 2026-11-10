package drm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// crashResetWindow: a backend that stays up this long after a start is healthy,
// so the next crash starts a fresh MaxCrashRestarts budget (the budget counts
// consecutive crash-loops, not crashes over the process lifetime).
const crashResetWindow = 2 * time.Minute

// DefaultRestartPolicy is used when no policy is specified.
var DefaultRestartPolicy = RestartPolicy{
	MaxCrashRestarts: 5,
	RestartBackoff:   []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second},
	StartupTimeout:   60 * time.Second,
	AuthTimeout:      7 * time.Minute, // covers the 5-minute wait for a verification code
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

// ── AdamplayBackend capability status ──────────────────────────────────────────
//
//	Capability        Status
//	──────────────── ───────
//	Authenticate     ✓ verified
//	Session reuse    ✓ verified
//	GetAccount       ✓ verified
//	GetM3U8          ✓ verified
//	CBCS decrypt     ✓ verified
//	ALAC playback    ✓ verified
//	Atmos playback   ✓ verified
//	Crash recovery   ✓ verified
//	Fresh auth (2FA) ✓ verified
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
	// closed is set once by Shutdown. From then on the manager state is absorbing at shutting_down: a
	// crash handler or login that was already in flight must not flip it back to ready or failed.
	closed atomic.Bool

	// warming ensures one background backend start at a time when the web session appears.
	warming   atomic.Bool
	signingIn atomic.Bool // a sign-in (Authenticate) is in progress

	// authSem (one slot) is held by every backend start and by a sign-out once the
	// sign-in it aborted has returned: concurrent starts would Stop/Start the backend
	// under each other, and a sign-out must never stop or wipe under a start.
	authSem chan struct{}
	// signOutSem serialises sign-out requests. gateMu guards gate and cleanup; it
	// is held only for decisions, never across a wait or a backend call.
	signOutSem     chan struct{}
	gateMu         sync.Mutex
	gate           gateState
	cleanup        *cleanupOp
	timing         signOutTiming
	restartPending atomic.Bool

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
	restartMu  sync.Mutex // serialises concurrent handleCrash goroutines
	// emitMu is held from snapshot copy to sink so events reach clients in the
	// order the state changed; copying under mu but emitting after unlocking
	// let two goroutines deliver an older snapshot after a newer one.
	emitMu       sync.Mutex
	lastStart    atomic.Int64 // UnixNano of the last successful backend start
	shutdownCtx  context.Context
	shutdownStop context.CancelFunc

	// getWebMUT, when set, returns the current Media-User-Token from the web
	// player session. Called during NoteWebSession to give the backend a fresh
	// token so it can write MUSIC_TOKEN and retry hybris FairPlay init.
	getWebMUT func() string
}

// NewDRMManager creates a DRMManager with the given backend.
// sink receives every DRMSnapshot and forwards it to SSE.
func NewDRMManager(backend DRMBackend, session *SessionManager, sink EventSink, cfg BackendConfig, policy RestartPolicy) *DRMManager {
	shutCtx, shutStop := context.WithCancel(context.Background())
	m := &DRMManager{
		backend:      backend,
		session:      session,
		cfg:          cfg,
		policy:       policy,
		sink:         sink,
		shutdownCtx:  shutCtx,
		shutdownStop: shutStop,
		authSem:      make(chan struct{}, 1),
		signOutSem:   make(chan struct{}, 1),
		timing:       defaultSignOutTiming,
	}
	m.auth = NewAuthCoordinator(func(snap DRMSnapshot) {
		m.mergeAndEmit(snap)
	})
	backend.SetAuthSource(m.auth)
	m.setManagerState(ManagerReady)
	// Complete a sign-out left on disk (interrupted, or recorded by the main process)
	// before reading session state, so the next start never shows a stale session.
	// Bounded: if it does not finish in time the gate stays closed and the pass
	// completes in the background.
	m.gateMu.Lock()
	var replay *cleanupOp
	if session.hasPending() {
		replay = m.startCleanupLocked()
	}
	m.gateMu.Unlock()
	if replay != nil {
		if err := waitOp(context.Background(), replay, m.timing.ReplayWait); err != nil {
			slog.Warn("drm: pending sign-out not complete at start", "err", err)
			m.snapshot.Message = "sign-out incomplete"
		}
	}
	// Reflect session state at startup so GET /api/v1/drm/status shows the
	// correct state immediately — before any playback request fires ensureRunning.
	if !backend.Running() {
		// The backend starts lazily; "stopped" is accurate, "unknown" made a healthy idle engine look broken.
		m.snapshot.State.Process = ProcessStopped
	}
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

// GetProgressiveMVURL auto-starts the backend and fetches a progressive MV URL
// and the associated downloadKey (may be empty) via port 40020.
func (m *DRMManager) GetProgressiveMVURL(ctx context.Context, adamID uint64) (url string, downloadKey string, err error) {
	if err = m.ensureRunning(ctx); err != nil {
		return "", "", err
	}
	url, downloadKey, err = m.backend.GetProgressiveMVURL(ctx, adamID)
	if err == nil {
		m.session.RecordSuccess()
	}
	return url, downloadKey, err
}

// DecryptItunSamples auto-starts the backend and decrypts itun-encrypted
// samples via port 50020. The decryptor must have been initialized by a prior
// GetProgressiveMVURL call for the same adamID.
func (m *DRMManager) DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
	if err := m.ensureRunning(ctx); err != nil {
		return nil, err
	}
	return m.backend.DecryptItunSamples(ctx, adamID, samples)
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

// SetWebSession wires in the media-user-token the web player gives the engine. With it, a profile that
// only ever signed in on the web has a session: it is what ensureRunning and the eager start look for,
// and what the backend reads when there are no credential files.
func (m *DRMManager) SetWebSession(fn func() (mut, storefront string)) {
	m.session.SetWebSession(fn)
	if b, ok := m.backend.(interface{ SetAccountFallback(func() AccountInfo) }); ok {
		b.SetAccountFallback(func() AccountInfo {
			mut, sf := fn()
			return AccountInfo{MusicToken: mut, StorefrontID: sf}
		})
	}
}

// SetMUTSource registers a function that returns the current Media-User-Token
// from the web player. Called once at startup from the APIServer so NoteWebSession
// can give the backend a fresh token for the MUSIC_TOKEN fallback path.
func (m *DRMManager) SetMUTSource(fn func() string) {
	m.getWebMUT = fn
}

// NoteWebSession is called when the web player supplies or changes its token. When the app is signed in
// (session-ready), it reports the session as valid and, if the backend is not running yet, starts it in the
// background, or retries FairPlay with the fresh token. A web token alone does nothing: after a sign-out
// the page keeps sending it, and it must not sign the engine back in.
func (m *DRMManager) NoteWebSession() {
	if m.closed.Load() || !m.session.HasSession() {
		return
	}
	m.mu.RLock()
	// While a sign-in runs (or waits for its code) the page's token says nothing about it: an
	// older session marker must not report "logged in" and close the sign-in sheet early.
	signingIn := m.snapshot.State.Authentication == AuthChallenging || m.snapshot.State.Authentication == AuthLoggingIn
	m.mu.RUnlock()
	if !signingIn {
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
			Message: "web session",
		})
	}
	// If backend is already running but hybris FairPlay init failed previously
	// (e.g. eager-start before the page loaded), retry with the fresh MUT now.
	if m.backend.Running() {
		if retrier, ok := m.backend.(interface{ RetryFairPlay(string) }); ok && m.getWebMUT != nil {
			if mut := m.getWebMUT(); mut != "" {
				go retrier.RetryFairPlay(mut)
			}
		}
		if !m.warming.CompareAndSwap(false, true) {
			return
		}
		m.warming.Store(false)
		return
	}
	if !m.warming.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer m.warming.Store(false)
		if err := m.ensureRunning(m.shutdownCtx); err != nil {
			slog.Warn("drm: starting after web session failed", "err", err)
		}
	}()
}

// ensureRunning auto-starts the backend (session reuse path) if not running.
// Returns ErrNotAuthenticated if no session exists.
// Never authenticates — that is Authenticate()'s job.
func (m *DRMManager) ensureRunning(ctx context.Context) error {
	// The gate first, even for a running backend: once a sign-out has begun no DRM
	// operation may reuse the session.
	m.gateMu.Lock()
	signingOut := m.gate == gateSigningOut
	clear := m.gate == gateOpen && m.cleanup == nil && !m.session.hasPending()
	m.gateMu.Unlock()
	if signingOut {
		return ErrLogoutPending
	}
	if clear && m.backend.Running() {
		return nil
	}
	return m.startGuarded(ctx, true, func(ctx context.Context) error {
		if m.backend.Running() {
			return nil
		}
		if !m.session.HasSession() {
			return ErrNotAuthenticated
		}
		startCtx, cancel := context.WithTimeout(ctx, m.policy.StartupTimeout)
		defer cancel()
		if err := m.backend.Start(startCtx, m.cfg); err != nil {
			m.mergeAndEmit(DRMSnapshot{
				State:   DRMState{Manager: ManagerFailed, Process: ProcessFailed, Authentication: AuthFailed, FairPlay: FairPlayFailed, Session: SessionExpired},
				Message: fmt.Sprintf("session restore failed: %v", err),
			})
			return err
		}
		m.lastStart.Store(time.Now().UnixNano())
		// Session DB is present — reflect that immediately so the UI shows the
		// correct state without waiting for a wrapper-emitted event.
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
			Message: "session reuse — mpl_db present",
		})
		return nil
	})
}

// startGuarded is the only way a backend start runs: it holds authSem for the whole
// start, and starts only once the sign-out gate is open (replaying a pending
// sign-out first when replay is set). A start that passed the gate just before a
// sign-out closed it still holds authSem, so that sign-out waits for it.
func (m *DRMManager) startGuarded(ctx context.Context, replay bool, start func(context.Context) error) error {
	select {
	case m.authSem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer release(m.authSem)
	if err := m.awaitClearGate(ctx, replay); err != nil {
		return err
	}
	return start(ctx)
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
	// One sign-in at a time: a second request would queue behind the first and then send
	// another attempt to Apple, which counts toward its limit on wrong passwords.
	if !m.signingIn.CompareAndSwap(false, true) {
		return ErrSignInRunning
	}
	defer m.signingIn.Store(false)
	if until := m.session.SignInPausedUntil(); !until.IsZero() {
		return &SignInPausedError{Until: until}
	}
	err := m.startGuarded(ctx, true, func(ctx context.Context) error { return m.authenticate(ctx, creds) })
	if errors.Is(err, ErrLogoutPending) {
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Authentication: AuthFailed},
			Message: "Finish signing out first, then sign in again.",
		})
	}
	return err
}

func (m *DRMManager) authenticate(ctx context.Context, creds Credentials) error {
	m.auth.SetCredentials(creds) // stored in AuthCoordinator; used if challenged
	defer m.auth.ClearCredentials()
	m.setManagerState(ManagerInitializing)
	// Replace the previous attempt's outcome right away: a client that polls (or reconnects)
	// must not read an earlier failure as this attempt's result.
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthLoggingIn}, Message: "signing in"})

	loginCtx, cancel := context.WithTimeout(ctx, m.policy.AuthTimeout)
	defer cancel()

	// Stop any running backend first so the fresh Start below gets a clean slate.
	// This also kills any adopted wrapper (one we didn't launch ourselves) so its
	// port is released before we try to start a fresh process with --login.
	if m.backend.Running() {
		_ = m.backend.Stop()
	}
	// Pass credentials in BackendConfig for this one Start() call.
	// NOT stored in m.cfg — crash restarts use session-reuse (empty credentials).
	loginCfg := m.cfg
	loginCfg.Credentials = creds
	authErr := m.backend.Start(loginCtx, loginCfg)
	if authErr != nil {
		if errors.Is(authErr, ErrSignInCancelled) {
			// Nobody failed: the code was not given. Back to "signed out", without a failure.
			m.setManagerState(ManagerReady)
			m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthLoggedOut}, Message: "sign-in cancelled"})
			return fmt.Errorf("authenticate: %w", authErr)
		}
		m.setManagerState(ManagerFailed)
		if creds.Email != "" {
			f := ClassifySignInError(authErr)
			m.session.NoteSignInOutcome(false, f)
			// Fresh login failed — emit AuthFailed so the UI shows the error
			// immediately instead of timing out after the poll interval expires.
			m.mergeAndEmit(DRMSnapshot{
				State:   DRMState{Authentication: AuthFailed},
				Failure: &f,
				Message: f.Message,
			})
		}
		return fmt.Errorf("authenticate: %w", authErr)
	}
	if creds.Email != "" {
		m.session.NoteSignInOutcome(true, SignInFailure{})
	}
	m.lastStart.Store(time.Now().UnixNano())
	if creds.Email != "" {
		// Fresh login succeeded — credentials were verified by the backend;
		// session files (mpl_db, MUSIC_TOKEN) are now on disk.
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
			Message: "login successful",
		})
	} else if m.session.HasSession() {
		// Session-reuse restart — reflect the existing session immediately so
		// the UI shows the correct state without waiting for a backend event.
		m.mergeAndEmit(DRMSnapshot{
			State:   DRMState{Session: SessionValid, Authentication: AuthLoggedIn},
			Message: "session reuse — mpl_db present",
		})
	}
	m.setManagerState(ManagerReady)
	return nil
}

// SignInPausedFor returns how long sign-ins stay paused after repeated rejections (0: not paused).
func (m *DRMManager) SignInPausedFor() time.Duration {
	if until := m.session.SignInPausedUntil(); !until.IsZero() {
		return time.Until(until)
	}
	return 0
}

// SignInRunning reports whether a sign-in is in progress.
func (m *DRMManager) SignInRunning() bool { return m.signingIn.Load() }

// SubmitChallenge delivers a challenge reply (2FA code, device approval, etc.)
// from the browser. Call this after receiving a DRM SSE event with
// Authentication == AuthChallenging.
func (m *DRMManager) SubmitChallenge(_ context.Context, reply string) error {
	return m.auth.SubmitReply(reply)
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

// InProcess reports whether CBCS connections are in-process pipes (the native backend),
// which lets the decrypt loop skip idle-based reconnects. Satisfies the optional
// interface fairplay checks on its dialer.
func (m *DRMManager) InProcess() bool {
	ip, ok := m.backend.(interface{ InProcess() bool })
	return ok && ip.InProcess()
}

// Shutdown stops the backend process without clearing the session.
// Call this on clean server exit so the session DB persists for the next start.
// Unlike Logout, Shutdown does not remove mpl_db or any session files.
func (m *DRMManager) Shutdown() {
	m.shutdownStop() // cancel any in-progress handleCrash sleep or restart
	m.setManagerState(ManagerShuttingDown)
	m.closed.Store(true) // after the state is set: setManagerState refuses anything but shutting_down from here
	if m.restartPending.Load() {
		// A sign-out is waiting for this process to end, possibly because a start is
		// stuck in native code holding the backend: stopping could hang, and the next
		// process completes the sign-out anyway.
		return
	}
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

		// Crash detection: backend stopped unexpectedly → apply restart policy.
		// Skip when IntentionalStop is set — the stop was planned (e.g. a
		// credential-triggered re-init). Calling handleCrash in that case
		// races the relaunch.
		if snap.State.Process == ProcessStopped && !ev.Intentional {
			go m.handleCrash()
		}

		// mergeAndEmit applies all non-zero fields atomically under one lock and
		// derives capabilities from the merged state, so the emitted snapshot
		// is self-consistent (updating capabilities afterwards sent the
		// FairPlay-ready event itself with lossless=false).
		m.mergeAndEmit(snap)
	}
}

func (m *DRMManager) handleCrash() {
	m.restartMu.Lock()
	defer m.restartMu.Unlock()

	// If a concurrent handleCrash goroutine already restarted the backend,
	// or Authenticate() started a fresh one, there is nothing to do.
	if m.backend.Running() {
		return
	}

	// crashCount is safe to access here without m.mu: restartMu serialises all
	// handleCrash goroutines, so only one can reach this point at a time.
	if last := m.lastStart.Load(); last != 0 && time.Since(time.Unix(0, last)) > crashResetWindow {
		m.crashCount = 0 // healthy run since the last start: not a crash loop
	}
	count := m.crashCount
	m.crashCount++

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

	select {
	case <-m.shutdownCtx.Done():
		return // server is shutting down; abort the restart
	case <-time.After(delay):
	}

	// A crash restart is a start like any other: never during a sign-out, and never
	// to reuse a session a pending sign-out is about to remove.
	err := m.startGuarded(m.shutdownCtx, false, func(ctx context.Context) error {
		if m.backend.Running() {
			return nil
		}
		ctx, cancel := context.WithTimeout(ctx, m.policy.StartupTimeout)
		defer cancel()
		if err := m.backend.Start(ctx, m.cfg); err != nil {
			m.mergeAndEmit(DRMSnapshot{
				State:   DRMState{Manager: ManagerFailed, Process: ProcessFailed, Authentication: AuthFailed, FairPlay: FairPlayFailed, Session: SessionExpired},
				Message: fmt.Sprintf("restart failed: %v", err),
			})
			return err
		}
		m.lastStart.Store(time.Now().UnixNano())
		return nil
	})
	if errors.Is(err, ErrLogoutPending) {
		slog.Info("drm: crash restart skipped during sign-out")
	}
}

// ── State helpers ─────────────────────────────────────────────────────────────

func (m *DRMManager) setManagerState(s ManagerState) {
	if m.closed.Load() && s != ManagerShuttingDown {
		return
	}
	m.mu.Lock()
	m.snapshot.State.Manager = s
	m.mu.Unlock()
}

// mergeAndEmit merges non-zero fields from snap into the current snapshot,
// updates the timestamp, and forwards to the EventSink.
func (m *DRMManager) mergeAndEmit(snap DRMSnapshot) {
	m.emitMu.Lock()
	defer m.emitMu.Unlock()
	m.mu.Lock()
	if snap.State.Manager != 0 && (!m.closed.Load() || snap.State.Manager == ManagerShuttingDown) {
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
	if snap.State.Session != 0 {
		m.snapshot.State.Session = snap.State.Session
	}
	if snap.Challenge != nil {
		m.snapshot.Challenge = snap.Challenge
	} else if m.snapshot.State.Authentication != AuthChallenging {
		// Judge by the merged state: an unrelated update (Authentication unset) must not
		// erase a challenge that is still waiting for the user.
		m.snapshot.Challenge = nil
	}

	if snap.Failure != nil {
		m.snapshot.Failure = snap.Failure
	} else if snap.State.Authentication != 0 && snap.State.Authentication != AuthFailed {
		m.snapshot.Failure = nil
	}

	// RecoveryUnknown (0) means the update carries no recovery state.
	if snap.State.Recovery != 0 {
		m.snapshot.State.Recovery = snap.State.Recovery
	}

	if m.snapshot.State.FairPlay == FairPlayReady {
		// Capabilities are derived at the snapshot level, not inside State.
		m.snapshot.Capabilities = CapabilityState{
			CBCS:  true,
			ALAC:  true,
			Atmos: true,
			HiRes: !m.cfg.DisableHiRes,
		}
	} else {
		// Playback capabilities belong to a ready FairPlay session; a failed or
		// restarting one must not keep advertising them.
		m.snapshot.Capabilities = CapabilityState{}
	}

	m.snapshot.Timestamp = time.Now()
	m.snapshot.Message = snap.Message
	out := m.snapshot
	m.mu.Unlock()

	if m.sink != nil {
		m.sink(out)
	}
}
