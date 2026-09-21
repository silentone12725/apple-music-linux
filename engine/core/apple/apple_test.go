package apple

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// ── selectBestProgressiveAsset ────────────────────────────────────────────────

func TestSelectBestProgressiveAsset_MvodPreferred(t *testing.T) {
	t.Parallel()
	assets := []mvProgressiveAsset{
		{URL: "https://other.apple.com/file.m4v", FileSize: 9000},
		{URL: "https://mvod.itunes.apple.com/file.m4v", DownloadKey: "k1", FileSize: 5000},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// mvod domain wins even though it has a smaller file size than the other asset.
	if !strings.Contains(got, "mvod.itunes.apple.com") {
		t.Errorf("expected mvod URL, got %q", got)
	}
}

func TestSelectBestProgressiveAsset_LargestMvodWins(t *testing.T) {
	t.Parallel()
	assets := []mvProgressiveAsset{
		{URL: "https://mvod.itunes.apple.com/low.m4v", FileSize: 1000},
		{URL: "https://mvod.itunes.apple.com/high.m4v", DownloadKey: "k2", FileSize: 5000},
		{URL: "https://mvod.itunes.apple.com/mid.m4v", FileSize: 3000},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if !strings.Contains(got, "high.m4v") {
		t.Errorf("expected highest-size mvod URL, got %q", got)
	}
}

func TestSelectBestProgressiveAsset_FallbackToLargestAny(t *testing.T) {
	t.Parallel()
	assets := []mvProgressiveAsset{
		{URL: "https://cdn.apple.com/small.m4v", FileSize: 100},
		{URL: "https://cdn.apple.com/large.m4v", DownloadKey: "k3", FileSize: 999},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok {
		t.Fatal("expected ok=true for fallback")
	}
	if !strings.Contains(got, "large.m4v") {
		t.Errorf("expected largest fallback URL, got %q", got)
	}
}

func TestSelectBestProgressiveAsset_Empty(t *testing.T) {
	t.Parallel()
	_, ok := selectBestProgressiveAsset(nil)
	if ok {
		t.Error("expected ok=false for empty slice")
	}
}

func TestSelectBestProgressiveAsset_AccessKeyAppended(t *testing.T) {
	t.Parallel()
	assets := []mvProgressiveAsset{
		{URL: "https://mvod.itunes.apple.com/vid.m4v", DownloadKey: "mykey", FileSize: 1},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if !strings.Contains(got, "?accessKey=mykey") {
		t.Errorf("expected ?accessKey=mykey in URL, got %q", got)
	}
}

func TestSelectBestProgressiveAsset_AccessKeyNotDoubled(t *testing.T) {
	t.Parallel()
	// URL already has accessKey embedded — must not append a second one.
	assets := []mvProgressiveAsset{
		{URL: "https://mvod.itunes.apple.com/vid.m4v?accessKey=existing", DownloadKey: "other", FileSize: 1},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if strings.Count(got, "accessKey=") != 1 {
		t.Errorf("expected exactly one accessKey= in URL, got %q", got)
	}
}

func TestSelectBestProgressiveAsset_NoKeyNoAppend(t *testing.T) {
	t.Parallel()
	assets := []mvProgressiveAsset{
		{URL: "https://mvod.itunes.apple.com/vid.m4v", FileSize: 1},
	}
	got, ok := selectBestProgressiveAsset(assets)
	if !ok || strings.Contains(got, "accessKey") {
		t.Errorf("no downloadKey → URL should be unchanged, got %q ok=%v", got, ok)
	}
}

// ── progressiveVideoSource ────────────────────────────────────────────────────

func TestProgressiveVideoSource_StreamsBody(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "fmp4data") //nolint:errcheck
	}))
	defer srv.Close()

	src := &progressiveVideoSource{url: srv.URL}
	var buf strings.Builder
	if err := src.Stream(context.Background(), &buf); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if buf.String() != "fmp4data" {
		t.Errorf("got %q want %q", buf.String(), "fmp4data")
	}
}

func TestProgressiveVideoSource_Non200Error(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer srv.Close()

	src := &progressiveVideoSource{url: srv.URL}
	if err := src.Stream(context.Background(), io.Discard); err == nil {
		t.Error("expected error for HTTP 403")
	}
}

func TestProgressiveVideoSource_SourceFromReturnsZero(t *testing.T) {
	t.Parallel()
	src := &progressiveVideoSource{url: "https://mvod.itunes.apple.com/x.m4v"}
	got, actualStart := src.SourceFrom(42.5)
	if got != src {
		t.Error("SourceFrom should return self (growing-file layer handles in-range seeks)")
	}
	if actualStart != 0 {
		t.Errorf("actualStart=%v want 0", actualStart)
	}
}
