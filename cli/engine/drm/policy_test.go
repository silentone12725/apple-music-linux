package drm

import "testing"

func TestResolveBackendPolicy(t *testing.T) {
	cases := []struct {
		name           string
		hasWrapper     bool
		preferred      string
		fallback       string
		legacyEmbedded bool
		wantPreferred  string
		wantFallback   string
	}{
		{
			name:          "no wrapper forces process regardless of policy",
			hasWrapper:    false,
			preferred:     "embedded",
			wantPreferred: "process",
			wantFallback:  "",
		},
		{
			name:          "unset policy, legacy false/absent -> new auto default",
			hasWrapper:    true,
			wantPreferred: "embedded",
			wantFallback:  "process",
		},
		{
			name:           "unset policy, legacy true -> embedded only, no fallback (exact pre-fallback behavior)",
			hasWrapper:     true,
			legacyEmbedded: true,
			wantPreferred:  "embedded",
			wantFallback:   "",
		},
		{
			name:          "explicit auto expands to embedded+process",
			hasWrapper:    true,
			preferred:     "auto",
			wantPreferred: "embedded",
			wantFallback:  "process",
		},
		{
			name:          "explicit process, no fallback specified -> pure process",
			hasWrapper:    true,
			preferred:     "process",
			wantPreferred: "process",
			wantFallback:  "",
		},
		{
			name:          "explicit process with explicit embedded fallback",
			hasWrapper:    true,
			preferred:     "process",
			fallback:      "embedded",
			wantPreferred: "process",
			wantFallback:  "embedded",
		},
		{
			name:           "explicit preferred overrides legacy bool entirely",
			hasWrapper:     true,
			preferred:      "process",
			legacyEmbedded: true,
			wantPreferred:  "process",
			wantFallback:   "",
		},
		{
			name:          "case-insensitive and whitespace-tolerant",
			hasWrapper:    true,
			preferred:     "  EMBEDDED ",
			fallback:      " Process",
			wantPreferred: "embedded",
			wantFallback:  "process",
		},
		{
			name:          "unrecognized preferred value falls through to auto",
			hasWrapper:    true,
			preferred:     "bogus",
			wantPreferred: "embedded",
			wantFallback:  "process",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotPreferred, gotFallback := ResolveBackendPolicy(tc.hasWrapper, tc.preferred, tc.fallback, tc.legacyEmbedded)
			if gotPreferred != tc.wantPreferred || gotFallback != tc.wantFallback {
				t.Errorf("ResolveBackendPolicy(%v, %q, %q, %v) = (%q, %q), want (%q, %q)",
					tc.hasWrapper, tc.preferred, tc.fallback, tc.legacyEmbedded,
					gotPreferred, gotFallback, tc.wantPreferred, tc.wantFallback)
			}
		})
	}
}
