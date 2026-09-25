package export

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
	"engine/internal/pq"
)

// ── fakes ─────────────────────────────────────────────────────────────────────

var networkPayload = []byte("NETWORK-AUDIO-BYTES")

type payloadSource struct{ b []byte }

func (s payloadSource) Stream(_ context.Context, w io.Writer) error {
	_, err := w.Write(s.b)
	return err
}

// countingProvider serves a fixed song (and optionally a video track) and
// counts Opens so tests can prove the network path was or was not taken.
type countingProvider struct {
	mu    sync.Mutex
	opens int
	video bool
}

func (p *countingProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	p.mu.Lock()
	p.opens++
	p.mu.Unlock()
	track := func(kind pipeline.StreamKind, b []byte) media.Track {
		return media.Track{Kind: kind, Codec: pipeline.CodecAAC, Open: func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Source: payloadSource{b}, Kind: kind, Codec: pipeline.CodecAAC}, nil
		}}
	}
	sess := &media.Session{Kind: "song", Tracks: []media.Track{track(pipeline.KindAudio, networkPayload)}}
	if p.video {
		sess.Kind = "mv"
		sess.Tracks = append(sess.Tracks, track(pipeline.KindVideo, []byte("VIDEO")))
	}
	return sess, nil
}

func (p *countingProvider) Opens() int { p.mu.Lock(); defer p.mu.Unlock(); return p.opens }

type fakeCache struct {
	mu        sync.Mutex
	path      string
	tail      func() io.ReadCloser
	calls     int
	qualifier string
}

func (c *fakeCache) Path(_, q string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.qualifier = q
	return c.path, c.path != ""
}

func (c *fakeCache) TailReader(_, q string) (io.ReadCloser, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.tail == nil {
		return nil, false
	}
	return c.tail(), true
}

// failingTail yields some bytes, then fails like a Discarded producer.
type failingTail struct {
	data []byte
	sent bool
}

func (f *failingTail) Read(p []byte) (int, error) {
	if !f.sent {
		f.sent = true
		return copy(p, f.data), nil
	}
	return 0, errors.New("streaming cache download failed or was abandoned")
}
func (f *failingTail) Close() error { return nil }

// blockingTail never delivers, like a producer that stalls.
type blockingTail struct{ closed chan struct{} }

func (b *blockingTail) Read([]byte) (int, error) { <-b.closed; return 0, io.ErrClosedPipe }
func (b *blockingTail) Close() error             { return nil }

func newReuseManager(t *testing.T, p *countingProvider, c AudioCache) *Manager {
	t.Helper()
	pm := playback.NewWithProvider(p)
	m := &Manager{
		jobs:     make(map[string]*ExportJob),
		requests: make(map[string]ExportRequest),
		manager:  pm,
		queue:    pq.New[*workItem](),
		bw:       newBWController(pm.ForegroundStats, 0),
	}
	if c != nil {
		m.cache = c
	}
	return m
}

func runDownload(t *testing.T, m *Manager, ctx context.Context, req ExportRequest) (*ExportJob, []byte, bool) {
	t.Helper()
	job := &ExportJob{ID: "job1", AssetID: req.AssetID}
	final := filepath.Join(t.TempDir(), "out", "track.m4a")
	tmp, ok := m.downloadToTemp(ctx, req, job, "us", "en-US", final, 0)
	if !ok {
		return job, nil, false
	}
	b, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("read temp: %v", err)
	}
	return job, b, true
}

// ── tests ─────────────────────────────────────────────────────────────────────

func TestExportAudioQualifier(t *testing.T) {
	t.Parallel()
	cases := []struct {
		c    ExportCapabilities
		want pipeline.Codec
	}{
		{ExportCapabilities{}, pipeline.CodecAAC},
		{ExportCapabilities{Lossless: true}, pipeline.CodecALAC},
		{ExportCapabilities{Atmos: true}, pipeline.CodecAtmos},
		// Atmos wins over lossless, matching the provider's selection order.
		{ExportCapabilities{Atmos: true, Lossless: true}, pipeline.CodecAtmos},
	}
	for _, tc := range cases {
		if got := exportAudioQualifier(tc.c); got != string(tc.want) {
			t.Errorf("%+v → %q, want %q", tc.c, got, tc.want)
		}
	}
}

func TestReuse_CacheHitSkipsNetwork(t *testing.T) {
	t.Parallel()
	cached := filepath.Join(t.TempDir(), "cached.m4a")
	want := []byte("CACHED-BYTES")
	os.WriteFile(cached, want, 0o644)

	p := &countingProvider{}
	c := &fakeCache{path: cached}
	m := newReuseManager(t, p, c)
	job, got, ok := runDownload(t, m, context.Background(), ExportRequest{AssetID: "a", Capabilities: ExportCapabilities{Lossless: true}})
	if !ok {
		t.Fatalf("download failed: %s", job.Error)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if p.Opens() != 0 {
		t.Errorf("provider opened %d times on a cache hit", p.Opens())
	}
	if job.Source != SourceCache {
		t.Errorf("Source=%q, want cache", job.Source)
	}
	if c.qualifier != "alac" {
		t.Errorf("looked up qualifier %q, want alac", c.qualifier)
	}
}

func TestReuse_TailHitSkipsNetwork(t *testing.T) {
	t.Parallel()
	want := []byte("PLAYBACK-TAIL-BYTES")
	p := &countingProvider{}
	c := &fakeCache{tail: func() io.ReadCloser { return io.NopCloser(bytes.NewReader(want)) }}
	m := newReuseManager(t, p, c)
	job, got, ok := runDownload(t, m, context.Background(), ExportRequest{AssetID: "a"})
	if !ok {
		t.Fatalf("download failed: %s", job.Error)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if p.Opens() != 0 {
		t.Errorf("provider opened %d times on a tail hit", p.Opens())
	}
	if job.Source != SourcePlayback {
		t.Errorf("Source=%q, want playback", job.Source)
	}
}

// A failed tail must not leave its partial bytes in front of the network copy.
func TestReuse_TailFailureFallsBackCleanly(t *testing.T) {
	t.Parallel()
	p := &countingProvider{}
	c := &fakeCache{tail: func() io.ReadCloser { return &failingTail{data: []byte("PARTIAL-")} }}
	m := newReuseManager(t, p, c)
	job, got, ok := runDownload(t, m, context.Background(), ExportRequest{AssetID: "a"})
	if !ok {
		t.Fatalf("download failed: %s", job.Error)
	}
	if !bytes.Equal(got, networkPayload) {
		t.Errorf("got %q, want exactly the network payload %q", got, networkPayload)
	}
	if p.Opens() != 1 {
		t.Errorf("provider opens=%d, want 1", p.Opens())
	}
	if job.Source != SourceNetwork {
		t.Errorf("Source=%q, want network", job.Source)
	}
	if job.BytesDone != int64(len(networkPayload)) {
		t.Errorf("BytesDone=%d, want %d (progress must reset after the failed tail)", job.BytesDone, len(networkPayload))
	}
}

func TestReuse_NilCacheUsesNetwork(t *testing.T) {
	t.Parallel()
	p := &countingProvider{}
	m := newReuseManager(t, p, nil)
	job, got, ok := runDownload(t, m, context.Background(), ExportRequest{AssetID: "a"})
	if !ok {
		t.Fatalf("download failed: %s", job.Error)
	}
	if !bytes.Equal(got, networkPayload) {
		t.Errorf("got %q", got)
	}
	if job.Source != SourceNetwork {
		t.Errorf("Source=%q, want network", job.Source)
	}
}

func TestReuse_VideoNeverConsultsAudioCache(t *testing.T) {
	t.Parallel()
	p := &countingProvider{video: true}
	c := &fakeCache{path: "/nonexistent-but-reported"}
	m := newReuseManager(t, p, c)
	// The mux step needs ffmpeg and may fail here; only the source choice matters.
	runDownload(t, m, context.Background(), ExportRequest{
		AssetID:      "a",
		Capabilities: ExportCapabilities{Video: true},
		Options:      ExportOptions{FFmpegPath: "/nonexistent/ffmpeg"},
	})
	if c.calls != 0 {
		t.Errorf("AudioCache consulted %d times for a video export", c.calls)
	}
	if p.Opens() != 1 {
		t.Errorf("provider opens=%d, want 1", p.Opens())
	}
}

// A job cancelled while blocked on a stalled tail must return promptly and
// leave no temp file behind.
func TestReuse_CancelWhileTailBlocked(t *testing.T) {
	t.Parallel()
	bt := &blockingTail{closed: make(chan struct{})}
	defer close(bt.closed)
	p := &countingProvider{}
	m := newReuseManager(t, p, &fakeCache{tail: func() io.ReadCloser { return bt }})

	ctx, cancel := context.WithCancel(context.Background())
	job := &ExportJob{ID: "job1"}
	dir := t.TempDir()
	final := filepath.Join(dir, "track.m4a")
	res := make(chan bool, 1)
	go func() {
		_, ok := m.downloadToTemp(ctx, ExportRequest{AssetID: "a"}, job, "us", "en-US", final, 0)
		res <- ok
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case ok := <-res:
		if ok {
			t.Fatal("cancelled download reported success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("download did not return after cancellation")
	}
	if p.Opens() != 0 {
		t.Errorf("cancelled job fell through to the network (opens=%d)", p.Opens())
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		t.Errorf("leftover file %s", e.Name())
	}
}
