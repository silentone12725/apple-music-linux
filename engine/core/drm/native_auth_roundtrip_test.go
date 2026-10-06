//go:build linux && native_backend && drm_testhelpers

package drm

import (
	"context"
	"testing"
)

func TestNativeAuthCallbackCGORoundTrip(t *testing.T) {
	var auth *AuthCoordinator
	auth = NewAuthCoordinator(func(snap DRMSnapshot) {
		if snap.Challenge.Type != ChallengeTwoFactor {
			t.Fatal("expected Apple 2FA prompt")
		}
		if err := auth.SubmitReply("654321"); err != nil {
			t.Fatal(err)
		}
	})
	if got := nativeAuthRoundTrip(context.Background(), auth, "2fa", 7); got != "654321" {
		t.Fatalf("C callback response: %q", got)
	}
	if got := nativeAuthRoundTrip(context.Background(), auth, "2fa", 6); got != "" {
		t.Fatalf("overflow response: %q", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := nativeAuthRoundTrip(ctx, auth, "2fa", 7); got != "" {
		t.Fatalf("canceled response: %q", got)
	}
}
