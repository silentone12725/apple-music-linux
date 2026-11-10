package drm

import (
	"context"
	"fmt"
	"sync"
)

// AuthCoordinator implements AuthSource and bridges the engine's intent API
// (Login, SubmitChallenge) with the backend's credential callbacks
// (adamplayBridgeAuth CGO callback in AdamplayBackend).
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
	pending chan string // non-nil only while a challenge awaits a reply
	mu      sync.Mutex
	emitter func(DRMSnapshot) // set by DRMManager to emit snapshots to SSE
	seq     uint64            // numbers each announced challenge (AuthChallenge.ID)
	// cancelPending ends the challenge waiting in pending; aborted makes further
	// verification-code challenges fail at once until the next SetCredentials.
	cancelPending context.CancelFunc
	aborted       bool
}

// NewAuthCoordinator creates an AuthCoordinator.
// emitter is called to broadcast challenge snapshots to SSE clients.
func NewAuthCoordinator(emitter func(DRMSnapshot)) *AuthCoordinator {
	return &AuthCoordinator{
		emitter: emitter,
	}
}

// SetCredentials stores credentials for the next authentication attempt.
// Called by DRMManager.Login before starting the backend.
func (a *AuthCoordinator) SetCredentials(creds Credentials) {
	a.mu.Lock()
	a.stored = creds
	a.aborted = false
	a.mu.Unlock()
}

// ClearCredentials forgets the stored credentials once a sign-in attempt is over, so a
// later request for credentials cannot silently resubmit an old password.
func (a *AuthCoordinator) ClearCredentials() {
	a.mu.Lock()
	a.stored = Credentials{}
	a.mu.Unlock()
}

// Abort ends a sign-in in progress: it forgets the stored credentials, ends a
// pending verification-code challenge (the backend gets no code and that sign-in
// attempt fails) and refuses further code challenges until SetCredentials is
// called again. Logout calls it first, because stopping the backend waits for a
// sign-in that is blocked on a challenge.
func (a *AuthCoordinator) Abort() {
	a.mu.Lock()
	a.stored = Credentials{}
	a.aborted = true
	cancel := a.cancelPending
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// SubmitReply delivers a challenge reply from the browser (e.g. a 2FA code).
// Returns an error if no challenge is currently pending.
func (a *AuthCoordinator) SubmitReply(reply string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		return fmt.Errorf("no authentication challenge pending")
	}
	select {
	case a.pending <- reply:
		// A challenge accepts exactly one reply.
		a.pending = nil
		return nil
	default:
		return fmt.Errorf("authentication challenge already answered")
	}
}

// Pending reports whether the backend is waiting for user input.
func (a *AuthCoordinator) Pending() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pending != nil
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

	if err := ctx.Err(); err != nil {
		return "", err
	}
	// Each challenge gets its own reply channel, registered before it is announced, so a reply
	// the browser sends right after the announcement is accepted and a stale or duplicate one
	// (no challenge pending, or already answered) is rejected.
	replies := make(chan string, 1)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.mu.Lock()
	if a.aborted {
		a.mu.Unlock()
		return "", fmt.Errorf("sign-in cancelled")
	}
	if a.pending != nil {
		a.mu.Unlock()
		return "", fmt.Errorf("authentication challenge already pending")
	}
	a.pending = replies
	a.cancelPending = cancel
	a.seq++
	req.ID = a.seq
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		if a.pending == replies {
			a.pending = nil
			a.cancelPending = nil
		}
		a.mu.Unlock()
	}()

	// Emit challenge to SSE so the browser knows to prompt the user.
	if a.emitter != nil {
		a.emitter(DRMSnapshot{
			State:     DRMState{Authentication: AuthChallenging},
			Challenge: &req,
		})
	}

	// Wait for the browser to call SubmitReply.
	select {
	case reply := <-replies:
		// Answered: drop the challenge from the snapshot while Apple checks the
		// reply, so a reloaded page does not ask for the same code again.
		if a.emitter != nil {
			a.emitter(DRMSnapshot{State: DRMState{Authentication: AuthLoggingIn}})
		}
		return reply, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
