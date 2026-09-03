package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"engine/internal/ring"
)

// ── MaxBytesReader enforcement ────────────────────────────────────────────────
// We test a minimal handler that mirrors the pattern used in handleCreatePlayback
// and friends, without needing a full APIServer.

func limitedBodyHandler(limit int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		buf := make([]byte, limit+1)
		_, err := r.Body.Read(buf)
		if err != nil && strings.Contains(err.Error(), "too large") {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}
}

func TestMaxBytesReader_OversizedBodyRejects(t *testing.T) {
	const limit = 10
	body := bytes.Repeat([]byte("X"), limit+1)
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	limitedBodyHandler(limit).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized body, got %d", rr.Code)
	}
}

func TestMaxBytesReader_ExactSizeBodyAccepted(t *testing.T) {
	const limit = 10
	body := bytes.Repeat([]byte("X"), limit)
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	limitedBodyHandler(limit).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for exact-size body, got %d", rr.Code)
	}
}

func TestMaxBytesReader_SmallBodyAccepted(t *testing.T) {
	const limit = 64 << 10 // 64 KB — same as handleCreatePlayback
	body := []byte(`{"assetId":"123"}`)
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	limitedBodyHandler(limit).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for small body, got %d", rr.Code)
	}
}

// ── Artwork size clamp ────────────────────────────────────────────────────────

func TestFmtArtworkURL_SubstitutesSize(t *testing.T) {
	template := "https://cdn.example.com/{w}x{h}bb.jpg"
	got := fmtArtworkURL(template, 300)
	want := "https://cdn.example.com/300x300bb.jpg"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFmtArtworkURL_ZeroWidth(t *testing.T) {
	template := "{w}/{h}/img.jpg"
	got := fmtArtworkURL(template, 0)
	if !strings.Contains(got, "0") {
		t.Fatalf("expected 0 substituted, got %q", got)
	}
}

// artworkSizeClamp verifies the same clamp logic used in handleArtwork.
func artworkSizeClamp(size int) int {
	if size < 50 {
		return 50
	} else if size > 3000 {
		return 3000
	}
	return size
}

func TestArtworkSizeClamp_BelowMin(t *testing.T) {
	if got := artworkSizeClamp(0); got != 50 {
		t.Fatalf("expected 50 for size=0, got %d", got)
	}
	if got := artworkSizeClamp(-100); got != 50 {
		t.Fatalf("expected 50 for size=-100, got %d", got)
	}
	if got := artworkSizeClamp(49); got != 50 {
		t.Fatalf("expected 50 for size=49, got %d", got)
	}
}

func TestArtworkSizeClamp_AboveMax(t *testing.T) {
	if got := artworkSizeClamp(3001); got != 3000 {
		t.Fatalf("expected 3000 for size=3001, got %d", got)
	}
	if got := artworkSizeClamp(99999); got != 3000 {
		t.Fatalf("expected 3000 for size=99999, got %d", got)
	}
}

func TestArtworkSizeClamp_InRange(t *testing.T) {
	for _, s := range []int{50, 500, 1000, 3000} {
		if got := artworkSizeClamp(s); got != s {
			t.Fatalf("expected %d unchanged, got %d", s, got)
		}
	}
}

// ── streamsFromTraits ─────────────────────────────────────────────────────────

func TestStreamsFromTraits_AAConlyBaseline(t *testing.T) {
	streams := streamsFromTraits(nil)
	if len(streams) != 1 {
		t.Fatalf("expected 1 stream (AAC) for empty traits, got %d", len(streams))
	}
	if streams[0].Codec != "AAC" {
		t.Fatalf("expected AAC baseline codec, got %q", streams[0].Codec)
	}
}

func TestStreamsFromTraits_Lossless(t *testing.T) {
	streams := streamsFromTraits([]string{"lossless"})
	codecs := make(map[string]bool)
	for _, s := range streams {
		codecs[s.Codec] = true
	}
	if !codecs["ALAC"] {
		t.Fatal("expected ALAC in streams for lossless trait")
	}
	if !codecs["AAC"] {
		t.Fatal("expected AAC fallback alongside ALAC")
	}
}

func TestStreamsFromTraits_Atmos(t *testing.T) {
	streams := streamsFromTraits([]string{"atmos"})
	codecs := make(map[string]bool)
	for _, s := range streams {
		codecs[s.Codec] = true
	}
	if !codecs["E-AC-3"] {
		t.Fatal("expected E-AC-3 for atmos trait")
	}
}

func TestStreamsFromTraits_HiRes(t *testing.T) {
	streams := streamsFromTraits([]string{"hi-res-lossless"})
	for _, s := range streams {
		if s.Codec == "ALAC" {
			if s.SampleRate == 0 {
				t.Fatal("hi-res ALAC must have non-zero SampleRate")
			}
			if s.BitDepth == 0 {
				t.Fatal("hi-res ALAC must have non-zero BitDepth")
			}
			return
		}
	}
	t.Fatal("expected ALAC in streams for hi-res-lossless trait")
}

// ── Metrics response shape ─────────────────────────────────────────────────────

func TestHandleMetrics_ResponseShape(t *testing.T) {
	// Build the minimal APIServer fields needed by handleMetrics.
	em := newEpochManager()
	s := &APIServer{
		openLatency: ring.New(100),
		openCB:      newCircuitBreaker(5, 30*time.Second),
		epoch:       em,
	}
	// Record a few fake open latencies.
	s.openLatency.Record(10)
	s.openLatency.Record(20)
	s.openLatency.Record(30)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	rr := httptest.NewRecorder()
	s.handleMetrics(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	for _, key := range []string{"sessionOpen", "avgMs", "p95Ms", "circuitBreaker", "state"} {
		if !strings.Contains(body, key) {
			t.Errorf("metrics response missing key %q; body: %s", key, body)
		}
	}
}

// Ensure time import is used.
var _ = time.Second
