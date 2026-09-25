package export

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"engine/core/diskcache"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
	"engine/internal/pq"
)

// Integration: real playback.Manager + real diskcache, fake provider whose
// source can pause mid-stream, driven the way handlers_playback.go drives a
// playback download into the streaming cache.

// gatedSource writes head, waits for gate, then writes tail. It is seekable so
// the test can prove playback's session survives an export.
type gatedSource struct {
	head, tail []byte
	gate       chan struct{}
}

func (s *gatedSource) Stream(ctx context.Context, w io.Writer) error {
	if _, err := w.Write(s.head); err != nil {
		return err
	}
	if s.gate != nil {
		select {
		case <-s.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	_, err := w.Write(s.tail)
	return err
}

func (s *gatedSource) SourceFrom(startSec float64) (pipeline.Source, float64) {
	all := append(append([]byte{}, s.head...), s.tail...)
	off := int(startSec) % len(all)
	return payloadSource{all[off:]}, startSec
}

type itProvider struct {
	mu      sync.Mutex
	sources map[string]*gatedSource
	opens   map[string]int
}

func (p *itProvider) Open(_ context.Context, req media.OpenRequest) (*media.Session, error) {
	p.mu.Lock()
	p.opens[req.AssetID]++
	src := p.sources[req.AssetID]
	p.mu.Unlock()
	return &media.Session{Kind: "song", Tracks: []media.Track{{
		Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC,
		Open: func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Source: src, Kind: pipeline.KindAudio, Codec: pipeline.CodecAAC}, nil
		},
	}}}, nil
}

func (p *itProvider) Opens(id string) int { p.mu.Lock(); defer p.mu.Unlock(); return p.opens[id] }

// testDiskCache mirrors the apiserver adapter (package main) over a real cache.
type testDiskCache struct{ c *diskcache.Cache }

func (d testDiskCache) Path(a, q string) (string, bool) { return d.c.Path(a, q) }
func (d testDiskCache) TailReader(a, q string) (io.ReadCloser, bool) {
	sw := d.c.GetStreaming(a, q)
	if sw == nil {
		return nil, false
	}
	return tailRC{sw.NewReader()}, true
}

type tailRC struct{ r *diskcache.StreamingReader }

func (t tailRC) Read(p []byte) (int, error) { return t.r.Read(p) }
func (t tailRC) Close() error               { t.r.Close(); return nil }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func newIntegration(t *testing.T, sources map[string]*gatedSource) (*Manager, *playback.Manager, *diskcache.Cache, *itProvider) {
	t.Helper()
	dc, err := diskcache.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	prov := &itProvider{sources: sources, opens: map[string]int{}}
	pm := playback.NewWithProvider(prov)
	m := &Manager{
		jobs:     make(map[string]*ExportJob),
		requests: make(map[string]ExportRequest),
		manager:  pm,
		cache:    testDiskCache{dc},
		queue:    pq.New[*workItem](),
		bw:       newBWController(pm.ForegroundStats, 0),
	}
	return m, pm, dc, prov
}

// startPlayback mimics handlers_playback.go: open (shared, non-private), then
// stream into a streaming cache entry keyed by sess.Codec, committing on success.
func startPlayback(t *testing.T, pm *playback.Manager, dc *diskcache.Cache, asset string) (*playback.Session, chan error) {
	t.Helper()
	sess, err := pm.Open(context.Background(), playback.OpenRequest{AssetID: asset, Storefront: "us"})
	if err != nil {
		t.Fatal(err)
	}
	spw, err := dc.BeginStreamingPut(asset, sess.Codec)
	if err != nil || spw == nil {
		t.Fatalf("BeginStreamingPut: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		err := pm.Stream(context.Background(), sess.ID, pipeline.KindAudio, spw)
		if err != nil {
			spw.Discard()
		} else {
			err = spw.Commit()
		}
		done <- err
	}()
	return sess, done
}

// Acceptance gate: export of the track that is playing rides playback's tail,
// playback keeps going, and after the export finishes playback can still seek
// on its original session.
func TestIntegration_ExportCurrentTrackFromPlaybackTail(t *testing.T) {
	head := bytes.Repeat([]byte{0xA1}, 10<<20) // ~10 MB before the pause
	tail := bytes.Repeat([]byte{0xB2}, 1<<20)
	src := &gatedSource{head: head, tail: tail, gate: make(chan struct{})}
	m, pm, dc, prov := newIntegration(t, map[string]*gatedSource{"A": src})

	playSess, playDone := startPlayback(t, pm, dc, "A")
	waitFor(t, "playback to write 10 MB", func() bool {
		sw := dc.GetStreaming("A", playSess.Codec)
		return sw != nil && sw.Written() >= int64(len(head))
	})
	if !pm.IsStreaming() {
		t.Fatal("playback not reported as streaming")
	}

	job := &ExportJob{ID: "exportA", AssetID: "A"}
	final := filepath.Join(t.TempDir(), "A.m4a")
	type res struct {
		tmp string
		ok  bool
	}
	exportDone := make(chan res, 1)
	go func() {
		tmp, ok := m.downloadToTemp(context.Background(), ExportRequest{AssetID: "A"}, job, "us", "en-US", final, 0)
		exportDone <- res{tmp, ok}
	}()

	waitFor(t, "export to attach to playback tail", func() bool {
		m.mu.RLock()
		defer m.mu.RUnlock()
		return job.Source == SourcePlayback && job.BytesDone >= int64(len(head))
	})
	if n := prov.Opens("A"); n != 1 {
		t.Fatalf("provider opened A %d times; export must not open its own session on a tail hit", n)
	}

	close(src.gate) // playback continues and finishes
	if err := <-playDone; err != nil {
		t.Fatalf("playback stream: %v", err)
	}
	r := <-exportDone
	if !r.ok {
		t.Fatalf("export failed: %s", job.Error)
	}
	got, _ := os.ReadFile(r.tmp)
	want := append(append([]byte{}, head...), tail...)
	if !bytes.Equal(got, want) {
		t.Fatalf("export bytes differ from playback bytes (%d vs %d)", len(got), len(want))
	}

	// Playback seeks backward on its original session — must still work.
	var buf bytes.Buffer
	if _, err := pm.StreamFrom(context.Background(), playSess.ID, pipeline.KindAudio, 3, &buf); err != nil {
		t.Fatalf("playback seek after export: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("seek returned no bytes")
	}
	if pm.IsStreaming() {
		t.Fatal("IsStreaming stuck true after playback and export finished")
	}
}

// Private-session path: exporting a different track opens its own private
// session, streams as Background under the throttle, releases it, and
// playback of A is unaffected throughout.
func TestIntegration_ExportOtherTrackUsesPrivateSession(t *testing.T) {
	srcA := &gatedSource{head: []byte("A-HEAD"), tail: []byte("A-TAIL"), gate: make(chan struct{})}
	srcB := &gatedSource{head: []byte("B-BYTES"), tail: nil}
	m, pm, dc, prov := newIntegration(t, map[string]*gatedSource{"A": srcA, "B": srcB})

	playSess, playDone := startPlayback(t, pm, dc, "A")
	waitFor(t, "playback of A mid-stream", func() bool {
		sw := dc.GetStreaming("A", playSess.Codec)
		return sw != nil && sw.Written() >= int64(len(srcA.head))
	})

	job := &ExportJob{ID: "exportB", AssetID: "B"}
	final := filepath.Join(t.TempDir(), "B.m4a")
	tmp, ok := m.downloadToTemp(context.Background(), ExportRequest{AssetID: "B"}, job, "us", "en-US", final, 0)
	if !ok {
		t.Fatalf("export B failed: %s", job.Error)
	}
	if got, _ := os.ReadFile(tmp); !bytes.Equal(got, srcB.head) {
		t.Fatalf("export B bytes %q", got)
	}
	if job.Source != SourceNetwork {
		t.Fatalf("Source=%q, want network", job.Source)
	}
	if prov.Opens("B") != 1 {
		t.Fatalf("B opens=%d, want 1 (private session)", prov.Opens("B"))
	}
	// While A plays, only A is foreground.
	if active, _, _ := pm.ForegroundStats(); active != 1 {
		t.Fatalf("foreground streams=%d during export, want 1 (A only)", active)
	}
	if m.bw.currentLimit() != nil {
		t.Fatal("controller still running after export finished")
	}

	// Playback A is still intact: its session exists, and it can finish and seek.
	if _, ok := pm.GetSession(playSess.ID); !ok {
		t.Fatal("playback session A was removed by the export")
	}
	close(srcA.gate)
	if err := <-playDone; err != nil {
		t.Fatalf("playback A: %v", err)
	}
	var buf bytes.Buffer
	if _, err := pm.StreamFrom(context.Background(), playSess.ID, pipeline.KindAudio, 1, &buf); err != nil {
		t.Fatalf("playback A seek: %v", err)
	}
	// A second open of A still reuses the playback session (index intact).
	again, _ := pm.Open(context.Background(), playback.OpenRequest{AssetID: "A", Storefront: "us"})
	if again.ID != playSess.ID {
		t.Fatal("playback session A no longer indexed for reuse")
	}
	if pm.IsStreaming() {
		t.Fatal("IsStreaming true after everything finished")
	}
}

// The export's network stream is actually throttled while playback streams:
// the controller engages from the first byte.
func TestIntegration_NetworkExportThrottledDuringPlayback(t *testing.T) {
	srcA := &gatedSource{head: []byte("A"), tail: []byte("A"), gate: make(chan struct{})}
	// B larger than the limiter burst so the 1 MiB/s start rate has to pace it.
	srcB := &gatedSource{head: bytes.Repeat([]byte{1}, 384<<10)}
	m, pm, dc, _ := newIntegration(t, map[string]*gatedSource{"A": srcA, "B": srcB})

	playSess, playDone := startPlayback(t, pm, dc, "A")
	waitFor(t, "playback of A mid-stream", func() bool {
		sw := dc.GetStreaming("A", playSess.Codec)
		return sw != nil && sw.Written() >= 1
	})

	job := &ExportJob{ID: "exportB", AssetID: "B"}
	final := filepath.Join(t.TempDir(), "B.m4a")
	var (
		mu       sync.Mutex
		sawLimit bool
	)
	stop := make(chan struct{})
	go func() { // sample the controller while the export runs
		for {
			select {
			case <-stop:
				return
			default:
			}
			if m.bw.currentLimit() != nil {
				mu.Lock()
				sawLimit = true
				mu.Unlock()
			}
			time.Sleep(time.Millisecond)
		}
	}()
	start := time.Now()
	_, ok := m.downloadToTemp(context.Background(), ExportRequest{AssetID: "B"}, job, "us", "en-US", final, 0)
	close(stop)
	if !ok {
		t.Fatalf("export B: %s", job.Error)
	}
	if el := time.Since(start); el < 100*time.Millisecond {
		t.Fatalf("export finished in %v during playback — not throttled", el)
	}
	mu.Lock()
	defer mu.Unlock()
	if !sawLimit {
		t.Fatal("controller never applied a finite limit during playback")
	}
	close(srcA.gate)
	<-playDone
}
