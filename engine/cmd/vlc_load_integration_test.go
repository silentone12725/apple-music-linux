//go:build cgo && integration

package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"engine/core/playback"
	"engine/core/vlc"
)

// Deadline is called by source opening's bounded cache wait, after foreground
// selection. Pause there deterministically while a newer real handler runs.
type sourceOpenBarrier struct {
	context.Context
	entered chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (c *sourceOpenBarrier) Deadline() (time.Time, bool) {
	c.once.Do(func() { close(c.entered); <-c.resume })
	return c.Context.Deadline()
}

func TestLoadOrderingRejectsLateSource(t *testing.T) {
	for _, mode := range []string{"timeout", "discard", "cancel", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			s, a, shutdown := playback02Server(t, playback02Source(func(ctx context.Context, dst io.Writer) error {
				if _, err := dst.Write(sharedGateWAV()); err != nil {
					return err
				}
				<-ctx.Done()
				return ctx.Err()
			}), true)
			b, err := s.pm.Open(t.Context(), playback.OpenRequest{AssetID: "newer-track", Lossless: true})
			if err != nil {
				t.Fatal(err)
			}
			defer s.pm.Release(b.ID)
			pw, err := s.diskCache.BeginPut(b.AssetID, b.Codec)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pw.Write(sharedGateWAV()); err != nil {
				t.Fatal(err)
			}
			if err := pw.Commit(); err != nil {
				t.Fatal(err)
			}
			held, err := s.diskCache.BeginPut(a.AssetID, a.Codec)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Discard()
			p, err := vlc.New()
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			p.SetVolume(0)
			s.vlcPlayer = p
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			barrier := &sourceOpenBarrier{Context: ctx, entered: make(chan struct{}), resume: make(chan struct{})}
			oldResult := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				defer close(done)
				s.handleVLCLoad(oldResult, httptest.NewRequest(http.MethodPost, "/vlc/load", bytes.NewBufferString(fmt.Sprintf(`{"sessionId":%q,"startMs":60000}`, a.ID))).WithContext(barrier))
			}()
			<-barrier.entered
			newer := httptest.NewRecorder()
			s.handleVLCLoad(newer, httptest.NewRequest(http.MethodPost, "/vlc/load", bytes.NewBufferString(fmt.Sprintf(`{"sessionId":%q}`, b.ID))))
			if newer.Code != http.StatusOK {
				t.Fatalf("new load=%d %s", newer.Code, newer.Body.String())
			}
			s.alac.mu.Lock()
			generation := s.alac.gen
			s.alac.mu.Unlock()
			switch mode {
			case "discard":
				held.Discard()
			case "cancel":
				cancel()
			case "shutdown":
				shutdown()
			}
			close(barrier.resume)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("old request did not complete")
			}
			if oldResult.Code != http.StatusConflict {
				t.Fatalf("old load=%d %s", oldResult.Code, oldResult.Body.String())
			}
			if !s.vlcGate.owns(b.ID) || s.vlcGate.owns(a.ID) {
				t.Fatal("old request overwrote the newer session gate")
			}
			s.alac.mu.Lock()
			got := s.alac.gen
			s.alac.mu.Unlock()
			if got != generation {
				t.Fatalf("old request created new foreground: %d -> %d", generation, got)
			}
		})
	}
}
