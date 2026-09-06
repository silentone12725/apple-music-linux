package aacstream

import "testing"

// TestStableCacheKey verifies the download cache key is stable across Apple's
// rotating CDN query params while preserving the byte-range fragment — the fix
// that makes replays hit the cache instead of re-downloading every session.
func TestStableCacheKey(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", "https://cdn/f.m4a", "https://cdn/f.m4a"},
		{"drops rotating query", "https://cdn/f.m4a?accessKey=NEW123", "https://cdn/f.m4a"},
		{"keeps byte-range fragment", "https://cdn/f.m4a#bytes=0-1000", "https://cdn/f.m4a#bytes=0-1000"},
		{"drops query, keeps range", "https://cdn/f.m4a?accessKey=X#bytes=100-200", "https://cdn/f.m4a#bytes=100-200"},
		{"different range → different key", "https://cdn/f.m4a?k=Y#bytes=200-300", "https://cdn/f.m4a#bytes=200-300"},
		{"no query no range", "https://cdn/g.m4a", "https://cdn/g.m4a"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stableCacheKey(c.in); got != c.want {
				t.Errorf("stableCacheKey(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}

	// Property: the same audio bytes under two different signed URLs must map to
	// the SAME key (the whole point of the fix).
	a := stableCacheKey("https://cdn/track.m4a?accessKey=session1#bytes=0-500")
	b := stableCacheKey("https://cdn/track.m4a?accessKey=session2#bytes=0-500")
	if a != b {
		t.Errorf("rotating access keys produced different cache keys: %q vs %q", a, b)
	}

	// Property: different byte ranges of the same file must map to DIFFERENT keys.
	if stableCacheKey("https://cdn/t.m4a#bytes=0-1") == stableCacheKey("https://cdn/t.m4a#bytes=2-3") {
		t.Error("distinct byte ranges collided to the same cache key")
	}
}
