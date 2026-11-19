package drm

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// A wrong password: Apple raises the "Check the account information" dialog, the user answers it,
// the backend reports the failure. No snapshot in that sequence may say "logged in": the account
// sheet closes on it and the user never gets to retry.
func TestWrongPasswordDialogNeverReportsSignedIn(t *testing.T) {
	b := newFake()
	var mu sync.Mutex
	var seen []DRMSnapshot
	sink := func(s DRMSnapshot) {
		mu.Lock()
		seen = append(seen, s)
		mu.Unlock()
	}
	b.startFn = func(ctx context.Context, b *fakeBackend) error {
		// What the wrapper does: state WAITING_DIALOG, ask the user, then fail the attempt.
		b.events <- DRMEvent{Snapshot: DRMSnapshot{State: DRMState{Process: ProcessStarting, Authentication: AuthChallenging}, Message: "state change: WAITING_DIALOG"}}
		reply, err := b.auth.Challenge(ctx, AuthChallenge{Type: ChallengeDialogChoice, Title: "Check the account information you entered and try again.", Metadata: map[string]string{"buttons": "Cancel\nRetry"}})
		if err != nil || reply != "0" {
			t.Errorf("dialog reply = %q, %v", reply, err)
		}
		b.events <- DRMEvent{Snapshot: DRMSnapshot{State: DRMState{Process: ProcessFailed}, Message: "state change: FAILED"}}
		return errors.New("authenticate: Check the account information you entered and try again.")
	}
	m := NewDRMManager(b, NewSessionManager(t.TempDir()), sink, BackendConfig{}, RestartPolicy{StartupTimeout: time.Second, AuthTimeout: 5 * time.Second})
	m.timing = fastTiming

	done := make(chan error, 1)
	go func() { done <- m.Authenticate(context.Background(), Credentials{Email: "a@b.c", Password: "wrong"}) }()
	deadline := time.After(3 * time.Second)
	for !m.auth.Pending() {
		select {
		case <-deadline:
			t.Fatal("the dialog challenge never arrived")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err := m.auth.SubmitReply("0"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("expected the sign-in to fail")
	}
	time.Sleep(100 * time.Millisecond) // let the event loop drain

	mu.Lock()
	defer mu.Unlock()
	for i, s := range seen {
		t.Logf("%d auth=%v process=%v msg=%q challenge=%v", i, s.State.Authentication, s.State.Process, s.Message, s.Challenge != nil)
		if s.State.Authentication == AuthSignedIn {
			t.Errorf("snapshot %d reports signed_in during a failed sign-in (msg %q)", i, s.Message)
		}
	}
}

// The wrapper reports RUNNING when the library initialises, long before any sign-in. Until hybris FairPlay is up it must
// not read as signed in (or FairPlay ready); once it is up it must.
func TestStateStringsOnlyReportSignedInOnceFairPlayIsUp(t *testing.T) {
	for _, state := range []string{"RUNNING", "INITIALIZING_FAIRPLAY"} {
		early := SnapshotForStateString(state, false)
		if early.State.Authentication == AuthSignedIn {
			t.Errorf("%s before hybris is ready reports signed_in", state)
		}
		if early.State.FairPlay == FairPlayReady {
			t.Errorf("%s before hybris is ready reports FairPlay ready", state)
		}
		late := SnapshotForStateString(state, true)
		if late.State.Authentication != AuthSignedIn {
			t.Errorf("%s after hybris is ready does not report signed_in", state)
		}
	}
	// The challenge state belongs to the AuthCoordinator: a wrapper string arriving late must not move it back.
	for _, state := range []string{"WAITING_DIALOG", "WAITING_2FA", "LOGIN"} {
		for _, ready := range []bool{false, true} {
			if got := SnapshotForStateString(state, ready).State.Authentication; got != 0 {
				t.Errorf("%s (hybris ready %v) carries authentication %v, want none", state, ready, got)
			}
		}
	}
	if got := SnapshotForStateString("FAILED", false).State.Process; got != ProcessFailed {
		t.Errorf("FAILED process = %v", got)
	}
}
