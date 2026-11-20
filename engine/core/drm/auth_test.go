package drm

import (
	"context"
	"errors"
	"testing"
)

func TestAuthCoordinatorRejectsUnsolicitedAndDuplicateReplies(t *testing.T) {
	var auth *AuthCoordinator
	auth = NewAuthCoordinator(func(s DRMSnapshot) {
		if s.Challenge == nil {
			return // the "answered" update that withdraws the challenge
		}
		if err := auth.SubmitReply("123456"); err != nil {
			t.Fatalf("reply immediately after prompt: %v", err)
		}
		if err := auth.SubmitReply("654321"); err == nil {
			t.Fatal("duplicate reply accepted")
		}
	})
	if err := auth.SubmitReply("stale"); err == nil {
		t.Fatal("unsolicited reply accepted")
	}
	for range 2 {
		reply, err := auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeTwoFactor})
		if err != nil || reply != "123456" {
			t.Fatalf("repeated challenge: reply=%q err=%v", reply, err)
		}
	}
	if err := auth.SubmitReply("stale"); err == nil {
		t.Fatal("completed challenge accepted reply")
	}
}

func TestAuthCoordinatorCanceledChallengeDoesNotLeakReply(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	auth := NewAuthCoordinator(func(DRMSnapshot) { cancel() })
	if _, err := auth.Challenge(ctx, AuthChallenge{Type: ChallengeTwoFactor}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if err := auth.SubmitReply("123456"); err == nil {
		t.Fatal("canceled challenge accepted reply")
	}
}

func TestAuthCoordinatorUnattendedSignInNeverPromptsForACode(t *testing.T) {
	announced := 0
	auth := NewAuthCoordinator(func(s DRMSnapshot) {
		if s.Challenge != nil {
			announced++
		}
	})
	auth.SetCredentials(Credentials{Email: "a@b.c", Password: "pw", Unattended: true})

	// The password step still works: Apple gets the saved details.
	reply, err := auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeCredentials})
	if err != nil || reply != "a@b.c\x00pw" {
		t.Fatalf("credentials: reply=%q err=%v", reply, err)
	}
	for _, typ := range []AuthChallengeType{ChallengeTwoFactor, ChallengeDialogChoice} {
		if _, err := auth.Challenge(context.Background(), AuthChallenge{Type: typ}); err == nil {
			t.Fatalf("type %v: an unattended sign-in was asked for input", typ)
		}
	}
	if announced != 0 || auth.Pending() {
		t.Fatalf("a prompt was announced (%d) or left pending", announced)
	}

	// The next, attended sign-in prompts as usual: the flag does not outlive the attempt.
	auth.ClearCredentials()
	auth.SetCredentials(Credentials{Email: "a@b.c", Password: "pw"})
	go func() {
		for !auth.Pending() {
		}
		_ = auth.SubmitReply("123456")
	}()
	reply, err = auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeTwoFactor})
	if err != nil || reply != "123456" || announced != 1 {
		t.Fatalf("attended challenge: reply=%q err=%v announced=%d", reply, err, announced)
	}
}

func TestAuthCoordinatorWithdrawsAChallengeThatEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var snaps []DRMSnapshot
	auth := NewAuthCoordinator(func(s DRMSnapshot) {
		snaps = append(snaps, s)
		if s.Challenge != nil {
			cancel() // the wait ends (timeout) right after the prompt is shown
		}
	})
	if _, err := auth.Challenge(ctx, AuthChallenge{Type: ChallengeTwoFactor}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	last := snaps[len(snaps)-1]
	if last.Challenge != nil || last.State.Authentication != AuthSigningIn {
		t.Fatalf("the form was left asking for a code: %+v", last)
	}
}

func TestAuthCoordinatorAbortedSignInRaisesNoCredentialForm(t *testing.T) {
	announced := 0
	auth := NewAuthCoordinator(func(DRMSnapshot) { announced++ })
	auth.Abort()
	reply, err := auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeCredentials})
	if err != nil || reply != "\x00" || announced != 0 {
		t.Fatalf("reply=%q err=%v announced=%d", reply, err, announced)
	}
}

func TestWrongVerificationCodeIsNotAWrongPassword(t *testing.T) {
	f := ClassifySignInError(errors.New("The verification code is incorrect."))
	if f.Kind != FailBadCode {
		t.Fatalf("kind=%s", f.Kind)
	}
	s := NewSessionManager(t.TempDir())
	s.NoteSignInOutcome(false, f)
	s.NoteSignInOutcome(false, f)
	if !s.SignInPausedUntil().IsZero() {
		t.Fatal("wrong codes paused sign-ins")
	}
}

func TestCancelSignInOnlyActsOnARunningSignIn(t *testing.T) {
	m := newMergeManager(t)
	if m.CancelSignIn() {
		t.Fatal("cancelled a sign-in that was not running")
	}
	// An idle cancel must not poison the next sign-in's challenges.
	m.auth.SetCredentials(Credentials{Email: "a@b.c", Password: "pw"})
	if reply, err := m.auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeCredentials}); err != nil || reply != "a@b.c\x00pw" {
		t.Fatalf("reply=%q err=%v", reply, err)
	}

	m.signingIn.Store(true)
	if !m.CancelSignIn() {
		t.Fatal("running sign-in not cancelled")
	}
	if _, err := m.auth.Challenge(context.Background(), AuthChallenge{Type: ChallengeTwoFactor}); err == nil {
		t.Fatal("verification code still requested after cancel")
	}
}
