package playback

import (
	"context"
	"errors"
	"testing"
	"time"

	"engine/core/media"
	"engine/core/pipeline"
)

func TestOpenTracks_OpensConcurrentlyInOrder(t *testing.T) {
	aOpen, vOpen := make(chan struct{}), make(chan struct{})
	sa, sv := &pipeline.Stream{}, &pipeline.Stream{}
	tracks := []media.Track{
		{Kind: pipeline.KindAudio, Open: func(context.Context) (*pipeline.Stream, error) {
			close(aOpen)
			<-vOpen // returns only once the other open has started: impossible if serial
			return sa, nil
		}},
		{Kind: pipeline.KindVideo, Open: func(context.Context) (*pipeline.Stream, error) {
			close(vOpen)
			<-aOpen
			return sv, nil
		}},
	}
	done := make(chan struct{})
	var got []*pipeline.Stream
	var err error
	go func() { got, err = openTracks(context.Background(), "x", tracks); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("opens did not overlap")
	}
	if err != nil || len(got) != 2 || got[0] != sa || got[1] != sv {
		t.Fatalf("got %v, %v; want [audio video] in track order", got, err)
	}
}

func TestOpenTracks_FailureCancelsTheOther(t *testing.T) {
	boom := errors.New("boom")
	cancelled := make(chan struct{})
	tracks := []media.Track{
		{Kind: pipeline.KindAudio, Open: func(ctx context.Context) (*pipeline.Stream, error) {
			<-ctx.Done()
			close(cancelled)
			return nil, ctx.Err()
		}},
		{Kind: pipeline.KindVideo, Open: func(context.Context) (*pipeline.Stream, error) { return nil, boom }},
	}
	_, err := openTracks(context.Background(), "x", tracks)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want it to wrap the video failure (not the induced cancel)", err)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("the other open was not cancelled")
	}
}

func TestOpenTracks_SingleTrackAndNone(t *testing.T) {
	s := &pipeline.Stream{}
	got, err := openTracks(context.Background(), "x", []media.Track{{Kind: pipeline.KindAudio,
		Open: func(context.Context) (*pipeline.Stream, error) { return s, nil }}})
	if err != nil || len(got) != 1 || got[0] != s {
		t.Fatalf("single: %v, %v", got, err)
	}
	if got, err := openTracks(context.Background(), "x", nil); err != nil || len(got) != 0 {
		t.Fatalf("none: %v, %v", got, err)
	}
}
