package aacstream

// Decision tests for the speculative MV/streaming improvements raised in review.
// Each test answers ONE proposal with a deterministic pass/fail + a VERDICT log
// line, so we can decide what is worth implementing instead of guessing.
//
// Run: go test ./utils/aacstream/ -run Improvement -v
//      go test ./utils/aacstream/ -run Improvement -bench Improvement -v

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// ── #1 Stream segment 0 immediately (already wired via DownloadMVSegmentsStreaming) ──
//
// Proposal: emit segment 0's bytes as they arrive rather than after full
// segments download. Proof obligation: seg0 must reach the writer WHILE seg1 is
// still downloading. We gate seg1's HTTP handler on seg0 having been written; if
// the implementation buffered everything before writing, seg1 would never
// release and the test would deadlock (caught by the timeout).
func TestImprovement01_StreamsSeg0BeforeLaterSegmentsFinish(t *testing.T) {
	seg0Delivered := make(chan struct{})
	var once sync.Once

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/0":
			w.Write([]byte("SEG0"))
		case "/1":
			// Block until seg0 has been handed to the sink. A non-streaming
			// implementation (download-all-then-write) never reaches that point
			// before requesting seg1, so this would hang → deadlock → fail.
			select {
			case <-seg0Delivered:
				w.Write([]byte("SEG1"))
			case <-time.After(3 * time.Second):
				http.Error(w, "seg0 not streamed first", http.StatusInternalServerError)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// Sink that fires seg0Delivered the moment seg0's bytes arrive.
	sink := writerFunc(func(p []byte) (int, error) {
		if bytes.Contains(p, []byte("SEG0")) {
			once.Do(func() { close(seg0Delivered) })
		}
		return len(p), nil
	})

	urls := []string{srv.URL + "/0", srv.URL + "/1"}
	done := make(chan error, 1)
	go func() { done <- DownloadMVSegmentsStreaming(context.Background(), urls, sink, 2) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("streaming download failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("VERDICT: NOT streaming — seg0 was not delivered before seg1 finished (deadlock)")
	}
	t.Log("VERDICT: IMPLEMENTED — seg0 streams to the sink before later segments complete. Keep it; delete DownloadMVSegmentsParallel.")
}

// ── #5 Arbitrary HTTP/pipe chunk boundaries are safe for a length-prefixed fMP4 ──
//
// Proposal (feasibility of native <video src> forward playback): a length-
// prefixed box stream (ftyp/moof/mdat …) reassembles identically no matter where
// the reads split. If true, Chromium/FFmpeg consuming an arbitrarily-chunked
// byte stream is sound and the JS "never drop a chunk" rule is the only
// requirement. We prove the principle with a minimal box splitter over every
// chunk size from 1 byte upward.
func TestImprovement05_ArbitraryChunkBoundariesReassemble(t *testing.T) {
	whole := bytes.Join([][]byte{
		box("ftyp", []byte("iso5\x00\x00\x02\x00")),
		box("moof", bytes.Repeat([]byte{0xAB}, 40)),
		box("mdat", bytes.Repeat([]byte{0xCD}, 500)),
		box("moof", bytes.Repeat([]byte{0xEF}, 40)),
		box("mdat", bytes.Repeat([]byte{0x12}, 733)),
	}, nil)

	ref := splitBoxes(t, bytes.NewReader(whole)) // single-shot baseline

	for _, chunk := range []int{1, 2, 3, 7, 13, 64, 257, 1024} {
		got := splitBoxes(t, &chunkedReader{data: whole, chunk: chunk})
		if len(got) != len(ref) {
			t.Fatalf("chunk=%d: got %d boxes, want %d", chunk, len(got), len(ref))
		}
		for i := range ref {
			if ref[i].typ != got[i].typ || !bytes.Equal(ref[i].payload, got[i].payload) {
				t.Fatalf("VERDICT: UNSAFE — chunk=%d box#%d differs (%s vs %s)", chunk, i, ref[i].typ, got[i].typ)
			}
		}
	}
	t.Log("VERDICT: SAFE — length-prefixed fMP4 reassembles across any read boundary. Native <video src> forward playback is viable; only chunk-dropping breaks it.")
}

// ── #6 A time→byte-offset seek index is buildable from the remuxed stream ──
//
// Proposal: index moof presentation-time → output byte offset so seeks can start
// at a fragment boundary (instead of restarting FFmpeg with ?t=). Proof: every
// top-level moof box is locatable with its byte offset by scanning the stream.
// (Time extraction additionally needs traf>tfdt parsing — noted below.)
func TestImprovement06_MoofByteOffsetIndexBuildable(t *testing.T) {
	frags := [][]byte{
		box("ftyp", []byte("iso5\x00\x00\x02\x00")),
		box("moof", bytes.Repeat([]byte{0x01}, 32)),
		box("mdat", bytes.Repeat([]byte{0x02}, 200)),
		box("moof", bytes.Repeat([]byte{0x03}, 32)),
		box("mdat", bytes.Repeat([]byte{0x04}, 200)),
		box("moof", bytes.Repeat([]byte{0x05}, 32)),
		box("mdat", bytes.Repeat([]byte{0x06}, 200)),
	}
	stream := bytes.Join(frags, nil)

	var moofOffsets []int64
	var off int64
	r := bytes.NewReader(stream)
	for {
		size, typ, ok := readBoxHeader(r)
		if !ok {
			break
		}
		if typ == "moof" {
			moofOffsets = append(moofOffsets, off)
		}
		off += int64(size)
		r.Seek(off, io.SeekStart)
	}
	if len(moofOffsets) != 3 {
		t.Fatalf("VERDICT: NOT feasible — found %d moof offsets, want 3", len(moofOffsets))
	}
	// Offsets must be strictly increasing and land on real box starts.
	for i := 1; i < len(moofOffsets); i++ {
		if moofOffsets[i] <= moofOffsets[i-1] {
			t.Fatalf("VERDICT: NOT feasible — non-monotonic offsets %v", moofOffsets)
		}
	}
	t.Logf("VERDICT: FEASIBLE — moof byte offsets %v recovered by a forward scan. "+
		"An engine-side time→offset index is buildable; time values still require traf>tfdt parsing.", moofOffsets)
}

// ── #7 Per-fragment debug logging overhead ──
//
// Proposal: remove/sample the per-fragment log.Printf calls in the decrypt loop.
// This quantifies their cost so the decision is data-driven, not vibes.
func BenchmarkImprovement07_PerFragmentLogging(b *testing.B) {
	silent := log.New(io.Discard, "", 0)
	b.Run("with-logging", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			silent.Printf("[INTERCEPT] FRAG#%d hasSenc=%t samples=%d mdat=%dB origTfdt=%d shifted=%d",
				i, true, 70, 207434, 477888, 0)
		}
	})
	b.Run("no-logging", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = i
		}
	})
	b.Log("VERDICT: compare ns/op. A 4-min MV has ~55 video + ~44 audio fragments; " +
		"per-play logging cost = ns/op × ~100. Sampling helps only if that product is material.")
}

// ── helpers ──────────────────────────────────────────────────────────────────

type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// chunkedReader yields at most `chunk` bytes per Read to simulate arbitrary
// network/pipe fragmentation.
type chunkedReader struct {
	data  []byte
	pos   int
	chunk int
}

func (c *chunkedReader) Read(p []byte) (int, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	n := c.chunk
	if n > len(p) {
		n = len(p)
	}
	if c.pos+n > len(c.data) {
		n = len(c.data) - c.pos
	}
	copy(p, c.data[c.pos:c.pos+n])
	c.pos += n
	return n, nil
}

type parsedBox struct {
	typ     string
	payload []byte
}

// box builds a 32-bit-size MP4 box: [size:4][type:4][payload].
func box(typ string, payload []byte) []byte {
	size := 8 + len(payload)
	b := make([]byte, size)
	binary.BigEndian.PutUint32(b[0:4], uint32(size))
	copy(b[4:8], typ)
	copy(b[8:], payload)
	return b
}

// splitBoxes reads length-prefixed boxes from r until EOF. It is deliberately a
// tiny independent reassembler so the test proves the property, not the prod code.
func splitBoxes(t *testing.T, r io.Reader) []parsedBox {
	t.Helper()
	var out []parsedBox
	head := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, head); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("read header: %v", err)
		}
		size := binary.BigEndian.Uint32(head[0:4])
		typ := string(head[4:8])
		payload := make([]byte, int(size)-8)
		if _, err := io.ReadFull(r, payload); err != nil {
			t.Fatalf("read payload (%s): %v", typ, err)
		}
		out = append(out, parsedBox{typ: typ, payload: payload})
	}
	return out
}

// readBoxHeader reads a box header and returns (size, type, ok). Used by the
// offset-index feasibility test which seeks rather than reads payloads.
func readBoxHeader(r io.ReadSeeker) (uint32, string, bool) {
	head := make([]byte, 8)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, "", false
	}
	return binary.BigEndian.Uint32(head[0:4]), string(head[4:8]), true
}
