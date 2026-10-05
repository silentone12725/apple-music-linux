package playback

import (
	"context"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu  sync.Mutex
	ids []string
}

func (r *recorder) hook(id string) { r.mu.Lock(); r.ids = append(r.ids, id); r.mu.Unlock() }
func (r *recorder) seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.ids...)
}

// Whoever owns per-session resources (producers, scratch files) must hear about a session
// going away however it goes: explicit release, expiry noticed on lookup, or the reaper.
func TestReleaseHookSeesEveryRemovalPath(t *testing.T) {
	m := newTestManager(&stubProvider{})
	rec := &recorder{}
	m.SetReleaseHook(rec.hook)

	open := func(asset string) string {
		s, err := m.Open(context.Background(), OpenRequest{AssetID: asset})
		if err != nil {
			t.Fatal(err)
		}
		return s.ID
	}
	released, expiredOnLookup, swept := open("a"), open("b"), open("c")

	m.Release(released)

	m.mu.Lock()
	m.contexts[expiredOnLookup].expiry = time.Now().Add(-time.Second)
	m.mu.Unlock()
	if _, ok := m.GetSession(expiredOnLookup); ok {
		t.Fatal("expired session returned")
	}

	m.sweepExpired(time.Now().Add(sessionTTL + time.Minute))

	got := map[string]int{}
	for _, id := range rec.seen() {
		got[id]++
	}
	for name, id := range map[string]string{"release": released, "lookup expiry": expiredOnLookup, "reaper": swept} {
		if got[id] != 1 {
			t.Errorf("%s: hook saw session %s %d times, want once", name, id, got[id])
		}
	}

	// Releasing something that is already gone must not report it again.
	m.Release(released)
	if n := len(rec.seen()); n != 3 {
		t.Errorf("hook calls = %d after a repeat Release, want 3", n)
	}
}

// The hook may call back into the manager: it must not run under the manager's lock.
func TestReleaseHookMayCallBackIntoTheManager(t *testing.T) {
	m := newTestManager(&stubProvider{})
	s, _ := m.Open(context.Background(), OpenRequest{AssetID: "x"})
	done := make(chan struct{})
	m.SetReleaseHook(func(id string) {
		m.GetSession(id) // would deadlock if the lock were still held
		close(done)
	})
	m.Release(s.ID)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("release hook deadlocked against the manager")
	}
}

// A session that is in use must not expire at a fixed deadline in the middle of a listen.
func TestLookupSlidesExpiry(t *testing.T) {
	m := newTestManager(&stubProvider{})
	s, _ := m.Open(context.Background(), OpenRequest{AssetID: "x"})

	m.mu.Lock()
	m.contexts[s.ID].expiry = time.Now().Add(10 * time.Minute) // nearly out of time
	m.mu.Unlock()
	if _, ok := m.GetSession(s.ID); !ok {
		t.Fatal("session lost")
	}
	m.mu.RLock()
	left := time.Until(m.contexts[s.ID].expiry)
	m.mu.RUnlock()
	if left < sessionTTL-time.Minute {
		t.Fatalf("expiry not pushed out by use: %v left, want about %v", left, sessionTTL)
	}

	// Frequent lookups must not take the write lock every time: a fresh session is left alone.
	m.mu.Lock()
	want := time.Now().Add(sessionTTL)
	m.contexts[s.ID].expiry = want
	m.mu.Unlock()
	m.GetSession(s.ID)
	m.mu.RLock()
	got := m.contexts[s.ID].expiry
	m.mu.RUnlock()
	if !got.Equal(want) {
		t.Fatal("a freshly refreshed session was touched again")
	}
}
