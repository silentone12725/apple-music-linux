//go:build linux && native_backend

package drm

import (
	"context"
	"testing"
)

func TestNativeAuthSessionAnswersAppleTwoFactorChallenge(t *testing.T) {
	var auth *AuthCoordinator
	auth = NewAuthCoordinator(func(snap DRMSnapshot) {
		if snap.Challenge == nil || snap.Challenge.Type != ChallengeTwoFactor {
			t.Fatal("native challenge did not produce 2FA prompt")
		}
		if err := auth.SubmitReply("123456"); err != nil {
			t.Fatal(err)
		}
	})
	session := nativeAuthSession{ctx: context.Background(), source: auth}
	if got := session.reply("2fa", 7); got != "123456" {
		t.Fatalf("native reply = %q", got)
	}
	if got := session.reply("2fa", 6); got != "" {
		t.Fatalf("truncated native reply = %q", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	session.ctx = ctx
	if got := session.reply("2fa", 7); got != "" {
		t.Fatalf("canceled native reply = %q", got)
	}
	if got := session.reply("unsupported", 7); got != "" {
		t.Fatalf("unknown native reply = %q", got)
	}
}
