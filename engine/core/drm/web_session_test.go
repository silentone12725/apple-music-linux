package drm

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestWebTokenIsReadButIsNotASession(t *testing.T) {
	dir := t.TempDir()
	s := NewSessionManager(dir)
	if s.HasSession() || s.ReadMusicToken() != "" {
		t.Fatal("an empty profile has no session")
	}

	tok := "web-token"
	s.SetWebSession(func() (string, string) { return tok, "us" })
	if s.HasSession() {
		t.Fatal("a web-player token alone must not count as a sign-in")
	}
	if s.ReadMusicToken() != "web-token" || s.ReadStorefrontID() != "us" {
		t.Fatalf("the web token must still be readable: token=%q sf=%q", s.ReadMusicToken(), s.ReadStorefrontID())
	}

	// Credential files, when present, still win over the web token.
	os.WriteFile(filepath.Join(dir, "MUSIC_TOKEN"), []byte("file-token\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "STOREFRONT_ID"), []byte("143467-2,31\n"), 0o600)
	if s.ReadMusicToken() != "file-token" || s.ReadStorefrontID() != "143467-2,31" {
		t.Fatalf("files must take precedence: %q %q", s.ReadMusicToken(), s.ReadStorefrontID())
	}
}

func TestLoginDatabaseAloneIsNotASession(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "mpl_db"), 0o700)
	os.WriteFile(filepath.Join(dir, "mpl_db", "accounts.sqlitedb"), make([]byte, 4096), 0o600)
	if NewSessionManager(dir).HasSession() {
		t.Fatal("the Android library's stub login database must not count as a session")
	}
}

func TestClearSessionLeavesNoLogoutMarker(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	os.WriteFile(filepath.Join(dir, "MUSIC_TOKEN"), []byte("tok"), 0o600)
	if err := NewSessionManager(dir).ClearSession(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"logout-pending", "session-ready", "MUSIC_TOKEN"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s must be gone after a completed logout: %v", name, err)
		}
	}
}

// A logout interrupted after the marker was written is finished on the next start.
func TestCompletePendingLogoutFinishesAnInterruptedLogout(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "logout-pending"), []byte("1"), 0o600)
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	os.MkdirAll(filepath.Join(dir, "mpl_db"), 0o700)
	s := NewSessionManager(dir)
	s.CompletePendingLogout()
	for _, name := range []string{"logout-pending", "session-ready", "mpl_db"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s must be removed: %v", name, err)
		}
	}
	if s.HasSession() {
		t.Fatal("the interrupted logout must leave no session")
	}
}

func TestCompletePendingLogoutKeepsALiveSession(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	s := NewSessionManager(dir)
	s.CompletePendingLogout()
	if !s.HasSession() {
		t.Fatal("without a logout-pending marker the session must be left alone")
	}
}

type startCounter struct {
	crashStub
	starts atomic.Int32
}

func (c *startCounter) Start(context.Context, BackendConfig) error { c.starts.Add(1); return nil }

func newWebManager(t *testing.T, tok *atomic.Pointer[string]) (*DRMManager, *startCounter) {
	t.Helper()
	m, stub, _ := newWebManagerIn(t, t.TempDir(), tok)
	return m, stub
}

func newWebManagerIn(t *testing.T, dir string, tok *atomic.Pointer[string]) (*DRMManager, *startCounter, string) {
	t.Helper()
	stub := &startCounter{crashStub: crashStub{events: make(chan DRMEvent)}}
	m := NewDRMManager(stub, NewSessionManager(dir), nil, BackendConfig{}, RestartPolicy{StartupTimeout: time.Second})
	m.SetWebSession(func() (string, string) {
		if p := tok.Load(); p != nil {
			return *p, ""
		}
		return "", ""
	})
	return m, stub, dir
}

func TestInitialStatusIsStoppedNotUnknown(t *testing.T) {
	var tok atomic.Pointer[string]
	m, _ := newWebManager(t, &tok)
	st := m.Status().State
	if st.Process != ProcessStopped {
		t.Errorf("an idle, lazily started backend is stopped, got %v", st.Process)
	}
	if st.Session != SessionEmpty || st.Authentication != AuthLoggedOut {
		t.Errorf("no token yet: want empty/logged_out, got %v/%v", st.Session, st.Authentication)
	}
}

// A signed-out engine stays signed out while the page keeps sending its token;
// only a real sign-in (session-ready) lets the token start the backend.
func TestWebTokenStartsTheBackendOnlyWhenSignedIn(t *testing.T) {
	var tok atomic.Pointer[string]
	m, stub, dir := newWebManagerIn(t, t.TempDir(), &tok)

	v := "web-token"
	tok.Store(&v)
	m.NoteWebSession()
	time.Sleep(50 * time.Millisecond)
	if stub.starts.Load() != 0 || m.Status().State.Session != SessionEmpty || m.Status().State.Authentication != AuthLoggedOut {
		t.Fatalf("a web token without a sign-in must not start the backend or report a session: starts=%d state=%+v",
			stub.starts.Load(), m.Status().State)
	}

	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	m.NoteWebSession()
	deadline := time.Now().Add(2 * time.Second)
	for stub.starts.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if stub.starts.Load() != 1 {
		t.Fatalf("a signed-in engine must start once the web token appears, starts=%d", stub.starts.Load())
	}
	st := m.Status().State
	if st.Session != SessionValid || st.Authentication != AuthLoggedIn {
		t.Errorf("want valid/logged_in, got %v/%v", st.Session, st.Authentication)
	}
}

func TestNoteWebSessionAfterShutdownDoesNothing(t *testing.T) {
	var tok atomic.Pointer[string]
	m, stub, dir := newWebManagerIn(t, t.TempDir(), &tok)
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	v := "t"
	tok.Store(&v)
	m.Shutdown()
	m.NoteWebSession()
	time.Sleep(50 * time.Millisecond)
	if stub.starts.Load() != 0 {
		t.Fatal("a closed manager must not start the backend")
	}
}

// Each announced challenge gets a new ID, so the client can tell a re-ask
// (wrong code) from the same challenge carried in later snapshots.
func TestChallengesAreNumbered(t *testing.T) {
	var ids []uint64
	var a *AuthCoordinator
	a = NewAuthCoordinator(func(s DRMSnapshot) {
		if s.Challenge != nil {
			ids = append(ids, s.Challenge.ID)
			a.SubmitReply("123456")
		}
	})
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if _, err := a.Challenge(ctx, AuthChallenge{Type: ChallengeTwoFactor}); err != nil {
			t.Fatal(err)
		}
		cancel()
	}
	if len(ids) != 2 || ids[0] == 0 || ids[1] == ids[0] {
		t.Fatalf("challenge IDs %v, want two distinct non-zero IDs", ids)
	}
}

func TestAnsweredChallengeIsWithdrawn(t *testing.T) {
	var last DRMSnapshot
	var a *AuthCoordinator
	a = NewAuthCoordinator(func(s DRMSnapshot) {
		last = s
		if s.Challenge != nil {
			a.SubmitReply("123456")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := a.Challenge(ctx, AuthChallenge{Type: ChallengeTwoFactor}); err != nil {
		t.Fatal(err)
	}
	if last.Challenge != nil || last.State.Authentication != AuthLoggingIn {
		t.Fatalf("after the reply the snapshot still asks for a code: %+v", last)
	}
}

// A sign-out removes the account and keeps the device identity, as Apple's own
// apps do: otherwise every sign-in is a new device that must be verified again.
func TestClearSessionKeepsDeviceIdentity(t *testing.T) {
	dir := t.TempDir()
	account := []string{"33F633BF6AC7D676168B84C3594A7941AF2BEC09", "2fa.txt", "session-ready", "MUSIC_TOKEN"}
	keep := []string{"adi.pb", "IC-Info.sids", "fsi.pdat", "device-id", "engine-session.lock", "33f633bf6ac7d676168b84c3594a7941af2bec09", "notes.txt"}
	if runtime.GOOS == "windows" {
		// Case-insensitive file names: the upper- and lower-case hash are one file there.
		keep = []string{"adi.pb", "IC-Info.sids", "fsi.pdat", "device-id", "engine-session.lock", "notes.txt"}
		account = account[1:]
	}
	for _, n := range append(append([]string{}, account...), keep...) {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600)
	}
	if err := NewSessionManager(dir).ClearSession(); err != nil {
		t.Fatal(err)
	}
	for _, n := range account {
		if _, err := os.Stat(filepath.Join(dir, n)); !os.IsNotExist(err) {
			t.Errorf("%s survived sign-out", n)
		}
	}
	for _, n := range keep {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%s must be kept: %v", n, err)
		}
	}
}
