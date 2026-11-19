package drm

import "testing"

// The account is "signed in"; a service is "ready". Mixing the two words made the status read as one
// thing when it is two, so each word belongs to exactly one meaning.
func TestStateVocabulariesDoNotOverlap(t *testing.T) {
	neutral := map[string]bool{"unknown": true, "failed": true, "initializing": true}
	collect := func(n int, name func(i int) string) map[string]bool {
		out := map[string]bool{}
		for i := 0; i < n; i++ {
			out[name(i)] = true
		}
		return out
	}
	auth := collect(len([]AuthState{AuthUnknown, AuthSignedOut, AuthSigningIn, AuthChallenging, AuthSignedIn, AuthFailed}),
		func(i int) string { return AuthState(i).String() })
	fp := collect(4, func(i int) string { return FairPlayState(i).String() })
	mgr := collect(len(managerStateNames), func(i int) string { return ManagerState(i).String() })

	for w := range auth {
		if !neutral[w] && (fp[w] || mgr[w]) {
			t.Errorf("%q names the account and a service", w)
		}
	}
	if !auth["signed_in"] || fp["signed_in"] || mgr["signed_in"] {
		t.Error(`"signed_in" must be the account's word only`)
	}
	if auth["ready"] || !fp["ready"] || !mgr["ready"] {
		t.Error(`"ready" must be a service's word only`)
	}
	if AuthSignedIn.String() != "signed_in" || FairPlayReady.String() != "ready" {
		t.Error("the wire values changed")
	}
}
