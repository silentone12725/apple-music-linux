package main

// Decision test for Improvement #4: is it SAFE to coalesce HTTP flushes?
//
// firstByteWriter flushes on every Write (handlers_playback.go). Its own comment
// warns "Without this, the player (mpv, VLC) stalls between fragments waiting for
// more bytes." firstByteWriter is shared by the ALAC→VLC stream, so a NAIVE
// size/time batch could split a fragment and stall VLC — unsafe (CLAUDE.md
// forbids touching the lossless/VLC path).
//
// The safe question: can flushes be coalesced WITHOUT starving the player? Yes —
// only if flushes align to fMP4 fragment boundaries (flush once each complete
// moof+mdat, plus the init segment for startup). This test builds that candidate
// writer and proves the property deterministically. It does NOT wire it into
// prod — it answers "safe to implement, and how" before any handler change.
//
// Run: go test . -run Improvement04 -v

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// fragmentFlushWriter is the CANDIDATE coalescing strategy (proof-of-concept for
// the test only). It buffers bytes and flushes exactly at top-level box
// boundaries, so the player always receives whole fragments — never a partial
// moof/mdat that would make it stall. Everything is delivered; nothing is held
// past a complete box.
type fragmentFlushWriter struct {
	buf      bytes.Buffer
	out      *bytes.Buffer // what the "network" received
	flushes  int
	perFlush []int // bytes delivered by each flush (must each be whole boxes)
}

func (w *fragmentFlushWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	delivered := 0
	// Drain every complete top-level box currently buffered.
	for w.buf.Len() >= 8 {
		size := int(binary.BigEndian.Uint32(w.buf.Bytes()[:4]))
		if size < 8 || w.buf.Len() < size {
			break // header incomplete or box not fully buffered yet
		}
		box := make([]byte, size)
		w.buf.Read(box)
		w.out.Write(box)
		delivered += size
	}
	if delivered > 0 {
		w.flushes++
		w.perFlush = append(w.perFlush, delivered)
	}
	return len(p), nil
}

func mp4box(typ string, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(b[:4], uint32(8+len(payload)))
	copy(b[4:8], typ)
	copy(b[8:], payload)
	return b
}

func TestImprovement04_CoalescingIsSafeAtFragmentBoundaries(t *testing.T) {
	// A realistic init + two fragments.
	boxes := [][]byte{
		mp4box("ftyp", []byte("iso5\x00\x00\x02\x00")),
		mp4box("moof", bytes.Repeat([]byte{0xAA}, 300)),
		mp4box("mdat", bytes.Repeat([]byte{0xBB}, 5000)),
		mp4box("moof", bytes.Repeat([]byte{0xCC}, 300)),
		mp4box("mdat", bytes.Repeat([]byte{0xDD}, 5000)),
	}
	stream := bytes.Join(boxes, nil)

	// Deliver the stream in tiny 7-byte writes — the pathological fragmentation
	// FFmpeg's pipe output produces. A per-write flush would flush ~1600 times.
	perWriteFlushes := 0
	got := &fragmentFlushWriter{out: &bytes.Buffer{}}
	for off := 0; off < len(stream); off += 7 {
		end := off + 7
		if end > len(stream) {
			end = len(stream)
		}
		got.Write(stream[off:end])
		perWriteFlushes++ // count what a flush-every-write writer WOULD do
	}

	// 1) Nothing lost / reordered — the player gets the exact byte stream.
	if !bytes.Equal(got.out.Bytes(), stream) {
		t.Fatal("VERDICT: UNSAFE — coalesced output differs from input")
	}
	// 2) Every flush delivered whole boxes only (no partial fragment → no stall).
	//    Sum of per-flush sizes == total, and each flush is >= a full box header.
	total := 0
	for _, n := range got.perFlush {
		if n < 8 {
			t.Fatalf("VERDICT: UNSAFE — a flush delivered %d bytes (partial box)", n)
		}
		total += n
	}
	if total != len(stream) {
		t.Fatalf("VERDICT: UNSAFE — delivered %d of %d bytes", total, len(stream))
	}
	// 3) Flush count collapses to ~one per box, not one per write.
	if got.flushes != len(boxes) {
		t.Fatalf("expected %d flushes (one per box), got %d", len(boxes), got.flushes)
	}

	t.Logf("VERDICT #4: SAFE ONLY IF FRAGMENT-ALIGNED — %d flushes (one per box) vs %d per-write "+
		"flushes = %.0fx fewer, with every fragment delivered whole (VLC never sees a partial "+
		"moof/mdat). A naive size/time batch is UNSAFE — it can split a fragment and stall the "+
		"player. Implement as a box-boundary flusher, and only for the video/AAC path — do not "+
		"change the shared firstByteWriter used by ALAC→VLC.",
		got.flushes, perWriteFlushes, float64(perWriteFlushes)/float64(got.flushes))
}
