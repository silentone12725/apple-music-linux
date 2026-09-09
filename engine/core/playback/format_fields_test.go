package playback

import (
	"context"
	"testing"

	"engine/core/media"
	"engine/core/pipeline"
)

func TestSession_FormatFieldsPropagated(t *testing.T) {
	p := &formatProvider{}
	m := newTestManager(p)

	s, err := m.Open(context.Background(), OpenRequest{AssetID: "fmt-track", Storefront: "us"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if s.Codec != "aac" {
		t.Errorf("Codec: got %q, want %q", s.Codec, "aac")
	}
	if s.BitRate != 256_000 {
		t.Errorf("BitRate: got %d, want %d", s.BitRate, 256_000)
	}
	if s.ChannelCount != 2 {
		t.Errorf("ChannelCount: got %d, want %d", s.ChannelCount, 2)
	}
	if s.CodecMIMEType != `audio/mp4; codecs="mp4a.40.2"` {
		t.Errorf("CodecMIMEType: got %q", s.CodecMIMEType)
	}
	if s.SampleRate != 44100 {
		t.Errorf("SampleRate: got %d, want %d", s.SampleRate, 44100)
	}
}

func TestSession_FormatFields_SecondTrackDoesNotOverwrite(t *testing.T) {
	p := &dualTrackProvider{}
	m := newTestManager(p)

	s, err := m.Open(context.Background(), OpenRequest{AssetID: "dual", Storefront: "us"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// First audio track wins — codec must be "aac", not "alac".
	if s.Codec != "aac" {
		t.Errorf("expected first track codec %q, got %q", "aac", s.Codec)
	}
}

// formatProvider returns a track with well-defined format fields.
type formatProvider struct{}

func (formatProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	return &media.Session{
		Kind:     "song",
		Metadata: media.Metadata{Title: req.AssetID},
		Tracks: []media.Track{
			{
				Kind:          pipeline.KindAudio,
				Codec:         pipeline.CodecAAC,
				SampleRate:    44100,
				BitRate:       256_000,
				ChannelCount:  2,
				CodecMIMEType: `audio/mp4; codecs="mp4a.40.2"`,
				Open: func(_ context.Context) (*pipeline.Stream, error) {
					return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
				},
			},
		},
	}, nil
}

// dualTrackProvider returns two audio tracks; the second must not overwrite the first.
type dualTrackProvider struct{}

func (dualTrackProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	return &media.Session{
		Kind:     "song",
		Metadata: media.Metadata{Title: req.AssetID},
		Tracks: []media.Track{
			{
				Kind:         pipeline.KindAudio,
				Codec:        pipeline.CodecAAC,
				ChannelCount: 2,
				Open: func(_ context.Context) (*pipeline.Stream, error) {
					return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
				},
			},
			{
				Kind:         pipeline.KindAudio,
				Codec:        pipeline.CodecALAC,
				ChannelCount: 2,
				Open: func(_ context.Context) (*pipeline.Stream, error) {
					return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecALAC}, nil
				},
			},
		},
	}, nil
}
