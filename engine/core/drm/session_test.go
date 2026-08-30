package drm

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeStorefrontID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		// Wrapper-written format: numeric ID + platform code + content class
		{name: "standard wrapper format", input: "143467-2,31", want: "143467"},
		{name: "different platform code", input: "143441-28,29", want: "143441"},
		{name: "us storefront wrapper format", input: "143441-2,29", want: "143441"},

		// Already-normalized values must pass through unchanged
		{name: "bare numeric ID", input: "143467", want: "143467"},
		{name: "iso code us", input: "us", want: "us"},
		{name: "iso code in", input: "in", want: "in"},
		{name: "iso code gb", input: "gb", want: "gb"},

		// Edge cases
		{name: "empty string", input: "", want: ""},
		{name: "only dash", input: "-", want: ""},
		{name: "leading dash", input: "-2,31", want: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeStorefrontID(tc.input)
			if got != tc.want {
				t.Errorf("NormalizeStorefrontID(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestReadMusicToken_NoCache guards against "optimizing" ReadMusicToken into a
// cached accessor. The mediaUserToken() pattern relies on the session file being
// read on every call so that wrapper token rotations are picked up automatically.
func TestReadMusicToken_NoCache(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MUSIC_TOKEN")
	sm := NewSessionManager(dir)

	// Initial value.
	if err := os.WriteFile(path, []byte("token-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := sm.ReadMusicToken(); got != "token-v1" {
		t.Fatalf("first read: got %q, want %q", got, "token-v1")
	}

	// Simulate wrapper rotating the token in-place.
	if err := os.WriteFile(path, []byte("token-v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := sm.ReadMusicToken(); got != "token-v2" {
		t.Fatalf("after rotation: got %q, want %q (cached old value?)", got, "token-v2")
	}
}
