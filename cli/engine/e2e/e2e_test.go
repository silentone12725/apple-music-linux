// Package e2e exercises the full engine data path end to end without any
// network access: a fake media.Provider produces a media.Session whose tracks
// open real pipeline.Streams, which are then run into a bytes.Buffer.
//
// SCOPE NOTE: playback.Manager.New() hardcodes apple.NewProvider() and its
// provider field is unexported, so a fake provider cannot be injected into the
// real Manager from outside package playback without a production seam (which
// the frozen-architecture rule forbids). The Manager's own bookkeeping is
// covered white-box in engine/playback. Here we drive the identical downstream
// path the Manager uses — Provider.Open → Track.Open → pipeline.Run — directly.
package e2e

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"sync"
	"testing"

	"main/engine/media"
	"main/engine/pipeline"
)

// fakeSource writes a fixed payload; no network.
type fakeSource struct{ payload []byte }

func (f *fakeSource) Stream(ctx context.Context, w io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := w.Write(f.payload)
	return err
}

// fakeProvider implements media.Provider entirely in memory.
type fakeProvider struct {
	sess *media.Session
}

func (f *fakeProvider) Open(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	return f.sess, nil
}

func track(kind pipeline.StreamKind, codec pipeline.Codec, payload []byte) media.Track {
	return media.Track{
		Kind:  kind,
		Codec: codec,
		Open: func(ctx context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Source: &fakeSource{payload: payload}, Kind: kind, Codec: codec}, nil
		},
	}
}

// runSession opens every track and runs the requested kind into a buffer,
// mirroring what playback.Manager.Open+Stream do internally.
func runSession(t *testing.T, p media.Provider, req media.OpenRequest, kind pipeline.StreamKind) []byte {
	t.Helper()
	sess, err := p.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("provider Open: %v", err)
	}
	for _, tr := range sess.Tracks {
		if tr.Kind != kind {
			continue
		}
		stream, err := tr.Open(context.Background())
		if err != nil {
			t.Fatalf("track Open: %v", err)
		}
		var buf bytes.Buffer
		if err := pipeline.Run(context.Background(), stream, &buf); err != nil {
			t.Fatalf("pipeline Run: %v", err)
		}
		return buf.Bytes()
	}
	t.Fatalf("no track of kind %s", kind)
	return nil
}

func TestE2E_SongSession(t *testing.T) {
	t.Parallel()
	p := &fakeProvider{sess: &media.Session{
		Kind:   "song",
		Tracks: []media.Track{track(pipeline.KindAudio, pipeline.CodecALAC, []byte("SONGAUDIO"))},
	}}
	got := runSession(t, p, media.OpenRequest{AssetID: "1"}, pipeline.KindAudio)
	if string(got) != "SONGAUDIO" {
		t.Errorf("got %q want SONGAUDIO", got)
	}
}

func TestE2E_MVSession(t *testing.T) {
	t.Parallel()
	p := &fakeProvider{sess: &media.Session{
		Kind: "mv",
		Tracks: []media.Track{
			track(pipeline.KindVideo, pipeline.CodecH264, []byte("VID")),
			track(pipeline.KindAudio, pipeline.CodecAAC, []byte("AUD")),
		},
	}}
	if got := runSession(t, p, media.OpenRequest{AssetID: "1", Video: true}, pipeline.KindAudio); string(got) != "AUD" {
		t.Errorf("audio got %q want AUD", got)
	}
	if got := runSession(t, p, media.OpenRequest{AssetID: "1", Video: true}, pipeline.KindVideo); string(got) != "VID" {
		t.Errorf("video got %q want VID", got)
	}
}

func TestE2E_TwoSessionsConcurrent(t *testing.T) {
	t.Parallel()
	var wg sync.WaitGroup
	for i, payload := range []string{"AAA", "BBB"} {
		wg.Add(1)
		go func(i int, payload string) {
			defer wg.Done()
			p := &fakeProvider{sess: &media.Session{
				Kind:   "song",
				Tracks: []media.Track{track(pipeline.KindAudio, pipeline.CodecALAC, []byte(payload))},
			}}
			got := runSession(t, p, media.OpenRequest{AssetID: "x"}, pipeline.KindAudio)
			if string(got) != payload {
				t.Errorf("session %d corrupted: got %q want %q", i, got, payload)
			}
		}(i, payload)
	}
	wg.Wait()
}

func TestE2E_LargePayload(t *testing.T) {
	t.Parallel()
	payload := make([]byte, 1<<20)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	want := sha256.Sum256(payload)
	p := &fakeProvider{sess: &media.Session{
		Kind:   "song",
		Tracks: []media.Track{track(pipeline.KindAudio, pipeline.CodecALAC, payload)},
	}}
	got := runSession(t, p, media.OpenRequest{AssetID: "1"}, pipeline.KindAudio)
	if len(got) != len(payload) {
		t.Fatalf("got %d bytes want %d", len(got), len(payload))
	}
	if sha256.Sum256(got) != want {
		t.Fatal("payload corrupted across engine path")
	}
}
