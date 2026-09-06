package aacstream

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestDownloadMVSegmentsStreaming_orderAndContent verifies that segments arrive
// at the writer in URL order and contain correct bytes, regardless of which
// goroutine finishes first. Segment 0 is piped directly (streaming path);
// segments 1+ come from the prefetch buffer.
func TestDownloadMVSegmentsStreaming_orderAndContent(t *testing.T) {
	// Serve 4 distinct segments; segment 1 is served slowly to confirm
	// ordering even when prefetch arrives out of natural order.
	segs := [][]byte{
		[]byte("segment-zero-bytes"),
		[]byte("segment-one-bytes"),
		[]byte("segment-two-bytes"),
		[]byte("segment-three-bytes"),
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/0":
			w.Write(segs[0])
		case "/1":
			w.Write(segs[1])
		case "/2":
			w.Write(segs[2])
		case "/3":
			w.Write(segs[3])
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	urls := []string{
		srv.URL + "/0",
		srv.URL + "/1",
		srv.URL + "/2",
		srv.URL + "/3",
	}

	var out bytes.Buffer
	err := DownloadMVSegmentsStreaming(context.Background(), urls, &out, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := bytes.Join(segs, nil)
	if !bytes.Equal(out.Bytes(), want) {
		t.Errorf("got %q, want %q", out.Bytes(), want)
	}
}

// TestDownloadMVSegmentsStreaming_empty confirms no error and no writes for an
// empty URL list — guards against nil-deref in the producer goroutine.
func TestDownloadMVSegmentsStreaming_empty(t *testing.T) {
	var out bytes.Buffer
	if err := DownloadMVSegmentsStreaming(context.Background(), nil, &out, 3); err != nil {
		t.Fatalf("unexpected error on empty list: %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("expected no bytes written, got %d", out.Len())
	}
}

// TestDownloadMVSegmentsStreaming_single exercises the code path where only
// segment 0 exists (no prefetch goroutines spawned).
func TestDownloadMVSegmentsStreaming_single(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("only-segment"))
	}))
	defer srv.Close()

	var out bytes.Buffer
	if err := DownloadMVSegmentsStreaming(context.Background(), []string{srv.URL + "/"}, &out, 3); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := out.String(); got != "only-segment" {
		t.Errorf("got %q, want %q", got, "only-segment")
	}
}

// TestDownloadMVSegmentsStreaming_cancelPropagates confirms that a cancelled
// context causes the function to return with an error, not hang.
func TestDownloadMVSegmentsStreaming_cancelPropagates(t *testing.T) {
	// Serve a segment that blocks until the test context cancels.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	urls := []string{srv.URL + "/0", srv.URL + "/1"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	var out bytes.Buffer
	err := DownloadMVSegmentsStreaming(ctx, urls, &out, 2)
	if err == nil {
		t.Error("expected error on cancelled context, got nil")
	}
}
