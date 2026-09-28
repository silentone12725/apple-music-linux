package aacstream

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

func TestStableCacheKeyKeepsByteRange(t *testing.T) {
	a := stableCacheKey("https://cdn/v.mp4?accessKey=1#bytes=0-99")
	b := stableCacheKey("https://cdn/v.mp4?accessKey=2#bytes=100-199")
	c := stableCacheKey("https://cdn/v.mp4?accessKey=3#bytes=0-99")
	if a == b {
		t.Fatal("different byte ranges of one file share a cache key")
	}
	if a != c {
		t.Fatal("rotating accessKey changed the cache key")
	}
}

// A CDN that ignores Range returns the whole file with 200; that must not be
// accepted (and cached) as the requested segment.
func TestFetchSegmentRejects200ForRange(t *testing.T) {
	old := segmentCache.maxBytes.Load()
	segmentCache.maxBytes.Store(0) // cache off: exercise the network path only
	defer segmentCache.maxBytes.Store(old)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(strings.Repeat("x", 1000))) // ignores Range → 200
	}))
	defer srv.Close()
	_, err := fetchSegment(context.Background(), srv.URL+"/seg.mp4#bytes=0-99")
	if err == nil || !strings.Contains(err.Error(), "ignored Range") {
		t.Fatalf("err = %v, want range-ignored error", err)
	}
}

func TestNormalizeAudioFragKeepsDecodeTime(t *testing.T) {
	frag := mp4.NewFragment()
	moof := &mp4.MoofBox{}
	traf := &mp4.TrafBox{}
	tfhd := mp4.CreateTfhd(7)
	traf.AddChild(tfhd)
	tfdt := mp4.CreateTfdt(441000)
	traf.AddChild(tfdt)
	moof.AddChild(traf)
	frag.AddChild(moof)

	normalizeAudioFrag(frag)
	if got := frag.Moof.Traf.Tfdt.BaseMediaDecodeTime(); got != 441000 {
		t.Fatalf("tfdt moved to %d; seek streams need absolute decode times", got)
	}
	if frag.Moof.Traf.Tfhd.TrackID != 1 || frag.Moof.Traf.Tfdt.Version != 1 {
		t.Fatalf("TrackID=%d version=%d, want 1/1", frag.Moof.Traf.Tfhd.TrackID, frag.Moof.Traf.Tfdt.Version)
	}
}
