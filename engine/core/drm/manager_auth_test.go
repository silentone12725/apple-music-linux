package drm

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestManagerKeepsChallengeThroughUnrelatedStateEvents(t *testing.T) {
	b := &crashStub{events: make(chan DRMEvent)}
	m := NewDRMManager(b, NewSessionManager(t.TempDir()), nil, BackendConfig{}, DefaultRestartPolicy)
	t.Cleanup(m.shutdownStop)
	challenge := &AuthChallenge{Type: ChallengeTwoFactor, Title: "Verification code"}
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthChallenging}, Challenge: challenge})
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Process: ProcessStarting}, Message: "initializing"})
	if got := m.Status(); got.Challenge == nil || got.State.Authentication != AuthChallenging {
		t.Fatalf("prompt lost by state-only update: %+v", got)
	}
	m.mergeAndEmit(DRMSnapshot{State: DRMState{FairPlay: FairPlayReady}})
	m.mergeAndEmit(DRMSnapshot{State: DRMState{FairPlay: FairPlayFailed}})
	if m.Status().Capabilities.CBCS {
		t.Fatal("failed FairPlay retains playback capabilities")
	}
}

type challengeBackend struct {
	DRMBackend
	source  AuthSource
	events  chan DRMEvent
	mu      sync.Mutex
	running bool
	starts  int
	entered chan struct{}
}

func (b *challengeBackend) SetAuthSource(src AuthSource) { b.source = src }
func (b *challengeBackend) Events() <-chan DRMEvent      { return b.events }
func (b *challengeBackend) Running() bool                { b.mu.Lock(); defer b.mu.Unlock(); return b.running }
func (b *challengeBackend) Stop() error                  { b.mu.Lock(); b.running = false; b.mu.Unlock(); return nil }
func (b *challengeBackend) Start(ctx context.Context, _ BackendConfig) error {
	b.mu.Lock()
	b.starts++
	b.mu.Unlock()
	if b.entered != nil {
		close(b.entered)
	}
	_, err := b.source.Challenge(ctx, AuthChallenge{Type: ChallengeTwoFactor, Title: "Code"})
	if err == nil {
		b.mu.Lock()
		b.running = true
		b.mu.Unlock()
	}
	return err
}

func TestManagerLogoutCancelsPendingTwoFactorLogin(t *testing.T) {
	prompted := make(chan struct{}, 1)
	b := &challengeBackend{events: make(chan DRMEvent)}
	m := NewDRMManager(b, NewSessionManager(t.TempDir()), func(s DRMSnapshot) {
		if s.Challenge != nil {
			select {
			case prompted <- struct{}{}:
			default:
			}
		}
	}, BackendConfig{}, DefaultRestartPolicy)
	t.Cleanup(m.shutdownStop)
	loginDone := make(chan error, 1)
	go func() {
		loginDone <- m.Authenticate(context.Background(), Credentials{Email: "test@example.com", Password: "password"})
	}()
	select {
	case <-prompted:
	case <-time.After(time.Second):
		t.Fatal("no 2FA prompt")
	}
	logoutDone := make(chan error, 1)
	go func() { logoutDone <- m.Logout(context.Background()) }()
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("logout blocked behind 2FA")
	}
	if err := <-loginDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("login error: %v", err)
	}
	got := m.Status()
	if got.State.Authentication != AuthLoggedOut || got.Challenge != nil {
		t.Fatalf("logout leaves stale login: %+v", got)
	}
	if m.auth.stored != (Credentials{}) {
		t.Fatal("password retained after login")
	}
}

func TestManagerReplyImmediatelyClearsTwoFactorPrompt(t *testing.T) {
	prompted := make(chan struct{}, 1)
	b := &challengeBackend{events: make(chan DRMEvent)}
	m := NewDRMManager(b, NewSessionManager(t.TempDir()), func(s DRMSnapshot) {
		if s.Challenge != nil {
			select {
			case prompted <- struct{}{}:
			default:
			}
		}
	}, BackendConfig{}, DefaultRestartPolicy)
	t.Cleanup(m.shutdownStop)
	loginDone := make(chan error, 1)
	go func() { loginDone <- m.Authenticate(context.Background(), Credentials{}) }()
	select {
	case <-prompted:
	case <-time.After(time.Second):
		t.Fatal("no prompt")
	}
	// LOGIN was queued before the synchronous prompt and arrives late.
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthLoggingIn}})
	if m.Status().Challenge == nil {
		t.Fatal("late LOGIN erased pending prompt")
	}
	if err := m.SubmitChallenge(context.Background(), "123456"); err != nil {
		t.Fatal(err)
	}
	// The state callback's WAITING_2FA can also be delivered after submission.
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthChallenging}})
	if got := m.Status(); got.Challenge != nil || got.State.Authentication == AuthChallenging {
		t.Fatalf("answered prompt remains visible: %+v", got)
	}
	if err := <-loginDone; err != nil {
		t.Fatal(err)
	}
}
