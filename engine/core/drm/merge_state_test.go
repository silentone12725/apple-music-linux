package drm

import "testing"

func newMergeManager(t *testing.T) *DRMManager {
	t.Helper()
	stub := &crashStub{events: make(chan DRMEvent)}
	return NewDRMManager(stub, NewSessionManager(t.TempDir()), nil, BackendConfig{}, DefaultRestartPolicy)
}

// An update that carries no authentication state must not erase a challenge the user is still
// being asked to answer.
func TestMergeKeepsPendingChallengeAcrossUnrelatedUpdates(t *testing.T) {
	m := newMergeManager(t)
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthChallenging}, Challenge: &AuthChallenge{Type: ChallengeTwoFactor}})
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Process: ProcessRunning}})
	if got := m.Status(); got.Challenge == nil || got.State.Authentication != AuthChallenging {
		t.Fatalf("challenge lost after unrelated update: %+v", got)
	}
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Authentication: AuthSignedIn}})
	if m.Status().Challenge != nil {
		t.Fatal("challenge should clear once authentication moves on")
	}
}

// A FairPlay session that is no longer signed in must stop advertising playback capabilities.
func TestMergeClearsCapabilitiesWhenFairPlayFails(t *testing.T) {
	m := newMergeManager(t)
	m.mergeAndEmit(DRMSnapshot{State: DRMState{FairPlay: FairPlaySignedIn}})
	if !m.Status().Capabilities.CBCS {
		t.Fatal("a signed-in FairPlay should enable CBCS")
	}
	m.mergeAndEmit(DRMSnapshot{State: DRMState{FairPlay: FairPlayFailed}})
	if got := m.Status().Capabilities; got.CBCS || got.ALAC {
		t.Fatalf("capabilities retained after FairPlay failure: %+v", got)
	}
}
