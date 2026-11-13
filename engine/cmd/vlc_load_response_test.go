package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
)

// touchRecorder notes whether the handler touched the response at all.
type touchRecorder struct {
	*httptest.ResponseRecorder
	touched bool
}

func (t *touchRecorder) WriteHeader(code int) { t.touched = true; t.ResponseRecorder.WriteHeader(code) }
func (t *touchRecorder) Write(b []byte) (int, error) {
	t.touched = true
	return t.ResponseRecorder.Write(b)
}

func TestRespondLoadAbandoned(t *testing.T) {
	t.Run("caller went away: nothing is written", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		w := &touchRecorder{ResponseRecorder: httptest.NewRecorder()}
		respondLoadAbandoned(w, httptest.NewRequest(http.MethodPost, "/vlc/load", nil).WithContext(ctx))
		if w.touched {
			t.Fatalf("wrote a reply to a caller that left: %d %q", w.Code, w.Body.String())
		}
	})
	t.Run("engine shutting down: the caller still connected is told", func(t *testing.T) {
		w := &touchRecorder{ResponseRecorder: httptest.NewRecorder()}
		respondLoadAbandoned(w, httptest.NewRequest(http.MethodPost, "/vlc/load", nil))
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "shutting down") {
			t.Fatalf("reply = %d %q, want 503 shutting down", w.Code, w.Body.String())
		}
	})
}

func TestOpenFailureMessageCarriesNoDetail(t *testing.T) {
	secret := `Get "https://cdn.example/track.m4a?token=SECRETTOKEN": dial tcp: lookup failed`
	path := &os.PathError{Op: "open", Path: "/home/someone/.cache/adam/playback/123-alac.m4a.tmp", Err: syscall.EACCES}
	cases := []struct {
		err  error
		want string
	}{
		{errors.New(secret), "audio source unavailable"},
		{fmt.Errorf("wait for audio cache: %w", errors.New(secret)), "audio source unavailable"},
		{path, "audio cache unavailable"},
		{fmt.Errorf("audio cache: %w", &os.PathError{Op: "write", Path: "/tmp/x", Err: syscall.ENOSPC}), "audio cache unavailable"},
		{errors.Join(errors.New(secret), context.DeadlineExceeded), "audio source unavailable"},
	}
	for _, c := range cases {
		got := openFailureMessage(c.err)
		if got != c.want {
			t.Errorf("openFailureMessage(%v) = %q, want %q", c.err, got, c.want)
		}
		for _, leak := range []string{"SECRETTOKEN", "https://", "/home/", "/tmp/"} {
			if strings.Contains(got, leak) {
				t.Errorf("message %q leaks %q", got, leak)
			}
		}
	}
}
