package aacstream

// Tests for the MV dec-cache fragment indexer (#6, write side). Builds a real
// fMP4 (ftyp+moov + N moof/mdat fragments) with mp4ff so decode is guaranteed to
// round-trip, then feeds it to the inline indexer in many chunk sizes to prove:
//   - offsets/times are correct
//   - the result is invariant to how the byte stream is chunked (the hard part)
//   - malformed input disables the indexer instead of breaking anything
//   - finish() writes a JSON sidecar that reads back.
//
// Run: go test ./utils/aacstream/ -run MVDecIndex -v

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

// buildMVStream returns a remux-shaped fMP4 (ftyp+moov, then moof+mdat per
// fragment) plus the expected init size and per-fragment (time, moofOffset).
func buildMVStream(t *testing.T, timescale uint32, decTimes []uint64) (stream []byte, initSize int64, wantTimes []float64, wantOffsets []int64) {
	t.Helper()
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(timescale, "video", "und")
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		t.Fatalf("init encode: %v", err)
	}
	initSize = int64(buf.Len())

	for i, dt := range decTimes {
		frag, err := mp4.CreateFragment(uint32(i+1), 1)
		if err != nil {
			t.Fatalf("create fragment: %v", err)
		}
		frag.AddFullSample(mp4.FullSample{
			Sample:     mp4.Sample{Flags: 0, Dur: 1000, Size: 6},
			DecodeTime: dt,
			Data:       []byte{0, 1, 2, 3, 4, 5},
		})
		wantOffsets = append(wantOffsets, int64(buf.Len())) // moof is the first box of the fragment
		wantTimes = append(wantTimes, float64(dt)/float64(timescale))
		if err := frag.Encode(&buf); err != nil {
			t.Fatalf("frag encode: %v", err)
		}
	}
	return buf.Bytes(), initSize, wantTimes, wantOffsets
}

func feedChunked(ix *mvDecIndexer, data []byte, chunk int) {
	for off := 0; off < len(data); off += chunk {
		end := off + chunk
		if end > len(data) {
			end = len(data)
		}
		ix.feed(data[off:end])
	}
}

func TestMVDecIndex_CorrectAndChunkInvariant(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 1000, 2000, 3000, 4000} // → 0,1,2,3,4 seconds
	stream, initSize, wantTimes, wantOffsets := buildMVStream(t, timescale, decTimes)

	for _, chunk := range []int{1, 2, 3, 7, 64, 1024, len(stream)} {
		ix := newMVDecIndexer()
		feedChunked(ix, stream, chunk)

		if ix.disabled {
			t.Fatalf("chunk=%d: indexer disabled on valid input", chunk)
		}
		if ix.timescale != timescale {
			t.Fatalf("chunk=%d: timescale=%d want %d", chunk, ix.timescale, timescale)
		}
		if ix.initSize != initSize {
			t.Fatalf("chunk=%d: initSize=%d want %d", chunk, ix.initSize, initSize)
		}
		if len(ix.frags) != len(decTimes) {
			t.Fatalf("chunk=%d: %d frags want %d", chunk, len(ix.frags), len(decTimes))
		}
		for i, f := range ix.frags {
			if f.Off != wantOffsets[i] {
				t.Fatalf("chunk=%d frag#%d: off=%d want %d", chunk, i, f.Off, wantOffsets[i])
			}
			if f.T != wantTimes[i] {
				t.Fatalf("chunk=%d frag#%d: t=%v want %v", chunk, i, f.T, wantTimes[i])
			}
		}
	}
	t.Log("VERDICT: indexer produces correct init size, timescale, and per-fragment time/offset for any chunking.")
}

func TestMVDecIndex_MalformedDisables(t *testing.T) {
	ix := newMVDecIndexer()
	// A plausible header claiming an absurd box size → must disable, not panic.
	bad := []byte{0x7f, 0xff, 0xff, 0xff, 'm', 'o', 'o', 'f', 0, 0, 0, 0}
	ix.feed(bad)
	if !ix.disabled {
		t.Fatal("expected indexer to disable on absurd box size")
	}
	// finish() must write nothing when disabled.
	dir := t.TempDir()
	ix.finish(filepath.Join(dir, "x.enc"))
	if _, err := os.Stat(filepath.Join(dir, "x.enc.idx")); !os.IsNotExist(err) {
		t.Fatal("disabled indexer must not write a sidecar")
	}
	t.Log("VERDICT: malformed input disables the indexer and writes no index (seek falls back to FFmpeg).")
}

func TestMVDecIndex_FinishRoundTrips(t *testing.T) {
	stream, _, _, _ := buildMVStream(t, 1000, []uint64{0, 1000})
	ix := newMVDecIndexer()
	ix.feed(stream)

	dir := t.TempDir()
	dec := filepath.Join(dir, "asset-720.enc")
	ix.finish(dec)

	data, err := os.ReadFile(dec + ".idx")
	if err != nil {
		t.Fatalf("index sidecar not written: %v", err)
	}
	var idx MVDecIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		t.Fatalf("index JSON invalid: %v", err)
	}
	if idx.Timescale != 1000 || len(idx.Frags) != 2 {
		t.Fatalf("round-trip mismatch: timescale=%d frags=%d", idx.Timescale, len(idx.Frags))
	}
	t.Log("VERDICT: finish() writes a valid JSON sidecar that reads back.")
}
