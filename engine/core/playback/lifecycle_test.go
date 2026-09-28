package playback

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"engine/core/media"
)

func TestSweepExpired_CleansEveryIndex(t *testing.T) {
	m := newTestManager(&stubProvider{})
	for _, id := range []string{"a", "b", "c"} {
		if _, err := m.Open(context.Background(), OpenRequest{AssetID: id}); err != nil {
			t.Fatal(err)
		}
	}
	m.sweepExpired(time.Now().Add(sessionTTL + time.Minute))
	m.mu.RLock()
	defer m.mu.RUnlock()
	if n := len(m.sessions) + len(m.contexts) + len(m.assetIndex) + len(m.sessionToAsset); n != 0 {
		t.Fatalf("leftover entries after expiry: sessions=%d contexts=%d assetIndex=%d sessionToAsset=%d",
			len(m.sessions), len(m.contexts), len(m.assetIndex), len(m.sessionToAsset))
	}
}

func TestLookupExpiry_CleansIndexes(t *testing.T) {
	m := newTestManager(&stubProvider{})
	s, _ := m.Open(context.Background(), OpenRequest{AssetID: "x"})
	m.mu.Lock()
	m.contexts[s.ID].expiry = time.Now().Add(-time.Second)
	m.mu.Unlock()
	if _, ok := m.GetSession(s.ID); ok {
		t.Fatal("expired session still returned")
	}
	if len(m.sessionToAsset) != 0 || len(m.assetIndex) != 0 {
		t.Fatalf("index leak: assetIndex=%d sessionToAsset=%d", len(m.assetIndex), len(m.sessionToAsset))
	}
}

// ctxProvider blocks until release, honouring its caller's context.
type ctxProvider struct {
	stubProvider
	release chan struct{}
	opens   atomic.Int32
}

func (p *ctxProvider) Open(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	p.opens.Add(1)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.release:
		return p.stubProvider.Open(ctx, req)
	}
}

func TestOpen_WaiterSurvivesCancelledLeader(t *testing.T) {
	p := &ctxProvider{release: make(chan struct{})}
	m := newTestManager(p)
	req := OpenRequest{AssetID: "skip-me"}

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderErr := make(chan error, 1)
	go func() { _, err := m.Open(leaderCtx, req); leaderErr <- err }()
	for p.opens.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	waiter := make(chan error, 1)
	go func() { _, err := m.Open(context.Background(), req); waiter <- err }()
	time.Sleep(20 * time.Millisecond) // waiter joins the leader's flight

	cancelLeader() // e.g. the user skipped: the leader's HTTP request is gone
	if err := <-leaderErr; err != context.Canceled {
		t.Fatalf("leader err = %v", err)
	}
	close(p.release)
	select {
	case err := <-waiter:
		if err != nil {
			t.Fatalf("waiter inherited the leader's cancellation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never completed")
	}
}
