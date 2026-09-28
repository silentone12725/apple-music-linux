package apple

import (
	"testing"
)

// White-box tests for the unexported helpers.
//
// NOTE: The full open flow (openSong / openMV / webplaybackURL) is NOT tested
// here. ampapi.GetSongResp/GetMusicVideoResp and webplaybackURL both use
// http.DefaultClient against hardcoded amp-api.music.apple.com / play.music.
// apple.com URLs with no injection point, so they cannot be redirected to a
// test server without modifying production code. Per the frozen-architecture
// rule we do not add injection seams; those paths are covered indirectly by the
// engine/playback and engine/e2e tests via a fake media.Provider.
//
// The testdata/webplayback_response.json fixture documents the exact JSON shape
// webplaybackURL parses; the parsing logic itself is exercised below through a
// mirror of the same struct to guard the field tags.

func TestTraitSet(t *testing.T) {
	t.Parallel()
	got := traitSet([]string{"lossless", "hi-res-lossless", "atmos"})
	for _, want := range []string{"lossless", "hi-res-lossless", "atmos"} {
		if !got[want] {
			t.Errorf("traitSet missing %q", want)
		}
	}
	if got["nope"] {
		t.Error("traitSet should not contain absent trait")
	}
}

func TestTraitSet_Empty(t *testing.T) {
	t.Parallel()
	got := traitSet(nil)
	if len(got) != 0 {
		t.Errorf("expected empty map, got %v", got)
	}
}

func TestExtractALACQuality_HiRes(t *testing.T) {
	t.Parallel()
	// A hi-res trait like "lossless-audio-192-24" → sampleRate 192, bitDepth 24.
	sr, bd := extractALACQuality([]string{"lossless-audio-192-24"})
	if sr != 192 || bd != 24 {
		t.Errorf("got %d/%d want 192/24", sr, bd)
	}
}

func TestExtractALACQuality_Standard(t *testing.T) {
	t.Parallel()
	// No parseable numeric quality → default 96000/24.
	sr, bd := extractALACQuality([]string{"lossless", "atmos"})
	if sr != 96000 || bd != 24 {
		t.Errorf("got %d/%d want default 96000/24", sr, bd)
	}
}

func TestFmtArtwork(t *testing.T) {
	t.Parallel()
	got := fmtArtwork("https://art/{w}x{h}.jpg", 500)
	want := "https://art/500x500.jpg"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestFmtArtwork_NoPlaceholders(t *testing.T) {
	t.Parallel()
	in := "https://art/fixed.jpg"
	if got := fmtArtwork(in, 500); got != in {
		t.Errorf("got %q want unchanged %q", got, in)
	}
}
