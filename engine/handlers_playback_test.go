package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
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
