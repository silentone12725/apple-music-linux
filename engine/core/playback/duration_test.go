package playback

import (
	"context"
	"testing"

	"engine/core/media"
	"engine/core/pipeline"
)

// A session reports the length its stream declares when that differs from the catalog's by more than the tolerance.
func TestOpenReportsStreamDuration(t *testing.T) {
	for _, tc := range []struct {
		name            string
		catalog, stream int
		want            int
	}{
		{"shorter stream", 200000, 187000, 187000},
		{"longer stream", 200000, 214500, 214500},
		{"within tolerance", 200000, 200600, 200000},
		{"unknown stream length", 200000, 0, 200000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTestManager(&stubProvider{resp: &media.Session{
				Kind:     "song",
				Metadata: media.Metadata{DurationMs: tc.catalog},
				Tracks: []media.Track{{
					Kind:  pipeline.KindAudio,
					Codec: pipeline.CodecAAC,
					Open: func(context.Context) (*pipeline.Stream, error) {
						return &pipeline.Stream{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC, DurationMs: tc.stream}, nil
					},
				}},
			}})
			s, err := m.Open(context.Background(), OpenRequest{AssetID: "dur-" + tc.name})
			if err != nil {
				t.Fatal(err)
			}
			if s.DurationMs != tc.want {
				t.Errorf("DurationMs = %d, want %d", s.DurationMs, tc.want)
			}
		})
	}
}

// A music video has an audio and a video stream; the longer declared length is the one the player runs to.
func TestOpenUsesLongestStreamDuration(t *testing.T) {
	open := func(ms int, kind pipeline.StreamKind) func(context.Context) (*pipeline.Stream, error) {
		return func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Kind: kind, DurationMs: ms}, nil
		}
	}
	m := newTestManager(&stubProvider{resp: &media.Session{
		Kind:     "mv",
		Metadata: media.Metadata{DurationMs: 214000},
		Tracks: []media.Track{
			{Kind: pipeline.KindVideo, Open: open(205000, pipeline.KindVideo)},
			{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC, Open: open(205200, pipeline.KindAudio)},
		},
	}})
	s, err := m.Open(context.Background(), OpenRequest{AssetID: "dur-mv", Video: true})
	if err != nil {
		t.Fatal(err)
	}
	if s.DurationMs != 205200 {
		t.Errorf("DurationMs = %d, want 205200", s.DurationMs)
	}
}

// A video that fell back to a lower variant advertises that variant's codec string, not the one it was planned with.
func TestOpenUsesTheOpenedVideoCodecString(t *testing.T) {
	for _, tc := range []struct{ name, planned, opened, want string }{
		{"fell back", "hvc1.2.4", "avc1.640028", "avc1.640028"},
		{"no override", "avc1.640028", "", "avc1.640028"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTestManager(&stubProvider{resp: &media.Session{
				Kind: "mv",
				Tracks: []media.Track{{
					Kind: pipeline.KindVideo, CodecString: tc.planned,
					Open: func(context.Context) (*pipeline.Stream, error) {
						return &pipeline.Stream{Kind: pipeline.KindVideo, CodecString: tc.opened}, nil
					},
				}},
			}})
			s, err := m.Open(context.Background(), OpenRequest{AssetID: "codec-" + tc.name, Video: true})
			if err != nil {
				t.Fatal(err)
			}
			if s.Capabilities.VideoCodec != tc.want {
				t.Errorf("VideoCodec = %q, want %q", s.Capabilities.VideoCodec, tc.want)
			}
		})
	}
}
