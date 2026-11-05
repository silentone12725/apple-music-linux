package drm

import (
	"context"
	"errors"
	"testing"
)

func TestVerificationDigits(t *testing.T) {
	for in, want := range map[string]string{
		"123456":    "123456",
		"123 456":   "123456",
		"123-456\n": "123456",
		" 12 3456":  "123456",
		"abc":       "",
		"":          "",
	} {
		if got := verificationDigits(in); got != want {
			t.Errorf("verificationDigits(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSetupErrors(t *testing.T) {
	err := setupError("the FairPlay libraries are not installed (%s)", "/x")
	if !IsSetupError(err) {
		t.Fatalf("%q must be a setup error", err)
	}
	if !IsSetupError(errors.New("authenticate: " + err.Error())) {
		t.Fatal("a wrapped setup error must still be recognised from its message")
	}
	if IsSetupError(errors.New("Apple rejected the sign-in")) || IsSetupError(nil) {
		t.Fatal("an account failure is not a setup error")
	}
}

// A finished sign-in must not leave the password where a later credentials request
// would silently resubmit it.
func TestAuthenticateForgetsCredentials(t *testing.T) {
	for name, startErr := range map[string]error{"success": nil, "failure": errors.New("Apple rejected the sign-in")} {
		t.Run(name, func(t *testing.T) {
			b := newFake()
			var seen string
			b.startFn = func(ctx context.Context, b *fakeBackend) error {
				reply, _ := b.auth.Challenge(ctx, AuthChallenge{Type: ChallengeCredentials})
				seen = reply
				return startErr
			}
			m := newTestManager(t, t.TempDir(), b)
			_ = m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"})
			if seen != "a@b.c\x00pw" {
				t.Fatalf("the backend was not offered the credentials during sign-in: %q", seen)
			}
			reply, _ := b.auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeCredentials})
			if reply != "\x00" {
				t.Fatalf("credentials still stored after the sign-in: %q", reply)
			}
		})
	}
}

// The web player's token must not report "logged in" while a sign-in is running: an older
// session marker would close the sign-in sheet before Apple has answered.
func TestWebSessionDoesNotAnswerForARunningSignIn(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "session-ready", "1")
	b := newFake()
	m := newTestManager(t, dir, b)
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthLoggingIn}})
	m.NoteWebSession()
	if got := m.Status().State.Authentication; got != AuthLoggingIn {
		t.Fatalf("a web session overwrote the running sign-in: %v", got)
	}
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthFailed}})
	m.NoteWebSession()
	if got := m.Status().State.Authentication; got != AuthLoggedIn {
		t.Fatalf("with no sign-in running the marker should report logged in, got %v", got)
	}
}

func TestOnlyOneSignInAtATime(t *testing.T) {
	b := newFake()
	started, release := make(chan struct{}), make(chan struct{})
	b.startFn = func(context.Context, *fakeBackend) error { close(started); <-release; return nil }
	m := newTestManager(t, t.TempDir(), b)
	done := make(chan error, 1)
	go func() { done <- m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"}) }()
	<-started
	if !m.SignInRunning() {
		t.Fatal("SignInRunning is false while a sign-in is running")
	}
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"}); !errors.Is(err, ErrSignInRunning) {
		t.Fatalf("second sign-in got %v, want ErrSignInRunning", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if m.SignInRunning() {
		t.Fatal("SignInRunning stays true after the sign-in ended")
	}
}

func TestClassifySignInError(t *testing.T) {
	for in, want := range map[string]FailureKind{
		"Forgot Your Password?: It has been incorrectly entered more than once. Tap Get Password to retrieve or reset it.": FailLocked,
		"authenticate: Check the account information you entered and try again.":                                           FailInvalidCredentials,
		"You must agree to the Terms and Conditions":                                                                       FailTerms,
		"This Apple Account has not yet been used with the iTunes Store":                                                   FailNotStoreAccount,
		"sign-in timed out: context deadline exceeded":                                                                     FailTimeout,
		"Apple rejected the sign-in":                                                                                       FailUnknown,
	} {
		if got := ClassifySignInError(errors.New(in)).Kind; got != want {
			t.Errorf("%q classified as %q, want %q", in, got, want)
		}
	}
	setup := ClassifySignInError(setupError("the FairPlay libraries are not installed"))
	if setup.Kind != FailSetup || setup.Message != "the FairPlay libraries are not installed" {
		t.Fatalf("setup error classified as %+v", setup)
	}
	if f := ClassifySignInError(errors.New("Forgot Your Password?")); f.URL == "" || f.Message == "" {
		t.Fatalf("a locked account must say what to do and where: %+v", f)
	}
}

func TestSignInPauseAfterRepeatedRejections(t *testing.T) {
	dir := t.TempDir()
	s := NewSessionManager(dir)
	wrong := SignInFailure{Kind: FailInvalidCredentials}
	s.NoteSignInOutcome(false, SignInFailure{Kind: FailUnknown})
	s.NoteSignInOutcome(false, SignInFailure{Kind: FailSetup})
	s.NoteSignInOutcome(false, wrong)
	if !s.SignInPausedUntil().IsZero() {
		t.Fatal("paused after one wrong password")
	}
	s.NoteSignInOutcome(false, wrong)
	if s.SignInPausedUntil().IsZero() {
		t.Fatal("not paused after the second wrong password")
	}
	if got := NewSessionManager(dir).SignInPausedUntil(); got.IsZero() {
		t.Fatal("the pause must survive a restart")
	}
	s.NoteSignInOutcome(true, SignInFailure{})
	if !s.SignInPausedUntil().IsZero() {
		t.Fatal("a successful sign-in must lift the pause")
	}
	s.NoteSignInOutcome(false, SignInFailure{Kind: FailLocked})
	if s.SignInPausedUntil().IsZero() {
		t.Fatal("a locked account must pause at once")
	}
}

func TestAuthenticateRefusesWhilePausedAndCancelIsNotAFailure(t *testing.T) {
	dir := t.TempDir()
	b := newFake()
	m := newTestManager(t, dir, b)
	m.session.NoteSignInOutcome(false, SignInFailure{Kind: FailLocked})
	var paused *SignInPausedError
	if err := m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"}); !errors.As(err, &paused) {
		t.Fatalf("got %v, want a SignInPausedError", err)
	}
	if b.starts.Load() != 0 {
		t.Fatal("a paused sign-in reached the backend")
	}

	m.session.NoteSignInOutcome(true, SignInFailure{})
	b.startFn = func(context.Context, *fakeBackend) error { return ErrSignInCancelled }
	_ = m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"})
	st := m.Status()
	if st.State.Authentication != AuthLoggedOut || st.Failure != nil {
		t.Fatalf("a cancelled sign-in must end signed out without a failure: %+v", st)
	}
	if !m.session.SignInPausedUntil().IsZero() {
		t.Fatal("a cancelled sign-in counted against the account")
	}

	b.startFn = func(context.Context, *fakeBackend) error {
		return errors.New("Check the account information you entered and try again.")
	}
	_ = m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "pw"})
	if f := m.Status().Failure; f == nil || f.Kind != FailInvalidCredentials {
		t.Fatalf("failure not published with the snapshot: %+v", f)
	}
}
