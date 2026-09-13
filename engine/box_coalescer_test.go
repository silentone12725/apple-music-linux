package main

// Tests for the REAL boxCoalescer used by the MV video path (streamMediaCoalesced).
// Verifies fragment-aligned flushing: whole boxes only, nothing lost/reordered,
// one downstream write per box regardless of input chunking, 64-bit largesize,
// and remainder handling.
//
// Run: go test . -run BoxCoalescer -v

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// flushSpy records each Write it receives so we can assert per-box delivery.
type flushSpy struct {
	got    bytes.Buffer
	writes [][]byte
}

func (s *flushSpy) Write(p []byte) (int, error) {
	cp := append([]byte(nil), p...)
	s.writes = append(s.writes, cp)
	return s.got.Write(p)
}

func box32(typ string, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(b[:4], uint32(8+len(payload)))
	copy(b[4:8], typ)
	copy(b[8:], payload)
	return b
}

// box64 builds a box using the 64-bit largesize form (size field == 1).
func box64(typ string, payload []byte) []byte {
	b := make([]byte, 16+len(payload))
	binary.BigEndian.PutUint32(b[:4], 1) // largesize marker
	copy(b[4:8], typ)
	binary.BigEndian.PutUint64(b[8:16], uint64(16+len(payload)))
	copy(b[16:], payload)
	return b
}

func TestBoxCoalescer_WholeBoxesRegardlessOfChunking(t *testing.T) {
	boxes := [][]byte{
		box32("ftyp", []byte("iso5\x00\x00\x02\x00")),
		box32("moov", bytes.Repeat([]byte{0x11}, 200)),
		box32("moof", bytes.Repeat([]byte{0x22}, 300)),
		box32("mdat", bytes.Repeat([]byte{0x33}, 5000)),
		box32("moof", bytes.Repeat([]byte{0x44}, 300)),
		box32("mdat", bytes.Repeat([]byte{0x55}, 5000)),
	}
	stream := bytes.Join(boxes, nil)

	for _, chunk := range []int{1, 3, 7, 64, 4096, len(stream)} {
		spy := &flushSpy{}
		c := &boxCoalescer{w: spy}
		for off := 0; off < len(stream); off += chunk {
			end := off + chunk
			if end > len(stream) {
				end = len(stream)
			}
			if _, err := c.Write(stream[off:end]); err != nil {
				t.Fatalf("chunk=%d write: %v", chunk, err)
			}
		}
		if err := c.Flush(); err != nil {
			t.Fatalf("chunk=%d flush: %v", chunk, err)
		}
		// Nothing lost or reordered.
		if !bytes.Equal(spy.got.Bytes(), stream) {
			t.Fatalf("chunk=%d: output != input", chunk)
		}
		// Exactly one downstream write per box — the flush-coalescing guarantee.
		if len(spy.writes) != len(boxes) {
			t.Fatalf("chunk=%d: %d downstream writes, want %d (one per box)", chunk, len(spy.writes), len(boxes))
		}
		// Each downstream write is exactly one whole box (never partial → no stall).
		for i, wr := range spy.writes {
			if !bytes.Equal(wr, boxes[i]) {
				t.Fatalf("chunk=%d: write #%d is not whole box %d", chunk, i, i)
			}
		}
	}
	t.Log("VERDICT: boxCoalescer emits exactly one whole box per downstream write for any input chunking.")
}

func TestBoxCoalescer_Handles64BitLargesize(t *testing.T) {
	stream := bytes.Join([][]byte{
		box32("ftyp", []byte("iso5")),
		box64("mdat", bytes.Repeat([]byte{0xEE}, 1000)), // large-size form
	}, nil)

	spy := &flushSpy{}
	c := &boxCoalescer{w: spy}
	// Feed 5 bytes at a time to exercise the 16-byte largesize wait.
	for off := 0; off < len(stream); off += 5 {
		end := off + 5
		if end > len(stream) {
			end = len(stream)
		}
		c.Write(stream[off:end]) //nolint:errcheck
	}
	c.Flush() //nolint:errcheck

	if !bytes.Equal(spy.got.Bytes(), stream) {
		t.Fatal("64-bit largesize: output != input")
	}
	if len(spy.writes) != 2 {
		t.Fatalf("64-bit largesize: %d writes, want 2", len(spy.writes))
	}
	t.Log("VERDICT: 64-bit largesize boxes are measured and emitted whole.")
}

func TestBoxCoalescer_FlushEmitsTrailingRemainder(t *testing.T) {
	// A complete box followed by a truncated/partial box (as a mid-stream error
	// or a size==0 tail would leave). Flush must emit the remainder so nothing
	// is silently dropped.
	stream := append(box32("ftyp", []byte("iso5")), []byte("PARTIAL-TAIL")...)

	spy := &flushSpy{}
	c := &boxCoalescer{w: spy}
	c.Write(stream) //nolint:errcheck
	// Before flush: only the complete ftyp box has been emitted.
	if spy.got.Len() != len(box32("ftyp", []byte("iso5"))) {
		t.Fatalf("pre-flush emitted %d bytes, want just the ftyp box", spy.got.Len())
	}
	if err := c.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if !bytes.Equal(spy.got.Bytes(), stream) {
		t.Fatal("post-flush: trailing remainder not emitted")
	}
	t.Log("VERDICT: Flush() emits trailing partial-box bytes — no truncation on stream end/error.")
}
