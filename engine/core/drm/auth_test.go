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
