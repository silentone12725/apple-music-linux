// Package drm unit tests for DRMManager using an in-process mock backend.
//
// These tests do NOT require the mock wrapper binary — all backend behaviour
// is emulated via the mockBackend type. Run with:
//
//	go test -race ./engine/drm/
//	go test -v -run TestManager ./engine/drm/
package drm_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"apple-music-cli/engine/drm"
)

// ── Mock backend ──────────────────────────────────────────────────────────────

// mockBackend is a configurable in-process DRMBackend for unit testing.
// Zero value is safe to use; fields are set per-test as needed.
type mockBackend struct {
	mu          sync.Mutex
	running     bool
	startErr    error // error to return from Start
	authErr     error // error to return from Authenticate
	decryptErr  error // error to return from Decrypt
	decryptResp drm.DecryptResponse
	accountResp drm.AccountInfo
	accountErr  error
	m3u8URL     string
	m3u8Err     error
	events      chan drm.DRMEvent

	// emitOnStart is an optional list of DRMEvents to emit when Start is called.
	emitOnStart  []drm.DRMEvent
	startCalled  int
	stopCalled   int
	lastStartCfg drm.BackendConfig // cfg passed to the most recent Start() call
}

func newMockBackend() *mockBackend {
	return &mockBackend{
		events: make(chan drm.DRMEvent, 64),
	}
}

func (b *mockBackend) SetAuthSource(drm.AuthSource) {}

func (b *mockBackend) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

func (b *mockBackend) Start(ctx context.Context, cfg drm.BackendConfig) error {
	b.mu.Lock()
	b.startCalled++
	b.lastStartCfg = cfg
	err := b.startErr
	evs := b.emitOnStart
	b.mu.Unlock()

	if err != nil {
		return err
	}
	b.mu.Lock()
	b.running = true
	b.mu.Unlock()

	for _, ev := range evs {
		select {
		case b.events <- ev:
		default:
		}
	}
	return nil
}

func (b *mockBackend) Authenticate(ctx context.Context) error {
	b.mu.Lock()
	err := b.authErr
	b.mu.Unlock()
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.running = true
	b.mu.Unlock()
	return nil
}

func (b *mockBackend) Stop() error {
	b.mu.Lock()
	b.running = false
	b.stopCalled++
	b.mu.Unlock()
	return nil
}

func (b *mockBackend) Decrypt(ctx context.Context, req drm.DecryptRequest) (drm.DecryptResponse, error) {
	b.mu.Lock()
	err := b.decryptErr
	resp := b.decryptResp
	b.mu.Unlock()
	return resp, err
}

func (b *mockBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	b.mu.Lock()
	u, err := b.m3u8URL, b.m3u8Err
	b.mu.Unlock()
	return u, err
}

func (b *mockBackend) GetAccount(ctx context.Context) (drm.AccountInfo, error) {
	b.mu.Lock()
	info, err := b.accountResp, b.accountErr
	b.mu.Unlock()
	return info, err
}

func (b *mockBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	return nil, errors.New("mock: DialCBCS not implemented")
}

func (b *mockBackend) Events() <-chan drm.DRMEvent { return b.events }

// emitEvent sends an event from the backend; used to drive state transitions.
func (b *mockBackend) emitEvent(ev drm.DRMEvent) {
	select {
	case b.events <- ev:
	default:
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// newUnitManager creates a DRMManager backed by a mockBackend. The baseDir is
// a temp directory; call makeSession(baseDir) to pre-populate the session DB.
func newUnitManager(t *testing.T, backend *mockBackend) (*drm.DRMManager, string) {
	t.Helper()
	baseDir := t.TempDir()
	session := drm.NewSessionManager(baseDir)

	// done is closed by t.Cleanup to prevent t.Logf calls after the test returns.
	// The watchEvents goroutine outlives the test when the manager is discarded
	// and a new one is created (e.g. tests that call NewDRMManager twice).
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	sink := func(snap drm.DRMSnapshot) {
		select {
		case <-done:
			return
		default:
		}
		t.Logf("event: manager=%s process=%s auth=%s fp=%s session=%s msg=%q",
			snap.State.Manager, snap.State.Process, snap.State.Authentication,
			snap.State.FairPlay, snap.State.Session, snap.Message)
	}
	mgr := drm.NewDRMManager(backend, session, sink,
		drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{
			MaxCrashRestarts: 3,
			RestartBackoff:   []time.Duration{10 * time.Millisecond, 20 * time.Millisecond},
			StartupTimeout:   5 * time.Second,
			AuthTimeout:      10 * time.Second,
		},
	)
	return mgr, baseDir
}

// makeSession writes a minimal session DB so HasSession() returns true.
func makeSession(t *testing.T, baseDir string) {
	t.Helper()
	dbDir := filepath.Join(baseDir, "mpl_db")
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		t.Fatalf("makeSession mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dbDir, "accounts.sqlitedb"), []byte("mock_session"), 0644); err != nil {
		t.Fatalf("makeSession write: %v", err)
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestManagerInitialStateWithSession verifies the startup-time session fix:
// when mpl_db exists on disk, NewDRMManager must immediately reflect
// Session=valid and Authentication=logged_in in Status() — without any
// playback request or explicit Authenticate call.
func TestManagerInitialStateWithSession(t *testing.T) {
	backend := newMockBackend()
	mgr, baseDir := newUnitManager(t, backend)
	makeSession(t, baseDir)

	// Re-create the manager AFTER the session file exists so NewDRMManager
	// can observe HasSession() == true at construction time.
	session := drm.NewSessionManager(baseDir)
	mgr = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir}, drm.RestartPolicy{})

	snap := mgr.Status()
	if snap.State.Session != drm.SessionValid {
		t.Errorf("Session: got %s, want valid", snap.State.Session)
	}
	if snap.State.Authentication != drm.AuthLoggedIn {
		t.Errorf("Authentication: got %s, want logged_in", snap.State.Authentication)
	}
}

// TestManagerInitialStateWithoutSession verifies that without a session DB,
// the initial state shows SessionEmpty and AuthLoggedOut — not the zero/unknown
// values, which would leave the UI with no actionable information.
func TestManagerInitialStateWithoutSession(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend)

	snap := mgr.Status()
	if snap.State.Session != drm.SessionEmpty {
		t.Errorf("Session without DB: got %s, want empty", snap.State.Session)
	}
	if snap.State.Authentication != drm.AuthLoggedOut {
		t.Errorf("Authentication without DB: got %s, want logged_out", snap.State.Authentication)
	}
}

// TestManagerMergeEmitSession verifies that mergeAndEmit correctly propagates
// Session state from emitted DRMEvents — the regression that caused QA console
// to always show session:empty even when ensureRunning had emitted SessionValid.
func TestManagerMergeEmitSession(t *testing.T) {
	backend := newMockBackend()
	// Emit Session=valid + Auth=logged_in when Start is called (session-reuse path).
	backend.emitOnStart = []drm.DRMEvent{{
		Snapshot: drm.DRMSnapshot{
			State: drm.DRMState{
				Process:        drm.ProcessRunning,
				FairPlay:       drm.FairPlayReady,
				Session:        drm.SessionValid,
				Authentication: drm.AuthLoggedIn,
			},
			Message: "session reuse",
		},
	}}

	mgr, baseDir := newUnitManager(t, backend)
	makeSession(t, baseDir)
	// Re-create session manager pointing at the same dir so HasSession() is true.
	session := drm.NewSessionManager(baseDir)
	mgr = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{StartupTimeout: 5 * time.Second, AuthTimeout: 10 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Trigger ensureRunning by calling GetAccount (session exists, backend not running).
	backend.mu.Lock()
	backend.running = false
	backend.accountResp = drm.AccountInfo{StorefrontID: "143441", MusicToken: "tok"}
	backend.mu.Unlock()

	if _, err := mgr.GetAccount(ctx); err != nil {
		t.Fatalf("GetAccount: %v", err)
	}

	// Allow watchEvents to process the emitted event.
	deadline := time.Now().Add(2 * time.Second)
	var snap drm.DRMSnapshot
	for time.Now().Before(deadline) {
		snap = mgr.Status()
		if snap.State.Session == drm.SessionValid {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if snap.State.Session != drm.SessionValid {
		t.Errorf("Session after ensureRunning: got %s, want valid", snap.State.Session)
	}
	if snap.State.Authentication != drm.AuthLoggedIn {
		t.Errorf("Authentication after ensureRunning: got %s, want logged_in", snap.State.Authentication)
	}
}

// TestManagerErrNotAuthenticated verifies that DRM operations return an error
// when there is no session — not a panic, nil pointer, or wrong error.
func TestManagerErrNotAuthenticated(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend) // no makeSession → HasSession() == false

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if _, err := mgr.GetAccount(ctx); err == nil {
		t.Error("GetAccount without session: expected error, got nil")
	}
	if _, err := mgr.GetM3U8(ctx, 12345); err == nil {
		t.Error("GetM3U8 without session: expected error, got nil")
	}
	if _, err := mgr.Decrypt(ctx, drm.DecryptRequest{AdamID: "x", KeyURI: "k", Samples: nil}); err == nil {
		t.Error("Decrypt without session: expected error, got nil")
	}
	if _, err := mgr.DialCBCS(ctx); err == nil {
		t.Error("DialCBCS without session: expected error, got nil")
	}

	// Backend must never have been started.
	backend.mu.Lock()
	sc := backend.startCalled
	backend.mu.Unlock()
	if sc != 0 {
		t.Errorf("backend.Start called %d times without a session — must not be called", sc)
	}
}

// TestManagerBackendStartError verifies that a backend Start failure propagates
// correctly: the manager must not enter ManagerReady and must return an error.
func TestManagerBackendStartError(t *testing.T) {
	backend := newMockBackend()
	backend.startErr = errors.New("mock: binary not found")

	mgr, baseDir := newUnitManager(t, backend)
	makeSession(t, baseDir)
	session := drm.NewSessionManager(baseDir)
	mgr = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{StartupTimeout: 5 * time.Second, AuthTimeout: 10 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := mgr.GetAccount(ctx)
	if err == nil {
		t.Error("expected error from GetAccount when backend.Start fails, got nil")
	}
}

// TestManagerAuthenticateStopsRunningBackend verifies that Authenticate calls
// Stop() before Start() — it must not attempt a second launch if one is already
// running (port conflict prevention).
func TestManagerAuthenticateStopsRunningBackend(t *testing.T) {
	backend := newMockBackend()
	backend.mu.Lock()
	backend.running = true // simulate already-running backend
	backend.mu.Unlock()

	mgr, baseDir := newUnitManager(t, backend)
	makeSession(t, baseDir)
	session := drm.NewSessionManager(baseDir)
	mgr = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{StartupTimeout: 5 * time.Second, AuthTimeout: 10 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = mgr.Authenticate(ctx, drm.Credentials{Email: "a@b.com", Password: "p"})

	backend.mu.Lock()
	sc := backend.stopCalled
	backend.mu.Unlock()
	if sc == 0 {
		t.Error("Authenticate must call Stop() before Start() when backend is already running")
	}
}

// TestManagerAuthenticateForwardsCredentials verifies that Authenticate passes
// credentials in the BackendConfig so ProcessBackend can append --login to argv.
// Without this, fresh login silently becomes a session-reuse attempt.
func TestManagerAuthenticateForwardsCredentials(t *testing.T) {
	backend := newMockBackend()
	mgr, baseDir := newUnitManager(t, backend)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	creds := drm.Credentials{Email: "test@example.com", Password: "hunter2"}
	_ = mgr.Authenticate(ctx, creds)

	backend.mu.Lock()
	got := backend.lastStartCfg
	backend.mu.Unlock()

	if got.Credentials.Email != creds.Email {
		t.Errorf("Start() cfg.Credentials.Email = %q, want %q", got.Credentials.Email, creds.Email)
	}
	if got.Credentials.Password != creds.Password {
		t.Errorf("Start() cfg.Credentials.Password = %q, want %q", got.Credentials.Password, creds.Password)
	}
	_ = baseDir
}

// TestManagerLogoutResetsState verifies that after Logout, the DRMSnapshot
// reflects AuthLoggedOut, SessionEmpty, and ProcessStopped — regardless of
// what state was active before.
func TestManagerLogoutResetsState(t *testing.T) {
	backend := newMockBackend()
	backend.mu.Lock()
	backend.running = true
	backend.mu.Unlock()

	mgr, baseDir := newUnitManager(t, backend)
	makeSession(t, baseDir)
	session := drm.NewSessionManager(baseDir)
	mgr = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{})

	ctx := context.Background()
	if err := mgr.Logout(ctx); err != nil {
		t.Fatalf("Logout: %v", err)
	}

	snap := mgr.Status()
	if snap.State.Authentication != drm.AuthLoggedOut {
		t.Errorf("post-Logout Authentication: got %s, want logged_out", snap.State.Authentication)
	}
	if snap.State.Session != drm.SessionEmpty {
		t.Errorf("post-Logout Session: got %s, want empty", snap.State.Session)
	}
	if snap.State.Process != drm.ProcessStopped {
		t.Errorf("post-Logout Process: got %s, want stopped", snap.State.Process)
	}

	// Session DB must be gone.
	dbPath := filepath.Join(baseDir, "mpl_db", "accounts.sqlitedb")
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Error("mpl_db must be removed after Logout")
	}
}

// TestManagerStatusThreadSafety hammers Status() and mergeAndEmit concurrently
// to catch data races. Run with -race.
func TestManagerStatusThreadSafety(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend)

	const workers = 8
	const iters = 200
	var wg sync.WaitGroup

	// Readers.
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				_ = mgr.Status()
			}
		}()
	}

	// Writers: emit events from the mock backend.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < iters; j++ {
			backend.emitEvent(drm.DRMEvent{Snapshot: drm.DRMSnapshot{
				State:   drm.DRMState{Process: drm.ProcessRunning, FairPlay: drm.FairPlayReady},
				Message: "concurrent write",
			}})
			time.Sleep(time.Millisecond)
		}
	}()

	wg.Wait()
}

// TestManagerCapabilitiesOnFairPlayReady verifies that capabilities (CBCS, ALAC,
// Atmos, HiRes) are set to true when the backend emits FairPlayReady, and are
// cleared on Logout.
func TestManagerCapabilitiesOnFairPlayReady(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend)

	// Emit FairPlayReady from the backend.
	backend.emitEvent(drm.DRMEvent{Snapshot: drm.DRMSnapshot{
		State:   drm.DRMState{FairPlay: drm.FairPlayReady},
		Message: "fair play ready",
	}})

	// Wait for watchEvents to process.
	deadline := time.Now().Add(2 * time.Second)
	var snap drm.DRMSnapshot
	for time.Now().Before(deadline) {
		snap = mgr.Status()
		if snap.Capabilities.CBCS {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !snap.Capabilities.CBCS {
		t.Error("Capabilities.CBCS must be true after FairPlayReady")
	}
	if !snap.Capabilities.ALAC {
		t.Error("Capabilities.ALAC must be true after FairPlayReady")
	}
	if !snap.Capabilities.Atmos {
		t.Error("Capabilities.Atmos must be true after FairPlayReady")
	}
	if !snap.Capabilities.HiRes {
		t.Error("Capabilities.HiRes must be true after FairPlayReady")
	}

	// Logout must clear capabilities.
	backend.mu.Lock()
	backend.running = true
	backend.mu.Unlock()
	ctx := context.Background()
	if err := mgr.Logout(ctx); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	snap = mgr.Status()
	if snap.Capabilities.CBCS || snap.Capabilities.ALAC || snap.Capabilities.Atmos || snap.Capabilities.HiRes {
		t.Error("Capabilities must be false after Logout")
	}
}

// TestManagerChallengeFieldClearedAfterLogin verifies that the Challenge field
// in DRMSnapshot is non-nil only while Authentication == AuthChallenging.
// After the backend transitions to AuthLoggedIn, Challenge must be nil.
func TestManagerChallengeFieldClearedAfterLogin(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend)

	challenge := &drm.AuthChallenge{Type: drm.ChallengeTwoFactor, Title: "2FA"}
	backend.emitEvent(drm.DRMEvent{Snapshot: drm.DRMSnapshot{
		State:     drm.DRMState{Authentication: drm.AuthChallenging},
		Challenge: challenge,
	}})

	// Wait for the challenge to appear.
	deadline := time.Now().Add(2 * time.Second)
	var snap drm.DRMSnapshot
	for time.Now().Before(deadline) {
		snap = mgr.Status()
		if snap.State.Authentication == drm.AuthChallenging {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if snap.Challenge == nil {
		t.Error("Challenge must be non-nil while AuthChallenging")
	}

	// Now transition to AuthLoggedIn — challenge must clear.
	backend.emitEvent(drm.DRMEvent{Snapshot: drm.DRMSnapshot{
		State: drm.DRMState{Authentication: drm.AuthLoggedIn},
	}})

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap = mgr.Status()
		if snap.State.Authentication == drm.AuthLoggedIn {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if snap.Challenge != nil {
		t.Error("Challenge must be nil after transitioning out of AuthChallenging")
	}
}

// TestManagerCrashTriggersRestart verifies that when the backend emits
// ProcessStopped (non-intentional — crash), the manager's handleCrash path
// fires and calls backend.Start() again.
func TestManagerCrashTriggersRestart(t *testing.T) {
	backend := newMockBackend()
	baseDir := t.TempDir()
	makeSession(t, baseDir)
	session := drm.NewSessionManager(baseDir)
	_ = drm.NewDRMManager(backend, session, func(drm.DRMSnapshot) {}, drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{
			MaxCrashRestarts: 2,
			RestartBackoff:   []time.Duration{10 * time.Millisecond},
			StartupTimeout:   5 * time.Second,
			AuthTimeout:      10 * time.Second,
		})

	// Simulate backend running, then crashing.
	backend.mu.Lock()
	backend.running = true
	backend.startCalled = 0
	backend.mu.Unlock()

	// Emit non-intentional ProcessStopped (crash).
	backend.emitEvent(drm.DRMEvent{
		Snapshot: drm.DRMSnapshot{
			State:   drm.DRMState{Process: drm.ProcessStopped},
			Message: "process crashed",
		},
		Intentional: false,
	})

	// Give handleCrash time to fire and call Start().
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		backend.mu.Lock()
		sc := backend.startCalled
		backend.mu.Unlock()
		if sc >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	backend.mu.Lock()
	sc := backend.startCalled
	backend.mu.Unlock()
	if sc < 1 {
		t.Errorf("expected backend.Start called after crash, got startCalled=%d", sc)
	}
}

// TestManagerMaxCrashRestarts verifies that after MaxCrashRestarts consecutive
// crashes, the manager enters ManagerFailed and stops restarting.
func TestManagerMaxCrashRestarts(t *testing.T) {
	const maxRestarts = 2
	backend := newMockBackend()
	baseDir := t.TempDir()
	makeSession(t, baseDir)
	session := drm.NewSessionManager(baseDir)
	mgr := drm.NewDRMManager(backend, session,
		func(snap drm.DRMSnapshot) {},
		drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{
			MaxCrashRestarts: maxRestarts,
			RestartBackoff:   []time.Duration{5 * time.Millisecond},
			StartupTimeout:   5 * time.Second,
			AuthTimeout:      10 * time.Second,
		})

	// Emit more crashes than MaxCrashRestarts.
	for i := 0; i <= maxRestarts; i++ {
		backend.emitEvent(drm.DRMEvent{
			Snapshot: drm.DRMSnapshot{
				State:   drm.DRMState{Process: drm.ProcessStopped},
				Message: "crash",
			},
			Intentional: false,
		})
		time.Sleep(30 * time.Millisecond) // wait for backoff
	}

	// Manager must eventually enter ManagerFailed.
	deadline := time.Now().Add(3 * time.Second)
	var snap drm.DRMSnapshot
	for time.Now().Before(deadline) {
		snap = mgr.Status()
		if snap.State.Manager == drm.ManagerFailed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if snap.State.Manager != drm.ManagerFailed {
		t.Errorf("manager must be ManagerFailed after %d crashes; got %s", maxRestarts, snap.State.Manager)
	}
}

// TestManagerIntentionalStopNoCrash verifies that when the backend emits
// ProcessStopped with Intentional=true (Stop() was called deliberately),
// the manager does NOT trigger crash recovery.
func TestManagerIntentionalStopNoCrash(t *testing.T) {
	backend := newMockBackend()
	mgr, _ := newUnitManager(t, backend)

	backend.mu.Lock()
	backend.running = true
	backend.startCalled = 0
	backend.mu.Unlock()

	// Intentional stop (e.g. credential restart).
	backend.emitEvent(drm.DRMEvent{
		Snapshot:    drm.DRMSnapshot{State: drm.DRMState{Process: drm.ProcessStopped}},
		Intentional: true,
	})

	// Give watchEvents time to process.
	time.Sleep(100 * time.Millisecond)

	backend.mu.Lock()
	sc := backend.startCalled
	backend.mu.Unlock()
	if sc > 0 {
		t.Errorf("intentional stop must not trigger restart; backend.Start was called %d time(s)", sc)
	}

	// Manager must NOT be in ManagerFailed.
	snap := mgr.Status()
	if snap.State.Manager == drm.ManagerFailed {
		t.Error("manager must not be ManagerFailed after intentional stop")
	}
}

// TestParseStateFile verifies that every state string written by main.c
// parse-state is correctly decoded to Process/FairPlay/Auth/Recovery fields.
func TestParseStateFile(t *testing.T) {
	tests := []struct {
		input    string
		process  drm.ProcessState
		fairplay drm.FairPlayState
		auth     drm.AuthState
		recovery drm.RecoveryState
	}{
		{"STARTING", drm.ProcessStarting, drm.FairPlayUnknown, drm.AuthUnknown, drm.RecoveryUnknown},
		{"LOGIN", drm.ProcessStarting, drm.FairPlayUnknown, drm.AuthLoggingIn, drm.RecoveryUnknown},
		{"WAITING_2FA", drm.ProcessStarting, drm.FairPlayUnknown, drm.AuthChallenging, drm.RecoveryUnknown},
		{"INITIALIZING_FAIRPLAY", drm.ProcessRunning, drm.FairPlayInitializing, drm.AuthLoggedIn, drm.RecoveryUnknown},
		{"RUNNING", drm.ProcessRunning, drm.FairPlayReady, drm.AuthLoggedIn, drm.RecoveryUnknown},
		{"RECOVERY", drm.ProcessRunning, drm.FairPlayReady, drm.AuthUnknown, drm.RecoveryRefreshing},
		{"FAILED", drm.ProcessFailed, drm.FairPlayUnknown, drm.AuthUnknown, drm.RecoveryUnknown},
		{"STOPPED", drm.ProcessStopped, drm.FairPlayUnknown, drm.AuthUnknown, drm.RecoveryUnknown},
		// Trailing whitespace / newline (written by real main.c via fprintf).
		{"RUNNING\n", drm.ProcessRunning, drm.FairPlayReady, drm.AuthLoggedIn, drm.RecoveryUnknown},
		{"RUNNING\r\n", drm.ProcessRunning, drm.FairPlayReady, drm.AuthLoggedIn, drm.RecoveryUnknown},
		// Unknown state: all fields must be zero.
		{"UNKNOWN_GARBAGE", drm.ProcessUnknown, drm.FairPlayUnknown, drm.AuthUnknown, drm.RecoveryUnknown},
		{"", drm.ProcessUnknown, drm.FairPlayUnknown, drm.AuthUnknown, drm.RecoveryUnknown},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			got := drm.ParseStateFile(tc.input)
			if got.Process != tc.process {
				t.Errorf("Process: got %s, want %s", got.Process, tc.process)
			}
			if got.FairPlay != tc.fairplay {
				t.Errorf("FairPlay: got %s, want %s", got.FairPlay, tc.fairplay)
			}
			if got.Auth != tc.auth {
				t.Errorf("Auth: got %s, want %s", got.Auth, tc.auth)
			}
			if got.Recovery != tc.recovery {
				t.Errorf("Recovery: got %s, want %s", got.Recovery, tc.recovery)
			}
		})
	}
}

// TestSessionManagerHasSession verifies HasSession against various DB states.
func TestSessionManagerHasSession(t *testing.T) {
	baseDir := t.TempDir()
	sm := drm.NewSessionManager(baseDir)

	// No DB at all.
	if sm.HasSession() {
		t.Error("HasSession must be false when mpl_db is absent")
	}

	// DB directory exists but file is empty.
	dbDir := filepath.Join(baseDir, "mpl_db")
	os.MkdirAll(dbDir, 0755)
	dbPath := filepath.Join(dbDir, "accounts.sqlitedb")
	os.WriteFile(dbPath, []byte{}, 0644)
	if sm.HasSession() {
		t.Error("HasSession must be false for a zero-byte DB file")
	}

	// DB has content.
	os.WriteFile(dbPath, []byte("content"), 0644)
	if !sm.HasSession() {
		t.Error("HasSession must be true for a non-empty DB file")
	}

	// ClearSession removes the DB.
	if err := sm.ClearSession(); err != nil {
		t.Fatalf("ClearSession: %v", err)
	}
	if sm.HasSession() {
		t.Error("HasSession must be false after ClearSession")
	}
}

// TestSessionManagerRecordSuccess verifies that RecordSuccess + IsSessionValid
// (TTL path) work correctly.
func TestSessionManagerRecordSuccess(t *testing.T) {
	baseDir := t.TempDir()
	sm := drm.NewSessionManager(baseDir)
	makeSession(t, baseDir)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("tok"), 0644)

	// Before any success: live check needed (pass nil → treat as expired).
	ok, err := sm.IsSessionValid(context.Background(), nil)
	if err != nil {
		t.Fatalf("IsSessionValid: %v", err)
	}
	if ok {
		t.Error("expected not valid before RecordSuccess and with nil DRMProvider")
	}

	// After RecordSuccess: TTL-based check succeeds.
	sm.RecordSuccess()
	ok, err = sm.IsSessionValid(context.Background(), nil)
	if err != nil {
		t.Fatalf("IsSessionValid after RecordSuccess: %v", err)
	}
	if !ok {
		t.Error("expected valid after RecordSuccess within TTL")
	}
}

// TestSessionManagerClearResetsLastSuccess verifies that ClearSession resets
// the behavioral validity timestamp so a subsequent IsSessionValid requires
// a new RecordSuccess.
func TestSessionManagerClearResetsLastSuccess(t *testing.T) {
	baseDir := t.TempDir()
	sm := drm.NewSessionManager(baseDir)
	makeSession(t, baseDir)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("tok"), 0644)

	sm.RecordSuccess()
	sm.ClearSession()

	// Recreate files (simulating a new login) to isolate the TTL reset.
	makeSession(t, baseDir)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("tok"), 0644)

	ok, _ := sm.IsSessionValid(context.Background(), nil)
	if ok {
		t.Error("IsSessionValid must be false after ClearSession resets lastSuccess")
	}
}

// TestDRMStateStrings verifies that every state iota has a non-empty string
// representation and that zero values print as "unknown" rather than empty.
func TestDRMStateStrings(t *testing.T) {
	states := []interface{ String() string }{
		drm.ManagerUnknown, drm.ManagerDisabled, drm.ManagerInitializing,
		drm.ManagerReady, drm.ManagerShuttingDown, drm.ManagerFailed,
		drm.ProcessUnknown, drm.ProcessStopped, drm.ProcessStarting,
		drm.ProcessRunning, drm.ProcessFailed,
		drm.AuthUnknown, drm.AuthLoggedOut, drm.AuthLoggingIn,
		drm.AuthChallenging, drm.AuthLoggedIn, drm.AuthFailed,
		drm.FairPlayUnknown, drm.FairPlayInitializing, drm.FairPlayReady, drm.FairPlayFailed,
		drm.SessionUnknown, drm.SessionEmpty, drm.SessionValid, drm.SessionExpired,
		drm.RecoveryUnknown, drm.RecoveryIdle, drm.RecoveryScheduled,
		drm.RecoveryRefreshing, drm.RecoveryFailed,
	}
	for _, s := range states {
		if s.String() == "" {
			t.Errorf("state %T(%v) has empty String() — iota may be out of range", s, s)
		}
	}
	// Zero values must be "unknown".
	if drm.ProcessUnknown.String() != "unknown" {
		t.Errorf("ProcessUnknown.String() = %q, want %q", drm.ProcessUnknown.String(), "unknown")
	}
	if drm.AuthUnknown.String() != "unknown" {
		t.Errorf("AuthUnknown.String() = %q, want %q", drm.AuthUnknown.String(), "unknown")
	}
	if drm.SessionUnknown.String() != "unknown" {
		t.Errorf("SessionUnknown.String() = %q, want %q", drm.SessionUnknown.String(), "unknown")
	}
}
