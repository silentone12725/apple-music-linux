package playback

import (
	"bytes"
	"context"
	"testing"

	"engine/core/pipeline"
)

// Background streams (exports) must never look like playback: IsStreaming
// gates the prefetcher, and ForegroundStats drives the export throttle.

func TestBackgroundStream_NotStreaming(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})

	bw := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	ctx := WithClass(context.Background(), Background)
	go func() { done <- m.Stream(ctx, sess.ID, pipeline.KindAudio, bw) }()

	<-bw.entered
	if m.IsStreaming() {
		t.Error("a Background stream made IsStreaming() true")
	}
	if got := m.ActiveStreams(); got != 1 {
		t.Errorf("ActiveStreams()=%d, want 1 (metrics count every class)", got)
	}
	if active, _, need := m.ForegroundStats(); active != 0 || need != 0 {
		t.Errorf("ForegroundStats active=%d need=%d during Background stream, want 0/0", active, need)
	}
	close(bw.release)
	if err := <-done; err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if got := m.ActiveStreams(); got != 0 {
		t.Errorf("ActiveStreams()=%d after stream, want 0", got)
	}
}

func TestForegroundStats_DuringAndAfter(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})

	bw := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- m.Stream(context.Background(), sess.ID, pipeline.KindAudio, bw) }()

	<-bw.entered
	active, _, need := m.ForegroundStats()
	if active != 1 {
		t.Errorf("active=%d, want 1", active)
	}
	if need != defaultAudioNeedBps {
		t.Errorf("needBps=%d, want audio fallback %d (session has no BitRate)", need, defaultAudioNeedBps)
	}
	close(bw.release)
	<-done

	active, bytesOut, need := m.ForegroundStats()
	if active != 0 || need != 0 {
		t.Errorf("after stream active=%d need=%d, want 0/0", active, need)
	}
	if bytesOut != int64(len("AUDIO")) {
		t.Errorf("bytes=%d, want %d", bytesOut, len("AUDIO"))
	}
}

func TestForegroundStats_BytesMonotonicAcrossStreams(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	var buf bytes.Buffer
	for i := 0; i < 3; i++ {
		if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, &buf); err != nil {
			t.Fatalf("Stream: %v", err)
		}
	}
	// Background bytes are not counted.
	bg := WithClass(context.Background(), Background)
	if err := m.Stream(bg, sess.ID, pipeline.KindAudio, &buf); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if _, n, _ := m.ForegroundStats(); n != 3*int64(len("AUDIO")) {
		t.Errorf("bytes=%d, want %d", n, 3*len("AUDIO"))
	}
}

func TestForegroundStats_UnwindsOnError(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	if err := m.Stream(context.Background(), sess.ID, pipeline.KindAudio, errWriter{}); err == nil {
		t.Fatal("expected error")
	}
	if active, _, need := m.ForegroundStats(); active != 0 || need != 0 {
		t.Fatalf("stats did not unwind after error: active=%d need=%d", active, need)
	}
}

func TestForegroundStats_VideoNeed(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: mvSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1", Video: true})
	bw := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- m.Stream(context.Background(), sess.ID, pipeline.KindVideo, bw) }()
	<-bw.entered
	if _, _, need := m.ForegroundStats(); need != defaultVideoNeedBps {
		t.Errorf("needBps=%d, want %d", need, defaultVideoNeedBps)
	}
	close(bw.release)
	<-done
}

// headerSink records SetHeader so we can check the counting wrapper keeps
// pipeline.HeaderWriter visible to sources.
type headerSink struct {
	bytes.Buffer
	hdr map[string]string
}

func (h *headerSink) SetHeader(k, v string) { h.hdr[k] = v }

func TestForegroundStream_PreservesHeaderWriter(t *testing.T) {
	t.Parallel()
	m := newManagerWith(&fakeProvider{sess: songSession()})
	sess, _ := m.Open(context.Background(), OpenRequest{AssetID: "1"})
	sink := &headerSink{hdr: map[string]string{}}
	w, end := m.beginStream(context.Background(), sess, pipeline.KindAudio, sink)
	defer end()
	hw, ok := w.(pipeline.HeaderWriter)
	if !ok {
		t.Fatal("counting wrapper hid pipeline.HeaderWriter")
	}
	hw.SetHeader("Content-Length", "5")
	if sink.hdr["Content-Length"] != "5" {
		t.Fatal("SetHeader not forwarded")
	}
}
