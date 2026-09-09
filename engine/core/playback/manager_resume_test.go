package playback

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"engine/core/media"
	"engine/core/pipeline"
)

// ── stub provider ───────────────────────────────────────────────────────────

type stubProvider struct {
	mu    sync.Mutex
	calls int
	resp  *media.Session
	err   error
}

func (p *stubProvider) open() { p.mu.Lock(); p.calls++; p.mu.Unlock() }

func (p *stubProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	p.open()
	if p.err != nil {
		return nil, p.err
	}
	if p.resp != nil {
		return p.resp, nil
	}
	return &media.Session{
		Kind:     "song",
		Metadata: media.Metadata{Title: req.AssetID},
		Tracks: []media.Track{
			{
				Kind:  pipeline.KindAudio,
				Codec: pipeline.CodecAAC,
				Open: func(_ context.Context) (*pipeline.Stream, error) {
					return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
				},
			},
		},
	}, nil
}

func newTestManager(p media.Provider) *Manager {
	m := &Manager{
		provider:   p,
		sessions:   make(map[string]*Session),
		contexts:   make(map[string]*playContext),
		assetIndex: make(map[string]string),
		inflight:   make(map[string]*openFlight),
	}
	return m // no reaper goroutine in tests
}

// ── tests ───────────────────────────────────────────────────────────────────

func TestOpen_ReusesExistingSession(t *testing.T) {
	p := &stubProvider{}
	m := newTestManager(p)

	req := OpenRequest{AssetID: "track-1", Storefront: "us"}

	s1, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if p.calls != 1 {
		t.Fatalf("expected 1 provider call, got %d", p.calls)
	}

	s2, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	// Provider must NOT have been called a second time.
	if p.calls != 1 {
		t.Fatalf("expected 1 provider call total (reuse), got %d", p.calls)
	}
	if s1.ID != s2.ID {
		t.Fatalf("expected same session ID, got %q vs %q", s1.ID, s2.ID)
	}
}

func TestOpen_RespectsExpiry(t *testing.T) {
	p := &stubProvider{}
	m := newTestManager(p)

	req := OpenRequest{AssetID: "track-exp", Storefront: "us"}

	s1, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}

	// Manually expire the context.
	m.mu.Lock()
	m.contexts[s1.ID].expiry = time.Now().Add(-time.Second)
	m.mu.Unlock()

	s2, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	// Provider must have been called again for the expired session.
	if p.calls != 2 {
		t.Fatalf("expected 2 provider calls (expired reopen), got %d", p.calls)
	}
	if s1.ID == s2.ID {
		t.Fatal("expected different session ID after expiry")
	}
}

func TestRelease_ClearsAssetIndex(t *testing.T) {
	p := &stubProvider{}
	m := newTestManager(p)

	req := OpenRequest{AssetID: "track-rel", Storefront: "us"}
	s, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	m.Release(s.ID)

	// After release, Open should call the provider again.
	_, err = m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("re-Open after Release: %v", err)
	}
	if p.calls != 2 {
		t.Fatalf("expected 2 provider calls after Release, got %d", p.calls)
	}
}

func TestOpen_DifferentCapabilitiesProduceSeparateSessions(t *testing.T) {
	p := &stubProvider{}
	m := newTestManager(p)

	reqAAC := OpenRequest{AssetID: "track-caps", Storefront: "us", Lossless: false}
	reqALAC := OpenRequest{AssetID: "track-caps", Storefront: "us", Lossless: true}

	s1, err := m.Open(context.Background(), reqAAC)
	if err != nil {
		t.Fatalf("Open AAC: %v", err)
	}
	s2, err := m.Open(context.Background(), reqALAC)
	if err != nil {
		t.Fatalf("Open ALAC: %v", err)
	}
	if s1.ID == s2.ID {
		t.Fatal("different capability flags must produce separate sessions")
	}
	if p.calls != 2 {
		t.Fatalf("expected 2 provider calls, got %d", p.calls)
	}
}

func TestOpen_ConcurrentDeduplication(t *testing.T) {
	var callCount atomic.Int32
	slow := &slowProvider{delay: 30 * time.Millisecond, counter: &callCount}
	m := newTestManager(slow)

	req := OpenRequest{AssetID: "track-dup", Storefront: "us"}
	const N = 10
	var wg sync.WaitGroup
	ids := make([]string, N)
	errs := make([]error, N)

	for i := 0; i < N; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := m.Open(context.Background(), req)
			errs[i] = err
			if s != nil {
				ids[i] = s.ID
			}
		}()
	}
	wg.Wait()

	for i, e := range errs {
		if !errors.Is(e, nil) {
			t.Errorf("goroutine %d got error: %v", i, e)
		}
	}
	// All goroutines should have received the same session ID.
	first := ids[0]
	for i, id := range ids {
		if id != first {
			t.Errorf("goroutine %d got different ID %q (expected %q)", i, id, first)
		}
	}
	// Provider called at most twice: once for the first goroutine, once more if
	// reuse kicks in after the first Open resolves (edge case). Must NOT be called N times.
	if callCount.Load() > 2 {
		t.Fatalf("concurrent deduplication failed: provider called %d times (expected ≤2)", callCount.Load())
	}
}

// slowProvider simulates a provider that takes some time to respond.
type slowProvider struct {
	delay   time.Duration
	counter *atomic.Int32
}

func (p *slowProvider) Open(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	p.counter.Add(1)
	select {
	case <-time.After(p.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return &media.Session{
		Kind:     "song",
		Metadata: media.Metadata{Title: req.AssetID},
		Tracks: []media.Track{
			{
				Kind:  pipeline.KindAudio,
				Codec: pipeline.CodecAAC,
				Open: func(_ context.Context) (*pipeline.Stream, error) {
					return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
				},
			},
		},
	}, nil
}
