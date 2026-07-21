package drm

import (
	"context"
	"fmt"
	"sync"
)

// AuthCoordinator implements AuthSource and bridges the engine's intent API
// (Login, SubmitChallenge) with the backend's credential callbacks
// (credentialHandler in main.c via ExternalBackend or EmbeddedBackend).
//
// The coordination model:
//
//  1. DRMManager.Login stores credentials via SetCredentials.
//  2. The backend starts and eventually calls AuthSource.Challenge.
//  3. Challenge broadcasts a DRMSnapshot{Auth:AuthChallenging} to SSE.
//  4. The browser receives the challenge and calls POST /api/v1/drm/challenge.
//  5. DRMManager.SubmitChallenge calls AuthCoordinator.SubmitReply.
//  6. SubmitReply unblocks Challenge, which returns the reply to the backend.
//
// For credential challenges (ChallengeCredentials), Challenge returns
// "email\x00password" without waiting — credentials were set in advance.
// For 2FA and device-approval challenges, Challenge blocks until SubmitReply.
type AuthCoordinator struct {
	stored  Credentials
	replies chan string // SubmitReply sends here; Challenge reads here
	mu      sync.Mutex
	emitter func(DRMSnapshot) // set by DRMManager to emit snapshots to SSE
}

// NewAuthCoordinator creates an AuthCoordinator.
// emitter is called to broadcast challenge snapshots to SSE clients.
func NewAuthCoordinator(emitter func(DRMSnapshot)) *AuthCoordinator {
	return &AuthCoordinator{
		replies: make(chan string, 1),
		emitter: emitter,
	}
}

// SetCredentials stores credentials for the next authentication attempt.
// Called by DRMManager.Login before starting the backend.
func (a *AuthCoordinator) SetCredentials(creds Credentials) {
	a.mu.Lock()
	a.stored = creds
	a.mu.Unlock()
}

// SubmitReply delivers a challenge reply from the browser (e.g. a 2FA code).
// Returns an error if no challenge is currently pending.
func (a *AuthCoordinator) SubmitReply(reply string) error {
	select {
	case a.replies <- reply:
		return nil
	default:
		return fmt.Errorf("no authentication challenge pending")
	}
}

// Challenge implements AuthSource. Called by the backend when input is needed.
//
// For ChallengeCredentials: returns stored credentials immediately without
// blocking. Reply format: "email\x00password".
//
// For all other challenge types: emits a DRMSnapshot to SSE (so the browser
// knows to prompt the user), then blocks until SubmitReply is called or
// ctx is cancelled.
func (a *AuthCoordinator) Challenge(ctx context.Context, req AuthChallenge) (string, error) {
	if req.Type == ChallengeCredentials {
		a.mu.Lock()
		email := a.stored.Email
		pass := a.stored.Password
		a.mu.Unlock()
		if email != "" {
			return email + "\x00" + pass, nil
		}
		// No credentials stored — emit SSE so the frontend shows the sign-in
		// form automatically, then return empty to let the binary's own auth
		// error path fire. Authenticate() will restart with --login once the
		// user submits credentials.
		if a.emitter != nil {
			a.emitter(DRMSnapshot{
				State:     DRMState{Authentication: AuthChallenging},
				Challenge: &req,
			})
		}
		return "\x00", nil
	}

	// Emit challenge to SSE so the browser knows to prompt the user.
	if a.emitter != nil {
		a.emitter(DRMSnapshot{
			State:     DRMState{Authentication: AuthChallenging},
			Challenge: &req,
		})
	}

	// Drain any stale reply that might be sitting in the channel.
	select {
	case <-a.replies:
	default:
	}

	// Wait for the browser to call SubmitReply.
	select {
	case reply := <-a.replies:
		return reply, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
