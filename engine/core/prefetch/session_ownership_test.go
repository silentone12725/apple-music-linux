package prefetch

import (
	"context"
	"errors"
	"testing"
	"time"

	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
)

type okProvider struct{}

func (okProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	return &media.Session{Kind: "song", Tracks: []media.Track{{
		Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC,
		Open: func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
		},
	}}}, nil
}

func waitPreWarmed(t *testing.T, s *Scheduler, asset string) preWarmedEntry {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		s.mu.RLock()
		e, ok := s.preWarmed[asset]
		s.mu.RUnlock()
		if ok {
			return e
		}
	}
	t.Fatal("track never pre-warmed")
	return preWarmedEntry{}
}

// Prefetch of a track playback already opened must not capture (and later
// release) playback's session.
func TestPrefetchNeverReleasesPlaybackSession(t *testing.T) {
	pm := playback.NewWithProvider(okProvider{})
	s := NewScheduler(pm, func() string { return "t" }, func() string { return "m" }, nil, 1)

	playing, err := pm.Open(context.Background(), playback.OpenRequest{AssetID: "Y", Storefront: "us"})
	if err != nil {
		t.Fatal(err)
	}
	var p ContextPayload
	p.Context.Reason = "album-open"
	p.Tracks = []TrackItem{{AssetID: "Y", Storefront: "us"}}
	s.Submit(p)

	e := waitPreWarmed(t, s, "Y")
	if e.sessionID == playing.ID {
		t.Fatal("prefetch captured the playback session")
	}
	s.mu.Lock()
	e.expiresAt = time.Now().Add(-time.Second)
	s.preWarmed["Y"] = e
	s.mu.Unlock()
	s.PruneExpiredPreWarmed()

	if _, ok := pm.GetSession(playing.ID); !ok {
		t.Fatal("pruning pre-warmed sessions deleted the session the user is playing")
	}
}

func TestRewarmKeepsLosslessTier(t *testing.T) {
	pm := playback.NewWithProvider(okProvider{})
	s := NewScheduler(pm, func() string { return "t" }, func() string { return "m" }, nil, 1)
	s.rewarm(preWarmedEntry{lossless: true, req: playback.OpenRequest{AssetID: "L", Lossless: true}})
	if _, ok := s.TakePreWarmed("L", true); !ok {
		t.Fatal("re-warmed lossless session was stored as AAC and rejected")
	}
}

func TestQueueDepthBoundedAndJobsAccounted(t *testing.T) {
	// No workers: nothing drains the queue, as when workers yield to playback.
	s := &Scheduler{
		pm: nil, token: func() string { return "" }, mut: func() string { return "" },
		jobs: map[string]*WarmJob{}, dedup: map[string]bool{}, preWarmed: map[string]preWarmedEntry{},
		wq: newWorkQueue(),
	}
	var p ContextPayload
	p.Context.Reason = "album-open"
	for i := range 25 {
		p.Tracks = append(p.Tracks, TrackItem{AssetID: string(rune('a' + i)), Signals: TrackSignals{PlayCount: i}})
	}
	var ids []string
	for range 40 { // 40 × 25 = 1000 items
		ids = append(ids, s.Submit(p))
	}
	if d := s.wq.depth(); d != maxQueueDepth {
		t.Fatalf("queue depth = %d, want %d", d, maxQueueDepth)
	}
	queued := map[*WarmJob]int{}
	for _, it := range s.wq.h {
		queued[it.job]++
	}
	for _, id := range ids {
		s.mu.RLock()
		j, live := s.jobs[id]
		s.mu.RUnlock()
		if !live {
			continue // fully evicted jobs are done and pruned
		}
		snap := j.snapshot()
		if snap.Cancelled+queued[j] != snap.Total {
			t.Fatalf("job %s: cancelled %d + queued %d != total %d", id, snap.Cancelled, queued[j], snap.Total)
		}
	}
}

func TestClassifyErrorIgnoresDigitsInIDs(t *testing.T) {
	for msg, want := range map[string]string{
		"open 1440340123: connection reset by peer": FailReasonNetwork,
		"webplayback 1440340123: HTTP 401":          FailReasonAuth,
		"status 403 forbidden":                      FailReasonAuth,
		"catalog 1404123: 404":                      FailReasonNotFound,
		"asset 9403401: timeout":                    FailReasonTimeout,
	} {
		if got := classifyError(errors.New(msg)); got != want {
			t.Errorf("classifyError(%q) = %s, want %s", msg, got, want)
		}
	}
}
