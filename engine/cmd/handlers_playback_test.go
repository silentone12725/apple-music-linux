package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
)

// The session-open circuit breaker fails EVERY subsequent open (songs included)
// with "Apple servers appear unreachable" once it trips. Misclassifying a
// per-track content failure as a transport failure therefore locks the whole app
// out after three bad tracks, which is exactly the bug this classifier fixes.
// Guard both directions.
func TestOpenFailureClassification(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		wantNotFnd  bool
		wantTranspt bool
	}{
		// ── Per-track content failures: must NOT trip the breaker ───────────────
		{
			// Catalog IDs contain status-code digits; they must not classify.
			name:       "id containing 502 with an unrelated content error",
			err:        errors.New("open 1502443: no playable asset"),
			wantNotFnd: true,
		},
		{
			name:        "id containing 404 with a server error",
			err:         errors.New("webplayback 1404221: HTTP 503"),
			wantTranspt: true,
		},
		{
			name:       "mv catalog 404",
			err:        errors.New("MV catalog lookup us/1440818980: 404 Not Found"),
			wantNotFnd: true,
		},
		{
			name:       "song not found",
			err:        errors.New("catalog: song 123 not found"),
			wantNotFnd: true,
		},
		{
			name:       "no h264 variant at requested height",
			err:        errors.New("no video variant at or below 1080p"),
			wantNotFnd: true,
		},
		{
			name:       "no audio rendition",
			err:        errors.New("no audio alternative matching priorities [x]"),
			wantNotFnd: true,
		},

		// ── Transport failures: these SHOULD trip the breaker ───────────────────
		{
			name:        "connection refused",
			err:         errors.New("dial tcp 17.0.0.1:443: connect: connection refused"),
			wantTranspt: true,
		},
		{
			name:        "dns failure is transport, not a missing track",
			err:         errors.New(`Get "https://amp-api.music.apple.com": dial tcp: lookup amp-api.music.apple.com: no such host`),
			wantTranspt: true,
		},
		{
			name:        "deadline exceeded",
			err:         fmt.Errorf("open: %w", context.DeadlineExceeded),
			wantTranspt: true,
		},
		{
			name:        "net.Error implementer",
			err:         fmt.Errorf("fetch: %w", &net.OpError{Op: "read", Err: errors.New("i/o timeout")}),
			wantTranspt: true,
		},
		{
			name:        "apple 503 outage must not be read as a missing track",
			err:         errors.New("HTTP 503 Service Unavailable from https://amp-api.music.apple.com"),
			wantTranspt: true,
		},
		{
			name:        "apple 500",
			err:         errors.New("HTTP 500 Internal Server Error"),
			wantTranspt: true,
		},

		// ── Neither: client went away, or unclassified ──────────────────────────
		{
			// The user skipped the track. Not an outage.
			name: "context canceled",
			err:  fmt.Errorf("stream: %w", context.Canceled),
		},
		{
			// Unknown errors default to content-level so a novel per-track error can
			// never lock out the whole app.
			name: "unclassified defaults to non-transport",
			err:  errors.New("something entirely unexpected happened"),
		},
		{
			name: "nil error",
			err:  nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isNotFoundFailure(tc.err); got != tc.wantNotFnd {
				t.Errorf("isNotFoundFailure(%v) = %v, want %v", tc.err, got, tc.wantNotFnd)
			}
			if got := isTransportFailure(tc.err); got != tc.wantTranspt {
				t.Errorf("isTransportFailure(%v) = %v, want %v", tc.err, got, tc.wantTranspt)
			}
			// The two categories are mutually exclusive: a failure is either about
			// one track or about reaching Apple, never both.
			if tc.wantNotFnd && tc.wantTranspt {
				t.Fatal("test case is self-contradictory")
			}
		})
	}
}

// A content failure must actively RESET the breaker, since it proves the
// round-trip to Apple succeeded. Three 404s in a row previously opened it.
func TestContentFailuresDoNotAccumulate(t *testing.T) {
	cb := newCircuitBreaker(3, 60_000_000_000) // threshold 3, 60s
	notFound := errors.New("MV catalog lookup us/999: 404 Not Found")

	for i := 0; i < 10; i++ {
		if isTransportFailure(notFound) {
			cb.RecordFailure()
		} else {
			cb.RecordSuccess()
		}
	}
	if !cb.Allow() {
		t.Fatal("breaker opened on repeated content failures; a run of unavailable tracks must not fail every later open")
	}

	refused := errors.New("dial tcp 17.0.0.1:443: connect: connection refused")
	for i := 0; i < 3; i++ {
		if isTransportFailure(refused) {
			cb.RecordFailure()
		}
	}
	if cb.Allow() {
		t.Fatal("breaker stayed closed after 3 transport failures; genuine outages must still fast-fail")
	}
}

type mvAudioTestProvider struct {
	stream func(io.Writer) error
}

func (p mvAudioTestProvider) Open(context.Context, media.OpenRequest) (*media.Session, error) {
	return &media.Session{Kind: "mv", Tracks: []media.Track{{
		Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC,
		Open: func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Kind: pipeline.KindAudio, Source: mvAudioTestSource(p.stream)}, nil
		},
	}}}, nil
}

type mvAudioTestSource func(io.Writer) error

func (f mvAudioTestSource) Stream(_ context.Context, w io.Writer) error { return f(w) }

func TestMVAudioStreamDefersHeadersUntilFirstByte(t *testing.T) {
	streamErr := errors.New("upstream failed")
	for _, tc := range []struct {
		name       string
		stream     func(io.Writer) error
		wantStatus int
		wantBody   string
		wantType   string
	}{
		{"failure before bytes", func(io.Writer) error { return streamErr }, http.StatusBadGateway, `"error":"upstream failed"`, "application/json"},
		{"successful stream", func(w io.Writer) error { _, err := io.WriteString(w, "audio"); return err }, http.StatusOK, "audio", "audio/mp4"},
		{"failure after bytes", func(w io.Writer) error { _, _ = io.WriteString(w, "partial"); return streamErr }, http.StatusOK, "partial", "audio/mp4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &APIServer{pm: playback.NewWithProvider(mvAudioTestProvider{stream: tc.stream})}
			sess, err := s.pm.Open(context.Background(), playback.OpenRequest{AssetID: "mv-test", Video: true})
			if err != nil {
				t.Fatal(err)
			}
			defer s.pm.Release(sess.ID)
			r := httptest.NewRequest(http.MethodGet, "/audio", nil)
			r.SetPathValue("id", sess.ID)
			w := httptest.NewRecorder()
			s.handlePlaybackAudio(w, r)
			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body=%q", w.Code, tc.wantStatus, w.Body.String())
			}
			if got := w.Header().Get("Content-Type"); got != tc.wantType {
				t.Errorf("Content-Type = %q, want %q", got, tc.wantType)
			}
			if got := w.Body.String(); tc.wantStatus == http.StatusOK && got != tc.wantBody || tc.wantStatus != http.StatusOK && !strings.Contains(got, tc.wantBody) {
				t.Errorf("body = %q, want %q", got, tc.wantBody)
			}
		})
	}
}

func TestCountingWriterCountsBytesActuallyWritten(t *testing.T) {
	w := &countingWriter{w: &shortWriter{}}
	if n, err := w.Write([]byte("audio")); n != 2 || err != nil {
		t.Fatalf("Write = %d, %v; want 2, nil", n, err)
	}
	if w.n != 2 {
		t.Fatalf("count = %d, want 2", w.n)
	}
}

type shortWriter struct{}

func (*shortWriter) Write([]byte) (int, error) { return 2, nil }

func TestPlaybackTouchKeepsSessionAlive(t *testing.T) {
	s := &APIServer{pm: playback.NewWithProvider(mvAudioTestProvider{stream: func(io.Writer) error { return nil }})}
	sess, err := s.pm.Open(context.Background(), playback.OpenRequest{AssetID: "touch-test"})
	if err != nil {
		t.Fatal(err)
	}
	touch := func(id string) int {
		r := httptest.NewRequest(http.MethodPost, "/touch", nil)
		r.SetPathValue("id", id)
		w := httptest.NewRecorder()
		s.handlePlaybackTouch(w, r)
		return w.Code
	}
	if got := touch(sess.ID); got != http.StatusNoContent {
		t.Fatalf("touch of a live session = %d, want 204", got)
	}
	s.pm.Release(sess.ID)
	if got := touch(sess.ID); got != http.StatusNotFound {
		t.Fatalf("touch of a released session = %d, want 404 so the renderer reopens the track", got)
	}
	if got := touch("no-such-session"); got != http.StatusNotFound {
		t.Fatalf("touch of an unknown session = %d, want 404", got)
	}
}
