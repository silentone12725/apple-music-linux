package playback

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"engine/core/pipeline"
)

// IsStreaming gates background cache-warming: while it reports true, prefetch
// workers yield so they never compete for bandwidth with the stream the user is
// listening to (the rule Apple's Android client applies in
// PlayerLoadControl.shouldPrepareNextPeriodForCaching). Two failure modes matter
// and both are silent, so pin them:
//
//   - stuck true  → prefetch is deferred forever and the cache never warms
//   - stuck false → prefetch competes with playback, the exact stall this fixed

func TestIsStreaming_FalseWhenIdle(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	if m.IsStreaming() {
		t.Fatal("a manager with no active stream must report IsStreaming()==false")
	}
	if got := m.ActiveStreams(); got != 0 {
		t.Fatalf("ActiveStreams()=%d, want 0", got)
	}
}

// blockingWriter reports that a write is in progress, then blocks until released,
// so the test can observe IsStreaming() *during* a live pipeline.Run.
type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingWriter) Write(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered) })
	<-b.release
	return len(p), nil
}

func TestIsStreaming_TrueDuringStream(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	bw := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- m.Stream(context.Background(), sess.ID, pipeline.KindAudio, bw) }()

	<-bw.entered // the stream is now mid-flight
	if !m.IsStreaming() {
		t.Error("IsStreaming()==false while a stream is actively writing; prefetch would compete with playback")
	}
	if got := m.ActiveStreams(); got != 1 {
		t.Errorf("ActiveStreams()=%d during one stream, want 1", got)
	}

	close(bw.release)
	if err := <-done; err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if m.IsStreaming() {
		t.Error("IsStreaming()==true after the stream finished; prefetch would be deferred forever")
	}
}

// errWriter fails immediately so pipeline.Run returns an error.
type errWriter struct{}

func (errWriter) Write([]byte) (int, error) { return 0, errors.New("boom") }

// The decrement is deferred, so it must run even when the stream errors — the
// case that would otherwise pin the counter above zero and starve warming.
func TestIsStreaming_UnwindsOnStreamError(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, errWriter{}); err == nil {
		t.Fatal("expected Stream to fail with a failing writer")
	}
	if m.IsStreaming() {
		t.Fatal("counter did not unwind after a failed stream")
	}
}

// A lookup failure returns before the counter is touched at all.
func TestIsStreaming_UnwindsOnUnknownSession(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	if err := m.Stream(context.Background(), "ghost", pipeline.KindAudio, io.Discard); err == nil {
		t.Fatal("expected error for unknown session")
	}
	if m.IsStreaming() {
		t.Fatal("counter moved for a session that was never found")
	}
}

// Concurrent streams must nest correctly and return to exactly zero.
func TestIsStreaming_ConcurrentStreamsBalance(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, err := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.Stream(context.Background(), sess.ID, pipeline.KindAudio, io.Discard)
		}()
	}
	wg.Wait()
	if got := m.ActiveStreams(); got != 0 {
		t.Fatalf("ActiveStreams()=%d after all streams finished, want 0", got)
	}
}
