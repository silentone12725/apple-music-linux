package prefetch

import (
	"context"
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
