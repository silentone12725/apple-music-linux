package diskcache

// Decision test for the "stream the AAC cache instead of full pre-download"
// proposal. The claim in review was that an AAC cache MISS downloads the whole
// track before serving. This test checks whether the streaming primitive the
// proposal asks for ALREADY exists, so we don't build it twice.
//
// Run: go test ./core/diskcache/ -run Improvement -v

import (
	"bytes"
	"io"
	"testing"
	"time"
)

// ── #3 Streaming cache (serve-while-downloading) already implemented ──
//
// Proof obligation: a reader attached to an in-progress StreamingPutWriter must
// receive bytes BEFORE the writer commits. If it can, the "stream cache misses"
// improvement is already available and the remaining work is only to route the
// AAC miss path through BeginStreamingPut (a wiring change, not new machinery).
func TestImprovement03_StreamingCacheServesBeforeCommit(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("new cache: %v", err)
	}

	spw, err := c.BeginStreamingPut("asset-123", "aac")
	if err != nil || spw == nil {
		t.Fatalf("BeginStreamingPut: writer=%v err=%v", spw, err)
	}

	reader := spw.NewReader()
	defer reader.Close()

	firstByte := make(chan struct{})
	var out bytes.Buffer
	go func() {
		buf := make([]byte, 4)
		n, _ := reader.Read(buf) // blocks until the writer produces bytes
		if n > 0 {
			out.Write(buf[:n])
			close(firstByte)
		}
		io.Copy(&out, reader)
	}()

	// Write a first chunk but do NOT commit yet.
	if _, err := spw.Write([]byte("HEAD")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case <-firstByte:
		// Reader got data while the writer is still open and uncommitted.
	case <-time.After(2 * time.Second):
		t.Fatal("VERDICT: NOT available — reader blocked until commit; a real streaming cache is missing")
	}

	// Finish the track and commit.
	if _, err := spw.Write([]byte("TAIL")); err != nil {
		t.Fatalf("write tail: %v", err)
	}
	if err := spw.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	time.Sleep(50 * time.Millisecond) // let the reader drain to EOF

	if got := out.String(); got != "HEADTAIL" {
		t.Fatalf("VERDICT: BROKEN — streamed content %q != %q", got, "HEADTAIL")
	}
	t.Log("VERDICT: ALREADY IMPLEMENTED — BeginStreamingPut/NewReader serve bytes before Commit. " +
		"AAC 'stream the cache' is a wiring change (route the miss path through BeginStreamingPut), not new code.")
}
