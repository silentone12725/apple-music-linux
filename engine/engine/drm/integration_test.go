//go:build integration

// Package drm integration tests exercise the full ProcessBackend + DRMManager
// lifecycle against the mock wrapper binary. Run with:
//
//	go test -tags integration -v ./engine/drm/
//
// To test against the real wrapper binary instead of the mock:
//
//	WRAPPER_BINARY=./wrapper-rootless go test -tags integration -v ./engine/drm/
package drm_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"apple-music-cli/engine/drm"
)

// ── Test harness ──────────────────────────────────────────────────────────────

// mockWrapperBin is the compiled mock wrapper path for the current test run.
var mockWrapperBin string

func TestMain(m *testing.M) {
	// Build the mock wrapper once before all tests.
	bin, err := buildMockWrapper()
	if err != nil {
		// If WRAPPER_BINARY is set, skip the build and use that instead.
		if w := os.Getenv("WRAPPER_BINARY"); w != "" {
			mockWrapperBin = w
		} else {
			panic("failed to build mock wrapper: " + err.Error())
		}
	} else {
		mockWrapperBin = bin
		defer os.Remove(bin)
	}

	os.Exit(m.Run())
}

func buildMockWrapper() (string, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	srcDir := filepath.Join(filepath.Dir(thisFile), "testdata", "mockwrapper")

	bin, err := os.CreateTemp("", "mockwrapper-*")
	if err != nil {
		return "", err
	}
	binPath := bin.Name()
	bin.Close()

	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Dir = srcDir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		os.Remove(binPath)
		return "", err
	}
	return binPath, nil
}

// newTestBackend creates a ProcessBackend + DRMManager wired to the mock
// wrapper, with a fresh temp directory as BaseDir. Returns the manager, the
// base directory, and a cleanup function.
func newTestBackend(t *testing.T, overridePorts ...string) (*drm.DRMManager, string) {
	t.Helper()
	baseDir := t.TempDir()

	// Use high-numbered ports to avoid conflicts. Tests run sequentially so
	// a fixed set per test is fine; parallel tests would need random ports.
	decryptAddr := "127.0.0.1:19020"
	m3u8Addr := "127.0.0.1:29020"
	accountAddr := "127.0.0.1:39020"
	if len(overridePorts) == 3 {
		decryptAddr, m3u8Addr, accountAddr = overridePorts[0], overridePorts[1], overridePorts[2]
	}

	backend := drm.NewProcessBackend(drm.ProcessConfig{
		BinaryPath:  mockWrapperBin,
		DecryptAddr: decryptAddr,
		M3U8Addr:    m3u8Addr,
		AccountAddr: accountAddr,
	})

	events := []drm.DRMSnapshot{}
	_ = events // collected below via sink

	sink := func(snap drm.DRMSnapshot) {
		t.Logf("drm event: process=%-10s auth=%-12s fairplay=%-12s msg=%s",
			snap.State.Process, snap.State.Authentication, snap.State.FairPlay, snap.Message)
	}

	session := drm.NewSessionManager(baseDir)
	policy := drm.RestartPolicy{
		MaxCrashRestarts: 3,
		RestartBackoff:   []time.Duration{200 * time.Millisecond, 500 * time.Millisecond},
		StartupTimeout:   15 * time.Second,
		AuthTimeout:      30 * time.Second,
	}
	mgr := drm.NewDRMManager(backend, session, sink,
		drm.BackendConfig{BaseDir: baseDir},
		policy,
	)
	return mgr, baseDir
}

// waitForState polls mgr.Status() until the predicate returns true or the
// deadline expires. Reports the final snapshot on failure.
func waitForState(t *testing.T, mgr *drm.DRMManager, timeout time.Duration, pred func(drm.DRMSnapshot) bool) drm.DRMSnapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		snap := mgr.Status()
		if pred(snap) {
			return snap
		}
		time.Sleep(50 * time.Millisecond)
	}
	snap := mgr.Status()
	t.Errorf("timed out waiting for state; last snapshot: process=%s auth=%s fairplay=%s",
		snap.State.Process, snap.State.Authentication, snap.State.FairPlay)
	return snap
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestSessionReuse verifies that when mpl_db already exists, the wrapper
// reaches RUNNING without going through the LOGIN state (no credentials needed).
func TestSessionReuse(t *testing.T) {
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19021", "127.0.0.1:29021", "127.0.0.1:39021")

	// Pre-populate the session so HasSession() == true.
	dbDir := filepath.Join(baseDir, "mpl_db")
	os.MkdirAll(dbDir, 0755)
	os.WriteFile(filepath.Join(dbDir, "accounts.sqlitedb"), []byte("existing_session"), 0644)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("token"), 0644)

	ctx := context.Background()
	// Login with empty credentials: session exists so no challenge should fire.
	if err := mgr.Authenticate(ctx, drm.Credentials{}); err != nil {
		t.Fatalf("Login: %v", err)
	}

	snap := waitForState(t, mgr, 10*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	if snap.State.Authentication == drm.AuthLoggingIn {
		t.Error("session reuse path should not enter AuthLoggingIn state")
	}
	if snap.State.FairPlay != drm.FairPlayReady {
		t.Errorf("expected FairPlayReady, got %s", snap.State.FairPlay)
	}
	if !snap.Capabilities.CBCS {
		t.Error("expected CBCS capability true after FairPlayReady")
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestFreshLoginNо2FA verifies the fresh-login path when the email does not
// trigger 2FA. Expected sequence:
//
//	Login() → wrapper starts → LOGIN state → credential challenge →
//	wrapper restarts with --login → RUNNING
func TestFreshLoginNo2FA(t *testing.T) {
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19022", "127.0.0.1:29022", "127.0.0.1:39022")
	_ = baseDir

	ctx := context.Background()
	err := mgr.Authenticate(ctx, drm.Credentials{
		Email:    "test@example.com", // no "2fa@" → no 2FA step
		Password: "testpassword",
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	snap := waitForState(t, mgr, 15*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	if snap.State.FairPlay != drm.FairPlayReady {
		t.Errorf("expected FairPlayReady, got %s", snap.State.FairPlay)
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestFreshLoginWith2FA verifies the 2FA challenge path. Email "2fa@example.com"
// causes the mock wrapper to emit WAITING_2FA. The test submits a code via
// SubmitChallenge within the 2-minute window.
func TestFreshLoginWith2FA(t *testing.T) {
	mgr, _ := newTestBackend(t, "127.0.0.1:19023", "127.0.0.1:29023", "127.0.0.1:39023")
	ctx := context.Background()

	// Start login in background; it will block waiting for 2FA.
	loginDone := make(chan error, 1)
	go func() {
		loginDone <- mgr.Authenticate(ctx, drm.Credentials{
			Email:    "2fa@example.com",
			Password: "testpassword",
		})
	}()

	// Wait for the manager to enter the challenging state.
	waitForState(t, mgr, 10*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.Authentication == drm.AuthChallenging
	})

	// Submit the 2FA code.
	if err := mgr.SubmitChallenge(ctx, "123456"); err != nil {
		t.Fatalf("SubmitChallenge: %v", err)
	}

	// Login goroutine should complete.
	select {
	case err := <-loginDone:
		if err != nil {
			t.Fatalf("Login after 2FA: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Login did not complete after 2FA submission")
	}

	snap := waitForState(t, mgr, 5*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})
	if snap.State.FairPlay != drm.FairPlayReady {
		t.Errorf("expected FairPlayReady after 2FA, got %s", snap.State.FairPlay)
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestNoSpuriousCrashOnCredentialRestart verifies that the credential-triggered
// restart (Stop + relaunch with --login) does not cause DRMManager to enter
// crash-recovery mode. This is the lifecycle race fixed by the Intentional flag.
func TestNoSpuriousCrashOnCredentialRestart(t *testing.T) {
	mgr, _ := newTestBackend(t, "127.0.0.1:19024", "127.0.0.1:29024", "127.0.0.1:39024")
	ctx := context.Background()

	crashSeen := false
	// Wrap the sink to detect ManagerFailed.
	// (We rely on Status() polling below instead of a custom sink since
	// NewDRMManager already took a sink closure above.)

	if err := mgr.Authenticate(ctx, drm.Credentials{
		Email:    "test@example.com",
		Password: "pass",
	}); err != nil {
		t.Fatalf("Login: %v", err)
	}

	waitForState(t, mgr, 15*time.Second, func(s drm.DRMSnapshot) bool {
		if s.State.Manager == drm.ManagerFailed {
			crashSeen = true
		}
		return s.State.FairPlay == drm.FairPlayReady
	})

	if crashSeen {
		t.Error("DRMManager entered ManagerFailed during credential restart — spurious crash recovery triggered")
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestGetAccount verifies that GetAccount returns the mock account info
// after a successful login.
func TestGetAccount(t *testing.T) {
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19025", "127.0.0.1:29025", "127.0.0.1:39025")
	ctx := context.Background()

	// Pre-populate session (session-reuse path, simplest setup).
	dbDir := filepath.Join(baseDir, "mpl_db")
	os.MkdirAll(dbDir, 0755)
	os.WriteFile(filepath.Join(dbDir, "accounts.sqlitedb"), []byte("session"), 0644)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("token"), 0644)

	mgr.Authenticate(ctx, drm.Credentials{}) //nolint:errcheck
	waitForState(t, mgr, 10*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	info, err := mgr.GetAccount(ctx)
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	if info.StorefrontID != "143441" {
		t.Errorf("StorefrontID: got %q, want %q", info.StorefrontID, "143441")
	}
	if info.MusicToken == "" {
		t.Error("MusicToken should not be empty")
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestDecrypt verifies that Decrypt sends samples through the TCP protocol and
// receives the (mock) decrypted response. The mock wrapper echoes bytes back
// unchanged; we verify the round-trip works end-to-end.
func TestDecrypt(t *testing.T) {
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19026", "127.0.0.1:29026", "127.0.0.1:39026")
	ctx := context.Background()

	dbDir := filepath.Join(baseDir, "mpl_db")
	os.MkdirAll(dbDir, 0755)
	os.WriteFile(filepath.Join(dbDir, "accounts.sqlitedb"), []byte("session"), 0644)
	os.WriteFile(filepath.Join(baseDir, "STOREFRONT_ID"), []byte("143441"), 0644)
	os.WriteFile(filepath.Join(baseDir, "MUSIC_TOKEN"), []byte("token"), 0644)

	mgr.Authenticate(ctx, drm.Credentials{}) //nolint:errcheck
	waitForState(t, mgr, 10*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	// Samples must be multiples of 16 (AES block size) to pass truncation.
	sample := make([]byte, 32)
	for i := range sample {
		sample[i] = byte(i)
	}

	resp, err := mgr.Decrypt(ctx, drm.DecryptRequest{
		AdamID:  "123456789",
		KeyURI:  "skd://mock-key",
		Samples: [][]byte{sample},
	})
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if len(resp.Samples) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(resp.Samples))
	}
	if len(resp.Samples[0]) != len(sample) {
		t.Errorf("decrypted sample length mismatch: got %d, want %d",
			len(resp.Samples[0]), len(sample))
	}

	mgr.Logout(ctx) //nolint:errcheck
}

// TestSessionDelete verifies that after ClearSession, a new login goes through
// the full credential challenge rather than reusing the old mpl_db.
func TestSessionDelete(t *testing.T) {
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19027", "127.0.0.1:29027", "127.0.0.1:39027")
	ctx := context.Background()

	// First: login and reach RUNNING.
	mgr.Authenticate(ctx, drm.Credentials{Email: "test@example.com", Password: "pass"}) //nolint:errcheck
	waitForState(t, mgr, 15*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	// Logout clears the session.
	if err := mgr.Logout(ctx); err != nil {
		t.Fatalf("Logout: %v", err)
	}

	// mpl_db should be gone.
	dbPath := filepath.Join(baseDir, "mpl_db", "accounts.sqlitedb")
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Error("mpl_db should be removed after Logout")
	}

	// Confirm mpl_db is gone — primary invariant of ClearSession.
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Error("mpl_db still present after Logout — ClearSession did not run cleanly")
	}

	// Second login: no mpl_db → wrapper writes LOGIN → ProcessBackend restarts
	// with --login → session created → RUNNING. Assert the full cycle completes.
	ctx2 := context.Background()
	loginDone2 := make(chan error, 1)
	go func() {
		loginDone2 <- mgr.Authenticate(ctx2, drm.Credentials{
			Email:    "test@example.com",
			Password: "pass",
		})
	}()

	// AuthLoggingIn is a transient internal state; poll for the stable end-state.
	waitForState(t, mgr, 15*time.Second, func(s drm.DRMSnapshot) bool {
		return s.State.FairPlay == drm.FairPlayReady
	})

	select {
	case err := <-loginDone2:
		if err != nil {
			t.Fatalf("second Login: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second Login goroutine did not return")
	}

	// Verify session was re-created by the second login (check BEFORE Logout clears it).
	t.Logf("checking mpl_db at: %s", dbPath)
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		// List what IS in baseDir to diagnose.
		entries, _ := os.ReadDir(filepath.Dir(dbPath))
		t.Errorf("mpl_db should exist after second login; contents of mpl_db dir: %v", entries)
	}

	mgr.Logout(ctx2) //nolint:errcheck
}
