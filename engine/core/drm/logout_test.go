package drm

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeBackend behaves like adamplayBackend where sign-out depends on it: Start
// holds the backend lock (a sign-in waiting for a code keeps it), Stop needs it.
type fakeBackend struct {
	crashStub
	mu      sync.Mutex
	running atomic.Bool
	starts  atomic.Int32
	stops   atomic.Int32
	auth    AuthSource
	startFn func(ctx context.Context, b *fakeBackend) error
	stopErr error
}

func newFake() *fakeBackend { return &fakeBackend{crashStub: crashStub{events: make(chan DRMEvent)}} }

func (b *fakeBackend) SetAuthSource(a AuthSource) { b.auth = a }
func (b *fakeBackend) Running() bool              { return b.running.Load() }

func (b *fakeBackend) Start(ctx context.Context, _ BackendConfig) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.starts.Add(1)
	if b.startFn != nil {
		if err := b.startFn(ctx, b); err != nil {
			return err
		}
	}
	b.running.Store(true)
	return nil
}

func (b *fakeBackend) Stop() error {
	b.stops.Add(1)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.running.Store(false)
	return b.stopErr
}

var fastTiming = signOutTiming{Route: 2 * time.Second, AuthWait: time.Second, ReplayWait: time.Second}

func newTestManager(t *testing.T, dir string, b *fakeBackend) *DRMManager {
	t.Helper()
	m := NewDRMManager(b, NewSessionManager(dir), nil, BackendConfig{}, RestartPolicy{StartupTimeout: time.Second, AuthTimeout: 5 * time.Second})
	m.timing = fastTiming
	return m
}

var (
	accountNames = []string{"session-ready", "MUSIC_TOKEN", "STOREFRONT_ID", "drm-state", "33F633BF6AC7D676168B84C3594A7941AF2BEC09"}
	deviceNames  = []string{"device-id", "adi.pb", "IC-Info.sids", "fsi.pdat"}
)

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeSignedIn lays out a signed-in profile with the given device ID.
func writeSignedIn(t *testing.T, dir, deviceID string) {
	t.Helper()
	for _, n := range accountNames {
		write(t, dir, n, "x")
	}
	for _, n := range deviceNames[1:] {
		write(t, dir, n, "x")
	}
	write(t, dir, "device-id", deviceID+"\n")
	os.MkdirAll(filepath.Join(dir, "mpl_db"), 0o700)
	write(t, dir, filepath.Join("mpl_db", "accounts.sqlitedb"), "x")
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

func assertGone(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		if exists(dir, n) {
			t.Errorf("%s survived", n)
		}
	}
}

func assertKept(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		if !exists(dir, n) {
			t.Errorf("%s was removed", n)
		}
	}
}

func noRequests(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), logoutMarkerName) {
			t.Errorf("sign-out request %s left behind", e.Name())
		}
	}
}

func (m *DRMManager) gateNow() gateState {
	m.gateMu.Lock()
	defer m.gateMu.Unlock()
	return m.gate
}

// ── Scopes and the device ID ────────────────────────────────────────────────

func TestSignOutKeepsDeviceIdentity(t *testing.T) {
	for _, id := range []string{legacyAndroidID, "0123456789abcdef"} {
		dir := t.TempDir()
		writeSignedIn(t, dir, id)
		m := newTestManager(t, dir, newFake())
		res, err := m.Logout(context.Background())
		if err != nil || res.Restart || res.ServerSignOut != "skipped" {
			t.Fatalf("Logout: %+v %v", res, err)
		}
		assertGone(t, dir, append(accountNames, "mpl_db")...)
		assertKept(t, dir, deviceNames...)
		noRequests(t, dir)
		info, err := DeviceInfo(dir)
		if err != nil || !strings.HasSuffix(info, id) {
			t.Errorf("device ID changed after sign-out: %q %v", info, err)
		}
		if m.gateNow() != gateOpen {
			t.Error("gate must be open after a completed sign-out")
		}
	}
}

func TestForgetDeviceGivesANewDevice(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	m := newTestManager(t, dir, newFake())
	if _, err := m.ForgetDevice(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertGone(t, dir, append(append(accountNames, "mpl_db"), deviceNames...)...)
	noRequests(t, dir)
	info, err := DeviceInfo(dir)
	if err != nil || strings.HasSuffix(info, legacyAndroidID) {
		t.Fatalf("Forget This Device must give a new random ID: %q %v", info, err)
	}
}

// ── Replay of requests left on disk ─────────────────────────────────────────

func TestCompletePendingLogoutHonoursTheScope(t *testing.T) {
	cases := []struct {
		marker     string
		keepDevice bool
	}{
		{"account", true}, {"device", false}, {"1", true}, {"", true}, {"junk", true},
	}
	for _, c := range cases {
		dir := t.TempDir()
		writeSignedIn(t, dir, legacyAndroidID)
		write(t, dir, logoutMarkerName, c.marker)
		s := NewSessionManager(dir)
		if s.HasSession() {
			t.Errorf("marker %q: a pending sign-out must hide the session", c.marker)
		}
		if err := s.CompletePendingLogout(); err != nil {
			t.Fatalf("marker %q: %v", c.marker, err)
		}
		assertGone(t, dir, append(accountNames, "mpl_db")...)
		if c.keepDevice {
			assertKept(t, dir, deviceNames...)
		} else {
			assertGone(t, dir, deviceNames...)
		}
		noRequests(t, dir)
	}
}

func TestFailedDeleteKeepsTheRequest(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	s := NewSessionManager(dir)
	s.hooks = &fileHooks{writeMarker: writeDurable, syncDir: syncDirectory, removeAll: func(p string) error {
		if filepath.Base(p) == "mpl_db" {
			return errors.New("busy")
		}
		return os.RemoveAll(p)
	}}
	if err := s.ClearSession(); err == nil {
		t.Fatal("a failed delete must be reported")
	}
	assertKept(t, dir, logoutMarkerName)
	s.hooks = nil
	if err := s.CompletePendingLogout(); err != nil {
		t.Fatal(err)
	}
	assertGone(t, dir, "mpl_db", logoutMarkerName)
}

func TestSeveralRequestsMergeIntoOnePass(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	write(t, dir, logoutMarkerName, "account")
	write(t, dir, backstopPrefix+strings.Repeat("a", 32), "device")
	write(t, dir, backstopPrefix+strings.Repeat("b", 32), "account")
	write(t, dir, backstopPrefix+strings.Repeat("c", 32)+".tmp", "device") // uncommitted: not a request
	s := NewSessionManager(dir)
	if err := s.CompletePendingLogout(); err != nil {
		t.Fatal(err)
	}
	assertGone(t, dir, deviceNames...)
	assertGone(t, dir, logoutMarkerName, backstopPrefix+strings.Repeat("a", 32), backstopPrefix+strings.Repeat("b", 32))
}

func TestWriteDurableLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	if err := writeDurable(p, []byte("device")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "device" || exists(dir, "f.tmp") {
		t.Fatalf("content %q, tmp left %v", b, exists(dir, "f.tmp"))
	}
}

// ── Failures before anything changes ────────────────────────────────────────

func TestMarkerWriteFailureChangesNothing(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	m := newTestManager(t, dir, b)
	m.session.hooks = &fileHooks{writeMarker: func(string, []byte) error { return errors.New("disk full") }, removeAll: os.RemoveAll, syncDir: syncDirectory}
	before := m.Status()
	if _, err := m.Logout(context.Background()); err == nil {
		t.Fatal("a sign-out that cannot be recorded must fail")
	}
	if !reflect.DeepEqual(before, m.Status()) {
		t.Errorf("snapshot changed:\n%+v\n%+v", before, m.Status())
	}
	if b.stops.Load() != 0 {
		t.Error("the backend must not be stopped")
	}
	assertKept(t, dir, append(append(accountNames, "mpl_db"), deviceNames...)...)
	if m.gateNow() != gateOpen {
		t.Error("the gate must be restored")
	}
}

// ── Sign-in and sign-out ordering ───────────────────────────────────────────

// Signing out while Apple waits for a code returns promptly and completely.
func TestLogoutDuringVerificationCodeIsImmediateAndComplete(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	waiting := make(chan struct{})
	b.startFn = func(_ context.Context, b *fakeBackend) error {
		close(waiting)
		_, err := b.auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeTwoFactor})
		return err
	}
	m := newTestManager(t, dir, b)
	signIn := make(chan error, 1)
	go func() { signIn <- m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}) }()
	<-waiting
	for !m.auth.Pending() {
		time.Sleep(time.Millisecond)
	}
	done := make(chan error, 1)
	go func() { _, err := m.Logout(context.Background()); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Logout: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Logout blocked on the pending verification code")
	}
	if err := <-signIn; err == nil {
		t.Error("the cancelled sign-in must fail")
	}
	assertGone(t, dir, append(accountNames, "mpl_db")...)
	assertKept(t, dir, deviceNames...)
	if (m.auth.stored != Credentials{}) {
		t.Error("sign-out must forget the credentials held in memory")
	}
	if st := m.Status().State; st.Session != SessionEmpty || st.Authentication != AuthLoggedOut {
		t.Errorf("want empty/logged_out, got %v/%v", st.Session, st.Authentication)
	}
}

func TestLogoutWipesEvenWhenStopFails(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	b.stopErr = errors.New("stuck")
	m := newTestManager(t, dir, b)
	if _, err := m.Logout(context.Background()); err == nil {
		t.Error("the stop failure must be reported")
	}
	assertGone(t, dir, append(accountNames, "mpl_db")...)
	noRequests(t, dir)
}

// A sign-in stuck in native code: sign-out leaves the request on disk and asks for
// a restart instead of stopping or deleting under it.
func TestStuckSignInTakesTheRestartPath(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	stuck, entered := make(chan struct{}), make(chan struct{})
	b.startFn = func(context.Context, *fakeBackend) error { close(entered); <-stuck; return nil }
	m := newTestManager(t, dir, b)
	m.timing.AuthWait = 50 * time.Millisecond
	go m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"})
	<-entered

	res, err := m.Logout(context.Background())
	if err == nil || !res.Restart || !m.RestartPending() {
		t.Fatalf("want the restart path: %+v %v", res, err)
	}
	if b.stops.Load() != 0 {
		t.Error("Stop must be skipped while a start is stuck")
	}
	assertKept(t, dir, append(accountNames, logoutMarkerName)...)
	b2 := newFake()
	m2 := newTestManager(t, dir, b2) // a sign-in now must be refused in m: the gate stays closed
	_ = m2
	if err := m.awaitClearGate(context.Background(), true); !errors.Is(err, ErrLogoutPending) {
		t.Errorf("gate must stay closed in the old process: %v", err)
	}
	close(stuck)
	// m2 (the "next process") replayed the request at construction.
	assertGone(t, dir, append(accountNames, logoutMarkerName)...)
	assertKept(t, dir, deviceNames...)
}

// A request left over from an earlier process is consumed before a sign-in starts,
// and the new session survives.
func TestStaleMarkerIsConsumedBeforeSignIn(t *testing.T) {
	dir := t.TempDir()
	b := newFake()
	m := newTestManager(t, dir, b)
	writeSignedIn(t, dir, legacyAndroidID)
	write(t, dir, logoutMarkerName, "account") // appears after construction
	b.startFn = func(context.Context, *fakeBackend) error {
		if exists(dir, logoutMarkerName) {
			return errors.New("started with a request still on disk")
		}
		write(t, dir, "session-ready", "1")
		return nil
	}
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}); err != nil {
		t.Fatal(err)
	}
	assertKept(t, dir, "session-ready")
	noRequests(t, dir)
}

func TestFailedReplayBlocksSignInUntilItSucceeds(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	write(t, dir, logoutMarkerName, "account")
	var fail atomic.Bool
	fail.Store(true)
	s := NewSessionManager(dir)
	s.hooks = &fileHooks{writeMarker: writeDurable, syncDir: syncDirectory, removeAll: func(p string) error {
		if fail.Load() && filepath.Base(p) == "mpl_db" {
			return errors.New("busy")
		}
		return os.RemoveAll(p)
	}}
	b := newFake()
	m := NewDRMManager(b, s, nil, BackendConfig{}, RestartPolicy{StartupTimeout: time.Second, AuthTimeout: time.Second})
	m.timing = fastTiming
	if m.Status().Message != "sign-out incomplete" {
		t.Errorf("want sign-out incomplete at start, got %q", m.Status().Message)
	}
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}); !errors.Is(err, ErrLogoutPending) {
		t.Fatalf("want ErrLogoutPending, got %v", err)
	}
	if err := m.ensureRunning(context.Background()); !errors.Is(err, ErrLogoutPending) {
		t.Fatalf("ensureRunning: want ErrLogoutPending, got %v", err)
	}
	if b.starts.Load() != 0 || (m.auth.stored != Credentials{}) {
		t.Fatal("no start and no stored credentials while the sign-out is incomplete")
	}
	assertKept(t, dir, logoutMarkerName)
	fail.Store(false)
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}); err != nil {
		t.Fatal(err)
	}
	if b.starts.Load() != 1 {
		t.Error("the sign-in must run once the sign-out completed")
	}
	noRequests(t, dir)
}

// The gate is closed and the request recorded as one step: a sign-in arriving in
// between waits on gateMu and is refused.
func TestGateAndMarkerAreAtomicForSignIn(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	m := newTestManager(t, dir, b)
	inWrite, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.session.hooks = &fileHooks{removeAll: os.RemoveAll, syncDir: syncDirectory, writeMarker: func(p string, d []byte) error {
		once.Do(func() { close(inWrite); <-proceed })
		return writeDurable(p, d)
	}}
	logout := make(chan error, 1)
	go func() { _, err := m.Logout(context.Background()); logout <- err }()
	<-inWrite
	signIn := make(chan error, 1)
	go func() { signIn <- m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}) }()
	time.Sleep(20 * time.Millisecond)
	close(proceed)
	if err := <-signIn; !errors.Is(err, ErrLogoutPending) {
		t.Errorf("a sign-in during the gate close must be refused, got %v", err)
	}
	if err := <-logout; err != nil {
		t.Fatal(err)
	}
	if b.starts.Load() != 0 {
		t.Error("no start during the sign-out")
	}
}

func TestSecondSignOutWaitsAndRunsItsOwnScope(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	m := newTestManager(t, dir, newFake())
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.session.hooks = &fileHooks{writeMarker: writeDurable, syncDir: syncDirectory, removeAll: func(p string) error {
		if filepath.Base(p) == "mpl_db" {
			once.Do(func() { close(blocked); <-release })
		}
		return os.RemoveAll(p)
	}}
	first := make(chan error, 1)
	go func() { _, err := m.Logout(context.Background()); first <- err }()
	<-blocked
	second := make(chan error, 1)
	go func() { _, err := m.ForgetDevice(context.Background()); second <- err }()
	time.Sleep(20 * time.Millisecond)
	if b, _ := os.ReadFile(filepath.Join(dir, logoutMarkerName)); string(b) != "account" {
		t.Errorf("the second request must not touch the marker during the first: %q", b)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	assertGone(t, dir, deviceNames...)
	noRequests(t, dir)
}

func TestBackstopWrittenDuringCleanupIsNotLost(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	m := newTestManager(t, dir, newFake())
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.session.hooks = &fileHooks{writeMarker: writeDurable, syncDir: syncDirectory, removeAll: func(p string) error {
		if filepath.Base(p) == "mpl_db" {
			once.Do(func() { close(blocked); <-release })
		}
		return os.RemoveAll(p)
	}}
	done := make(chan error, 1)
	go func() { _, err := m.Logout(context.Background()); done <- err }()
	<-blocked
	write(t, dir, backstopPrefix+strings.Repeat("d", 32), "device")
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	assertGone(t, dir, deviceNames...)
	noRequests(t, dir)
	if m.gateNow() != gateOpen {
		t.Error("gate must open only after the late backstop was completed")
	}
}

func TestBackstopRecoveredByTheNextProcess(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	write(t, dir, backstopPrefix+strings.Repeat("e", 32), "device")
	m := newTestManager(t, dir, newFake())
	assertGone(t, dir, deviceNames...)
	noRequests(t, dir)
	if m.Status().State.Session != SessionEmpty || m.gateNow() != gateOpen {
		t.Errorf("want an empty session and an open gate: %+v", m.Status().State)
	}
}

func TestDirectorySyncFailureKeepsTheGateClosed(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	write(t, dir, logoutMarkerName, "account")
	var fail atomic.Bool
	fail.Store(true)
	s := NewSessionManager(dir)
	s.hooks = &fileHooks{writeMarker: writeDurable, removeAll: os.RemoveAll, syncDir: func(d string) error {
		if fail.Load() {
			return errors.New("EIO")
		}
		return syncDirectory(d)
	}}
	b := newFake()
	m := NewDRMManager(b, s, nil, BackendConfig{}, RestartPolicy{StartupTimeout: time.Second, AuthTimeout: time.Second})
	m.timing = fastTiming
	if m.gateNow() != gateReplaying {
		t.Fatalf("gate must stay closed after a failed sync, got %v", m.gateNow())
	}
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}); !errors.Is(err, ErrLogoutPending) {
		t.Fatalf("want ErrLogoutPending, got %v", err)
	}
	fail.Store(false)
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "p"}); err != nil {
		t.Fatal(err)
	}
	if m.gateNow() != gateOpen || b.starts.Load() != 1 {
		t.Errorf("gate %v, starts %d", m.gateNow(), b.starts.Load())
	}
}

func TestFailedSignOutWipeLeavesReplaying(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	m := newTestManager(t, dir, newFake())
	var fail atomic.Bool
	fail.Store(true)
	m.session.hooks = &fileHooks{writeMarker: writeDurable, syncDir: syncDirectory, removeAll: func(p string) error {
		if fail.Load() && filepath.Base(p) == "mpl_db" {
			return errors.New("busy")
		}
		return os.RemoveAll(p)
	}}
	if _, err := m.Logout(context.Background()); err == nil {
		t.Fatal("the failed wipe must be reported")
	}
	if m.gateNow() != gateReplaying {
		t.Fatalf("want replaying after a failed wipe, got %v", m.gateNow())
	}
	fail.Store(false)
	if err := m.awaitClearGate(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	noRequests(t, dir)
}

func TestNoStartDuringSignOut(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, legacyAndroidID)
	b := newFake()
	b.running.Store(true)
	m := newTestManager(t, dir, b)
	m.gateMu.Lock()
	m.gate = gateSigningOut
	m.gateMu.Unlock()
	if err := m.ensureRunning(context.Background()); !errors.Is(err, ErrLogoutPending) {
		t.Errorf("a running backend must not be reused during sign-out: %v", err)
	}
	b.running.Store(false)
	m.policy.RestartBackoff = []time.Duration{time.Millisecond}
	m.handleCrash()
	if b.starts.Load() != 0 {
		t.Error("a crash restart must not run during sign-out")
	}
}
