//go:build cgo && integration

package vlc

import (
	"bytes"
	"errors"
	"io"
	"runtime/cgo"
	"sync/atomic"
	"testing"
	"time"
)

type observedSource struct {
	*bytes.Reader
	fail       bool
	reads      atomic.Int32
	seeks      atomic.Int32
	closes     atomic.Int32
	aborts     atomic.Int32
	readClosed atomic.Bool
}

func (s *observedSource) Read(p []byte) (int, error) {
	s.reads.Add(1)
	if s.closes.Load() != 0 {
		s.readClosed.Store(true)
	}
	if s.fail {
		return 0, errors.New("offline source failure")
	}
	return s.Reader.Read(p)
}
func (s *observedSource) Seek(off int64, whence int) (int64, error) {
	s.seeks.Add(1)
	return s.Reader.Seek(off, whence)
}
func (s *observedSource) Size() int64 { return s.Reader.Size() }
func (s *observedSource) Abort()      { s.aborts.Add(1) }
func (s *observedSource) Close()      { s.closes.Add(1) }

func nativePlayer(t *testing.T) *Player {
	t.Helper()
	p, err := New()
	if err != nil {
		t.Fatal(err) // An explicitly requested integration run must not silently skip.
	}
	t.Cleanup(p.Close)
	p.SetVolume(0)
	return p
}

func waitNative(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for native callback playback")
}

func assertHandleReleased(t *testing.T, handle cgo.Handle) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("callback handle still registered after media release")
		}
	}()
	_ = handle.Value()
}

func TestNativeCallbackEndSemantics(t *testing.T) {
	for _, tc := range []struct {
		name string
		fail bool
	}{{"clean_eof", false}, {"read_error", true}} {
		t.Run(tc.name, func(t *testing.T) {
			p := nativePlayer(t)
			src := &observedSource{Reader: bytes.NewReader(silentWAV(1)), fail: tc.fail}
			if err := p.LoadSource(src); err != nil {
				t.Fatal(err)
			}
			waitNative(t, func() bool {
				_, _, state := p.Time()
				return state == "ended" || state == "error"
			})
			if _, _, state := p.Time(); !tc.fail && state != "ended" {
				t.Fatalf("clean source ended in state %q", state)
			}
			if p.SourceFailed() != tc.fail || p.SourceEnded() == tc.fail {
				t.Fatalf("eof=%v failed=%v, want eof=%v failed=%v", p.SourceEnded(), p.SourceFailed(), !tc.fail, tc.fail)
			}
			if src.reads.Load() == 0 || src.seeks.Load() == 0 || src.closes.Load() != 0 {
				t.Fatalf("reads=%d seeks=%d closes=%d", src.reads.Load(), src.seeks.Load(), src.closes.Load())
			}
			p.mu.Lock()
			handle := p.cur.handle
			p.mu.Unlock()
			p.Stop()
			assertHandleReleased(t, handle)
			if src.closes.Load() != 1 || src.aborts.Load() != 1 || src.readClosed.Load() {
				t.Fatal("Stop failed source ownership checks")
			}
		})
	}
}

func TestNativeRepeatedSourceRelease(t *testing.T) {
	p := nativePlayer(t)
	var previous *observedSource
	var previousHandle cgo.Handle
	for i := 0; i < 3; i++ {
		src := &observedSource{Reader: bytes.NewReader(silentWAV(3))}
		if err := p.LoadSource(src); err != nil {
			t.Fatal(err)
		}
		if previous != nil {
			assertHandleReleased(t, previousHandle)
			if previous.closes.Load() != 1 || previous.aborts.Load() != 1 || previous.readClosed.Load() {
				t.Fatal("replacement failed source ownership checks")
			}
		}
		waitNative(t, func() bool { _, _, state := p.Time(); return state == "playing" })
		if src.closes.Load() != 0 || src.reads.Load() == 0 {
			t.Fatal("source closed early or callbacks never read")
		}
		p.mu.Lock()
		previousHandle = p.cur.handle
		if p.lastURL != "" {
			t.Error("callback playback unexpectedly uses a URL")
		}
		p.mu.Unlock()
		previous = src
	}
	p.Close()
	p.Close()
	assertHandleReleased(t, previousHandle)
	if previous.closes.Load() != 1 || previous.aborts.Load() != 1 || previous.readClosed.Load() {
		t.Fatal("Close failed source ownership checks")
	}
}

var _ io.ReadSeeker = (*observedSource)(nil)

func TestNativeRejectedSourceOwnership(t *testing.T) {
	p := nativePlayer(t)
	p.Close()
	src := &observedSource{Reader: bytes.NewReader(silentWAV(1))}
	if err := p.LoadSource(src); err == nil {
		t.Fatal("closed player accepted source")
	}
	if src.closes.Load() != 1 || src.aborts.Load() != 1 {
		t.Fatalf("rejected source ownership: closes=%d aborts=%d", src.closes.Load(), src.aborts.Load())
	}
}
