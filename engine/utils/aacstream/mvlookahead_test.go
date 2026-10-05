package aacstream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// gateWriter blocks the first write of the first media segment until release is closed,
// standing in for a segment that is still draining.
type gateWriter struct {
	once    sync.Once
	blocked chan struct{} // closed when the writer is parked
	release chan struct{}
	n       int
}

func (g *gateWriter) Write(p []byte) (int, error) {
	g.n += len(p)
	if g.n > 100 { // past the 8-byte init segment: this is media
		g.once.Do(func() { close(g.blocked); <-g.release })
	}
	return len(p), nil
}

// While segment 1 is still draining, segment 2's request must already be open, so the
// boundary between them does not leave the link idle for a request round-trip.
func TestDownloadMVSegmentsStreaming_NextSegmentRequestedWhileDraining(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]bool{}
	seg2 := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		first := !seen[r.URL.Path]
		seen[r.URL.Path] = true
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/s2") && first {
			close(seg2)
		}
		size := 8
		if !strings.HasSuffix(r.URL.Path, "/s0") {
			size = 4096
		}
		w.Write(make([]byte, size))
	}))
	defer srv.Close()

	urls := make([]string, 4)
	for i := range urls {
		urls[i] = fmt.Sprintf("%s/s%d", srv.URL, i)
	}
	gw := &gateWriter{blocked: make(chan struct{}), release: make(chan struct{})}
	errc := make(chan error, 1)
	go func() { errc <- DownloadMVSegmentsStreaming(context.Background(), urls, gw, 5) }()

	select {
	case <-gw.blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("segment 1 never started draining")
	}
	select {
	case <-seg2:
	case <-time.After(2 * time.Second):
		t.Fatal("segment 2 was not requested while segment 1 was still draining")
	}
	close(gw.release)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}
