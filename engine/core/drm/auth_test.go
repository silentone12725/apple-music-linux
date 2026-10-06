package drm

import (
	"context"
	"errors"
	"testing"
)

func TestAuthCoordinatorRejectsUnsolicitedAndDuplicateReplies(t *testing.T) {
	var auth *AuthCoordinator
	auth = NewAuthCoordinator(func(DRMSnapshot) {
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

func TestNativeAuthChallengeProtocol(t *testing.T) {
	for kind, want := range map[string]AuthChallengeType{"credentials": ChallengeCredentials, "2fa": ChallengeTwoFactor, "device_approval": ChallengeDeviceApproval} {
		challenge, ok := nativeAuthChallenge(kind)
		if !ok || challenge.Type != want || challenge.Title == "" {
			t.Fatalf("%s: %+v supported=%v", kind, challenge, ok)
		}
	}
	if _, ok := nativeAuthChallenge("unknown"); ok {
		t.Fatal("unknown native challenge accepted")
	}
}
