package drm

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

// fakeBackend is a minimal DRMBackend for exercising fallbackBackend selection.
type fakeBackend struct {
	name       string
	startErr   error
	started    bool
	stopped    bool
	authSet    bool
	startCount int
	events     chan DRMEvent
}

func newFakeBackend(name string, startErr error) *fakeBackend {
	return &fakeBackend{name: name, startErr: startErr, events: make(chan DRMEvent, 8)}
}

func (f *fakeBackend) Start(context.Context, BackendConfig) error {
	f.startCount++
	if f.startErr != nil {
		return f.startErr
	}
	f.started = true
	return nil
}
func (f *fakeBackend) Authenticate(context.Context) error { return nil }
func (f *fakeBackend) Stop() error                        { f.stopped = true; return nil }
func (f *fakeBackend) Running() bool                      { return f.started && !f.stopped }
func (f *fakeBackend) SetAuthSource(AuthSource)           { f.authSet = true }
func (f *fakeBackend) Decrypt(context.Context, DecryptRequest) (DecryptResponse, error) {
	return DecryptResponse{}, nil
}

// GetM3U8 returns this backend's name so tests can identify the active backend.
func (f *fakeBackend) GetM3U8(context.Context, uint64) (string, error) { return f.name, nil }
func (f *fakeBackend) GetAccount(context.Context) (AccountInfo, error) { return AccountInfo{}, nil }
func (f *fakeBackend) DialCBCS(context.Context) (net.Conn, error)      { return nil, nil }
func (f *fakeBackend) Events() <-chan DRMEvent                         { return f.events }

func activeName(t *testing.T, b DRMBackend) string {
	t.Helper()
	name, _ := b.GetM3U8(context.Background(), 1)
	return name
}

func TestFallbackBackend_PrefersPreferred(t *testing.T) {
	pref := newFakeBackend("pref", nil)
	fb := newFakeBackend("fb", nil)
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	if err := b.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := activeName(t, b); got != "pref" {
		t.Errorf("active = %q, want pref", got)
	}
	if fb.started {
		t.Error("fallback should not have started when preferred succeeds")
	}
}

func TestFallbackBackend_FallsBackOnStartError(t *testing.T) {
	pref := newFakeBackend("pref", errors.New("cannot start here"))
	fb := newFakeBackend("fb", nil)
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	if err := b.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := activeName(t, b); got != "fb" {
		t.Errorf("active = %q, want fb", got)
	}
	if !pref.stopped {
		t.Error("preferred should be stopped after its Start fails")
	}
}

func TestFallbackBackend_BothFail(t *testing.T) {
	pref := newFakeBackend("pref", errors.New("boom1"))
	fb := newFakeBackend("fb", errors.New("boom2"))
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	if err := b.Start(context.Background(), BackendConfig{}); err == nil {
		t.Fatal("expected error when both backends fail to start")
	}
}

// TestFallbackBackend_RestartReusesActive verifies the bounded scope: once a
// backend is selected, a subsequent Start (the crash-restart path driven by
// DRMManager.RestartPolicy) restarts the SAME backend rather than re-running
// selection or switching backends.
func TestFallbackBackend_RestartReusesActive(t *testing.T) {
	pref := newFakeBackend("pref", nil)
	fb := newFakeBackend("fb", nil)
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	if err := b.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatalf("initial Start: %v", err)
	}
	// Simulate a crash-restart: DRMManager calls Start again.
	if err := b.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatalf("restart Start: %v", err)
	}
	if pref.startCount != 2 {
		t.Errorf("preferred startCount = %d, want 2 (restart should reuse active)", pref.startCount)
	}
	if fb.startCount != 0 {
		t.Errorf("fallback must not start on a restart of the active backend (startCount=%d)", fb.startCount)
	}
}

func TestFallbackBackend_SetAuthSourceReachesBoth(t *testing.T) {
	pref := newFakeBackend("pref", nil)
	fb := newFakeBackend("fb", nil)
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	b.SetAuthSource(nil)
	if !pref.authSet || !fb.authSet {
		t.Error("SetAuthSource must reach both preferred and fallback")
	}
}

func TestFallbackBackend_ForwardsActiveEvents(t *testing.T) {
	pref := newFakeBackend("pref", nil)
	fb := newFakeBackend("fb", nil)
	b := NewFallbackBackend(pref, "pref", fb, "fb")

	if err := b.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	pref.events <- DRMEvent{Intentional: true}
	select {
	case <-b.Events():
	case <-time.After(2 * time.Second):
		t.Fatal("event from active backend was not forwarded")
	}
}
