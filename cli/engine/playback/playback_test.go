package playback

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"main/engine/media"
	"main/engine/pipeline"
)

// ── Fakes ───────────────────────────────────────────────────────────────────

// fakeSource writes deterministic bytes; no network.
type fakeSource struct{ payload []byte }

func (f *fakeSource) Stream(ctx context.Context, w io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := w.Write(f.payload)
	return err
}

// fakeProvider returns a canned media.Session (or error) and counts calls.
type fakeProvider struct {
	mu    sync.Mutex
	calls int
	sess  *media.Session
	err   error
}

func (f *fakeProvider) Open(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return f.sess, nil
}

// trackOpener builds a passthrough stream carrying the given payload.
func trackOpener(kind pipeline.StreamKind, codec pipeline.Codec, payload []byte, openErr error) func(context.Context) (*pipeline.Stream, error) {
	return func(ctx context.Context) (*pipeline.Stream, error) {
		if openErr != nil {
			return nil, openErr
		}
		return &pipeline.Stream{
			Source: &fakeSource{payload: payload},
			Kind:   kind,
			Codec:  codec,
		}, nil
	}
}

// newManagerWith builds a Manager backed by a fake provider (white-box: the
// provider field is unexported, so this must live in package playback).
func newManagerWith(p media.Provider) *Manager {
	// Deliberately do NOT call New() — that starts apple.NewProvider() and a
	// reaper goroutine. We only need the provider wired for these tests.
	return &Manager{provider: p}
}

func songSession() *media.Session {
	return &media.Session{
		Kind: "song",
		Metadata: media.Metadata{
			Title:      "Song Title",
			ArtistName: "Artist",
			AlbumName:  "Album",
			DurationMs: 210000,
			ArtworkURL: "http://art/500.jpg",
			HasLyrics:  true,
		},
		Tracks: []media.Track{{
			Kind:       pipeline.KindAudio,
			Codec:      pipeline.CodecALAC,
			SampleRate: 96000,
			BitDepth:   24,
			Open:       trackOpener(pipeline.KindAudio, pipeline.CodecALAC, []byte("AUDIO"), nil),
		}},
	}
}

func mvSession() *media.Session {
	return &media.Session{
		Kind:     "mv",
		Metadata: media.Metadata{Title: "MV"},
		Tracks: []media.Track{
			{Kind: pipeline.KindVideo, Codec: pipeline.CodecH264, Open: trackOpener(pipeline.KindVideo, pipeline.CodecH264, []byte("VIDEO"), nil)},
			{Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC, Open: trackOpener(pipeline.KindAudio, pipeline.CodecAAC, []byte("AUDIO"), nil)},
		},
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

func TestOpen_Song(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if sess.Type != "song" || sess.Title != "Song Title" || sess.ArtistName != "Artist" {
		t.Errorf("bad session fields: %+v", sess)
	}
	if sess.Codec != "alac" || sess.SampleRate != 96000 || sess.BitDepth != 24 {
		t.Errorf("codec/quality = %s %d/%d", sess.Codec, sess.SampleRate, sess.BitDepth)
	}
}

func TestOpen_SetsAudioCapability(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if !sess.Capabilities.Audio {
		t.Error("expected Audio capability")
	}
	if sess.Capabilities.Video {
		t.Error("audio-only session should not have Video capability")
	}
}

func TestOpen_SetsVideoCapability(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: mvSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1", Video: true})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !sess.Capabilities.Video {
		t.Error("expected Video capability")
	}
	if sess.Streams.Video == "" {
		t.Error("expected Streams.Video populated")
	}
}

func TestOpen_NoVideoCapability(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if sess.Capabilities.Video {
		t.Error("did not expect Video capability")
	}
	if sess.Streams.Video != "" {
		t.Error("did not expect Streams.Video")
	}
}

func TestOpen_AudioStreamURL(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if sess.Streams.Audio == "" {
		t.Fatal("expected Streams.Audio")
	}
	if !bytes.Contains([]byte(sess.Streams.Audio), []byte(sess.ID)) {
		t.Errorf("Streams.Audio %q does not contain session ID %q", sess.Streams.Audio, sess.ID)
	}
}

func TestOpen_ProviderError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("provider down")
	m := newManagerWith(&fakeProvider{err: sentinel})
	_, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected %v got %v", sentinel, err)
	}
}

func TestOpen_TrackOpenError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("track open failed")
	sess := &media.Session{
		Kind: "song",
		Tracks: []media.Track{{
			Kind: pipeline.KindAudio,
			Open: trackOpener(pipeline.KindAudio, pipeline.CodecAAC, nil, sentinel),
		}},
	}
	m := newManagerWith(&fakeProvider{sess: sess})
	_, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected %v got %v", sentinel, err)
	}
}

func TestGetSession_Found(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	got, ok := m.GetSession(sess.ID)
	if !ok || got.ID != sess.ID {
		t.Fatalf("GetSession(%s) = %v, %v", sess.ID, got, ok)
	}
}

func TestGetSession_NotFound(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	if _, ok := m.GetSession("nope"); ok {
		t.Error("expected not found for unknown ID")
	}
}

func TestStream_WritesBytes(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	var buf bytes.Buffer
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, &buf); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if buf.String() != "AUDIO" {
		t.Errorf("got %q want AUDIO", buf.String())
	}
}

func TestStream_UnknownSession(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	err := m.Stream(context.Background(), "ghost", pipeline.KindAudio, io.Discard)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("ghost")) {
		t.Fatalf("expected error naming session, got %v", err)
	}
}

func TestStream_UnknownKind(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	err := m.Stream(context.Background(), sess.ID, pipeline.KindVideo, io.Discard)
	if err == nil {
		t.Fatal("expected error for missing kind")
	}
}

func TestStream_CorrectKind(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: mvSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1", Video: true})
	var a, v bytes.Buffer
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, &a); err != nil {
		t.Fatal(err)
	}
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindVideo, &v); err != nil {
		t.Fatal(err)
	}
	if a.String() != "AUDIO" || v.String() != "VIDEO" {
		t.Errorf("routing wrong: audio=%q video=%q", a.String(), v.String())
	}
}

func TestRelease_RemovesSession(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	m.Release(sess.ID)
	if _, ok := m.GetSession(sess.ID); ok {
		t.Error("session still present after Release")
	}
}

func TestRelease_StreamFails(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	m.Release(sess.ID)
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, io.Discard); err == nil {
		t.Error("expected Stream error after Release")
	}
}

func TestRelease_Idempotent(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	m.Release(sess.ID)
	m.Release(sess.ID) // must not panic
}

func TestOpen_Concurrent(t *testing.T) {
	t.Parallel()
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Each goroutine gets its own manager+provider to avoid shared session state.
			m := newManagerWith(&fakeProvider{sess: songSession()})
			sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
			if err != nil {
				t.Error(err)
				return
			}
			var buf bytes.Buffer
			if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, &buf); err != nil {
				t.Error(err)
			}
			m.Release(sess.ID)
		}()
	}
	wg.Wait()
}

func TestOpen_LyricsCapability(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if !sess.Capabilities.Lyrics {
		t.Error("expected Lyrics capability from HasLyrics=true")
	}
}

// ── Benchmarks ──────────────────────────────────────────────────────────────

func BenchmarkManagerOpen(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m := newManagerWith(&fakeProvider{sess: songSession()})
		if _, err := m.Open(context.Background(), OpenRequest{AssetID: "1"}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkManagerStream(b *testing.B) {
	b.ReportAllocs()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var buf bytes.Buffer
		if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, &buf); err != nil {
			b.Fatal(err)
		}
	}
}
