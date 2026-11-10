package drm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrSignInCancelled is returned when a sign-in ended because no verification code was given
// (the user cancelled, or the wait ran out). It is not a failure of the account.
var ErrSignInCancelled = errors.New("sign-in cancelled")

// FailureKind says why a sign-in did not complete, in terms the UI can act on.
type FailureKind string

const (
	FailInvalidCredentials FailureKind = "invalid_credentials"
	FailLocked             FailureKind = "locked"
	FailTerms              FailureKind = "terms"
	FailNotStoreAccount    FailureKind = "not_store_account"
	FailTimeout            FailureKind = "timeout"
	FailSetup              FailureKind = "setup"
	FailUnknown            FailureKind = "unknown"
)

// SignInFailure is the classified outcome of a failed sign-in, published with the DRM snapshot.
type SignInFailure struct {
	Kind    FailureKind `json:"kind"`
	Message string      `json:"message"`       // fit to show the user as is
	URL     string      `json:"url,omitempty"` // where to fix it, when there is such a place
}

// ClassifySignInError turns what the backend reported (Apple's own wording where it gave
// some) into a SignInFailure. Matching is on Apple's text because its numeric error codes
// are not readable from the library.
func ClassifySignInError(err error) SignInFailure {
	raw := strings.TrimPrefix(err.Error(), "authenticate: ")
	if IsSetupError(err) {
		return SignInFailure{Kind: FailSetup, Message: strings.TrimPrefix(raw, SetupErrorPrefix)}
	}
	t := strings.ToLower(raw)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(t, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("forgot your password", "more than once", "too many", "locked", "disabled", "temporarily"):
		return SignInFailure{FailLocked, "Apple has blocked sign-ins for now after several wrong attempts. Wait a while, or reset your password, then try again.", "https://iforgot.apple.com"}
	case has("terms", "agree"):
		return SignInFailure{FailTerms, "Apple needs you to accept its terms before this account can sign in. Accept them at account.apple.com, then try again.", "https://account.apple.com"}
	case has("not yet been used", "has not been used", "never been used", "itunes store", "not been set up"):
		return SignInFailure{FailNotStoreAccount, "This Apple Account has not been used with Apple Music yet. Open music.apple.com, sign in once to set it up, then try again.", "https://music.apple.com"}
	case has("check the account information", "incorrect", "invalid", "wrong password", "verification failed"):
		return SignInFailure{FailInvalidCredentials, "Apple did not accept that email and password. Check them and try again.", "https://iforgot.apple.com"}
	case has("timed out", "deadline exceeded", "did not answer"):
		return SignInFailure{Kind: FailTimeout, Message: "Apple did not answer in time. Check your connection and try again."}
	}
	return SignInFailure{Kind: FailUnknown, Message: raw}
}

// ── Attempt limiter ───────────────────────────────────────────────────────────
//
// Apple counts wrong passwords per account and answers "Forgot Your Password?" after two. The
// engine therefore stops sending sign-ins for a while after repeated rejections, also across
// restarts (restarting the app and trying again is how an account gets locked). The state lives
// in a file next to the session, which a sign-out leaves alone.

const (
	pauseFileName       = "signin-pause"
	maxWrongAttempts    = 2
	pauseAfterWrong     = 15 * time.Minute
	pauseAfterLocked    = 30 * time.Minute
	wrongAttemptsExpire = 24 * time.Hour
)

type pauseState struct {
	Failures int       `json:"failures"`
	Last     time.Time `json:"last"`
	Until    time.Time `json:"until"`
}

// SignInPausedError is returned by Authenticate while sign-ins are paused.
type SignInPausedError struct{ Until time.Time }

func (e *SignInPausedError) Error() string {
	d := time.Until(e.Until).Round(time.Minute)
	if d < time.Minute {
		d = time.Minute
	}
	return fmt.Sprintf("Sign-in is paused for %d more minutes to protect your Apple Account from being locked. Reset your password at iforgot.apple.com if you are unsure of it.", int(d.Minutes()))
}

func (s *SessionManager) pausePath() string { return filepath.Join(s.baseDir, pauseFileName) }

func (s *SessionManager) readPause() pauseState {
	var p pauseState
	if b, err := os.ReadFile(s.pausePath()); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

// SignInPausedUntil returns when sign-ins resume; the zero time means they are not paused.
func (s *SessionManager) SignInPausedUntil() time.Time {
	if p := s.readPause(); time.Now().Before(p.Until) {
		return p.Until
	}
	return time.Time{}
}

// NoteSignInOutcome records how a sign-in ended. Only rejections count: a cancelled,
// timed-out or broken-install sign-in says nothing about the password.
func (s *SessionManager) NoteSignInOutcome(success bool, f SignInFailure) {
	if success {
		_ = os.Remove(s.pausePath())
		return
	}
	if f.Kind != FailInvalidCredentials && f.Kind != FailLocked {
		return
	}
	p := s.readPause()
	if time.Since(p.Last) > wrongAttemptsExpire || (!p.Until.IsZero() && time.Now().After(p.Until)) {
		p = pauseState{}
	}
	p.Failures++
	p.Last = time.Now()
	switch {
	case f.Kind == FailLocked:
		p.Until = time.Now().Add(pauseAfterLocked)
	case p.Failures >= maxWrongAttempts:
		p.Until = time.Now().Add(pauseAfterWrong)
	}
	if b, err := json.Marshal(p); err == nil {
		_ = os.WriteFile(s.pausePath(), b, 0o600)
	}
}
