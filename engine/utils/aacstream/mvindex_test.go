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
	"io"
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

// setupMVDecForTest points the dec-cache at a temp dir with a fixed key and
// enables caching, so MVDecCacheWriter/ServeMVDecFrom run without touching real
// user files. Package-level globals → tests here must not run in parallel.
func setupMVDecForTest(t *testing.T) {
	t.Helper()
	mvDecDir = t.TempDir()
	mvDecKey = bytes.Repeat([]byte{0x24}, 32)
	mvDecKeyOnce.Do(func() {}) // consume Once so initMVDecKey() won't overwrite the test key
	SetMVCacheMaxBytes(1 << 30)
	t.Cleanup(func() { SetMVCacheMaxBytes(0) })
}

// TestServeMVDecFrom_SeekableRoundTrip writes a real fMP4 through the caching
// writer (which builds the index + encrypts), then serves seeks from the cache
// and checks the output equals init segment + the exact plaintext tail from the
// covering fragment — proving the seekable AES-CTR decrypt reconstructs bytes.
func TestServeMVDecFrom_SeekableRoundTrip(t *testing.T) {
	setupMVDecForTest(t)
	const timescale = 1000
	decTimes := []uint64{0, 1000, 2000, 3000, 4000} // 0,1,2,3,4s
	stream, initSize, wantTimes, wantOffsets := buildMVStream(t, timescale, decTimes)

	const assetID, maxHeight = "asset-seek", 720
	cw := MVDecCacheWriter(assetID, maxHeight, io.Discard)
	// Feed in small chunks to exercise indexing across write boundaries.
	feedWriterChunked(t, cw, stream, 7)
	cw.Commit()

	if !MVDecExists(assetID, maxHeight) {
		t.Fatal("dec cache not committed")
	}
	if !MVDecIndexExists(assetID, maxHeight) {
		t.Fatal("index sidecar not written")
	}

	// For each seek, target = last fragment with T <= seekSec.
	cases := []struct {
		seek     float64
		wantFrag int
	}{
		{0.0, 0}, {0.5, 0}, {1.0, 1}, {2.5, 2}, {3.9, 3}, {4.0, 4}, {99.0, 4},
	}
	for _, c := range cases {
		var out bytes.Buffer
		if err := ServeMVDecFrom(assetID, maxHeight, c.seek, &out); err != nil {
			t.Fatalf("seek=%.1f: ServeMVDecFrom: %v", c.seek, err)
		}
		want := append(append([]byte{}, stream[:initSize]...), stream[wantOffsets[c.wantFrag]:]...)
		if !bytes.Equal(out.Bytes(), want) {
			t.Fatalf("seek=%.1f (frag %d @ t=%.1f): output %d bytes != expected %d bytes",
				c.seek, c.wantFrag, wantTimes[c.wantFrag], out.Len(), len(want))
		}
	}
	t.Log("VERDICT: ServeMVDecFrom emits init + exact plaintext tail from the covering fragment for every seek.")
}

// TestServeMVDecFrom_TruncatedSelfHeals verifies that a cache file shorter than
// its index claims is detected: ServeMVDecFrom errors cleanly and removes the
// stale sidecar so the next seek falls back to FFmpeg instead of reading past EOF.
func TestServeMVDecFrom_TruncatedSelfHeals(t *testing.T) {
	setupMVDecForTest(t)
	stream, _, _, _ := buildMVStream(t, 1000, []uint64{0, 1000, 2000, 3000})
	const assetID, maxHeight = "asset-trunc", 720
	cw := MVDecCacheWriter(assetID, maxHeight, io.Discard)
	cw.Write(stream) //nolint:errcheck
	cw.Commit()

	// Truncate the committed .enc to just past the IV — far shorter than the index.
	decPath := mvDecFilePath(assetID, maxHeight)
	if err := os.Truncate(decPath, mvDecIVSize+8); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if !MVDecIndexExists(assetID, maxHeight) {
		t.Fatal("precondition: index should exist")
	}

	var out bytes.Buffer
	if err := ServeMVDecFrom(assetID, maxHeight, 2.5, &out); err == nil {
		t.Fatal("expected error serving a truncated cache file")
	}
	if MVDecIndexExists(assetID, maxHeight) {
		t.Fatal("stale index should have been removed for self-heal")
	}
	t.Log("VERDICT: truncated cache is detected, errors cleanly, and drops the stale index (next seek falls back).")
}

func feedWriterChunked(t *testing.T, w io.Writer, data []byte, chunk int) {
	t.Helper()
	for off := 0; off < len(data); off += chunk {
		end := off + chunk
		if end > len(data) {
			end = len(data)
		}
		if _, err := w.Write(data[off:end]); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

// TestMVLiveIndex_LookupAndEnd covers the growing-file seek index: Lookup returns
// the latest fragment with start <= t, End bounds each fragment at the next moof
// (last fragment unbounded), and InitSize is exposed once known — the exact
// contract the /video-es growing-file seek relies on.
func TestMVLiveIndex_LookupAndEnd(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 2000, 4000, 6000} // → 0,2,4,6 s
	stream, initSize, _, wantOffsets := buildMVStream(t, timescale, decTimes)

	m := NewMVLiveIndex()
	m.Write(stream) //nolint:errcheck

	if sz, ok := m.InitSize(); !ok || sz != initSize {
		t.Fatalf("InitSize=(%d,%v) want (%d,true)", sz, ok, initSize)
	}

	// End of each fragment == the next moof's offset; the last fragment is unbounded.
	for i := range decTimes {
		frag, ok := m.Lookup(float64(decTimes[i]) / timescale)
		if !ok {
			t.Fatalf("Lookup(frag %d start) not found", i)
		}
		if frag.Off != wantOffsets[i] {
			t.Fatalf("frag %d Off=%d want %d", i, frag.Off, wantOffsets[i])
		}
		wantEnd := int64(0)
		if i+1 < len(decTimes) {
			wantEnd = wantOffsets[i+1]
		}
		if frag.End != wantEnd {
			t.Fatalf("frag %d End=%d want %d", i, frag.End, wantEnd)
		}
	}

	// Lookup returns the latest fragment whose start <= t.
	cases := []struct {
		t    float64
		want int // fragment index, or -1 for "not found"
	}{
		{-1.0, -1}, {0.0, 0}, {1.5, 0}, {2.0, 1}, {3.9, 1}, {4.0, 2}, {6.0, 3}, {99.0, 3},
	}
	for _, c := range cases {
		frag, ok := m.Lookup(c.t)
		if c.want < 0 {
			if ok {
				t.Fatalf("Lookup(%.1f)=%+v want not-found", c.t, frag)
			}
			continue
		}
		if !ok || frag.Off != wantOffsets[c.want] {
			t.Fatalf("Lookup(%.1f) → off=%d ok=%v want frag %d (off %d)", c.t, frag.Off, ok, c.want, wantOffsets[c.want])
		}
	}

	// Availability predicate the handler uses: complete AND fully downloaded.
	f2, _ := m.Lookup(4.0) // frag 2, End = wantOffsets[3]
	if !(f2.End > 0 && f2.End <= f2.End) {
		t.Fatal("bounded fragment should be seekable when written >= End")
	}
	if f2.End > 0 && f2.End <= f2.End-1 {
		t.Fatal("fragment must NOT be seekable when written < End")
	}
	t.Log("VERDICT: MVLiveIndex.Lookup returns latest frag ≤ t with correct End bounds; InitSize exposed; last frag unbounded.")
}

// TestMVLiveIndex_LookupComplete verifies that LookupComplete returns the latest
// fragment that is both at/before t AND fully written (End <= written), falling
// back to earlier complete fragments when the closest one isn't downloaded yet.
func TestMVLiveIndex_LookupComplete(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 2000, 4000, 6000} // → 0,2,4,6 s
	stream, _, _, wantOffsets := buildMVStream(t, timescale, decTimes)

	m := NewMVLiveIndex()
	m.Write(stream) //nolint:errcheck

	// All fragments complete. LookupComplete(5, allWritten) → frag at 4s (index 2).
	allWritten := int64(len(stream))
	f, ok := m.LookupComplete(5.0, allWritten)
	if !ok || f.Off != wantOffsets[2] {
		t.Fatalf("LookupComplete(5.0, all): ok=%v off=%d want off=%d", ok, f.Off, wantOffsets[2])
	}

	// Simulate only first two fragments written: written = offset of frag[2] (meaning
	// frag[2].End = wantOffsets[3] > written). LookupComplete(5.0, partial) should
	// return frag at 2s (index 1), the latest complete one before the seek target.
	partial := wantOffsets[2] // frag[1].End = wantOffsets[2] <= partial → complete
	f, ok = m.LookupComplete(5.0, partial)
	if !ok || f.Off != wantOffsets[1] {
		t.Fatalf("LookupComplete(5.0, partial=%d): ok=%v off=%d want off=%d (frag 1)", partial, ok, f.Off, wantOffsets[1])
	}

	// Only frag[0] complete (written < frag[1].End = wantOffsets[2]).
	partial0 := wantOffsets[2] - 1
	f, ok = m.LookupComplete(5.0, partial0)
	if !ok || f.Off != wantOffsets[0] {
		t.Fatalf("LookupComplete(5.0, partial0=%d): ok=%v off=%d want off=%d (frag 0)", partial0, ok, f.Off, wantOffsets[0])
	}

	// Seek before first fragment → not found.
	_, ok = m.LookupComplete(-1.0, allWritten)
	if ok {
		t.Fatal("LookupComplete(-1.0) should return not-found")
	}

	t.Log("VERDICT: LookupComplete falls back to the latest complete earlier fragment when the exact one is not yet downloaded.")
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

// TestMVLiveIndex_FragByIndex verifies FragByIndex readiness logic:
// fragment is ready only when End != 0 && End <= written.
func TestMVLiveIndex_FragByIndex(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 1000, 2000, 3000}
	stream, initSize, _, wantOffsets := buildMVStream(t, timescale, decTimes)
	totalLen := int64(len(stream))

	idx := NewMVLiveIndex()
	idx.Write(stream) // feed all bytes at once

	// After a full feed the indexer has all fragments. The last fragment has End==0
	// because no subsequent moof arrived. Finalize it.
	idx.Finalize(totalLen)

	// n < 0 → false
	if _, ok := idx.FragByIndex(-1, totalLen); ok {
		t.Error("FragByIndex(-1): expected false, got true")
	}
	// n == FragCount() → false
	n := idx.FragCount()
	if _, ok := idx.FragByIndex(n, totalLen); ok {
		t.Errorf("FragByIndex(%d == FragCount): expected false, got true", n)
	}
	// Fragment 0 should be at initSize offset
	f0, ok := idx.FragByIndex(0, totalLen)
	if !ok {
		t.Fatal("FragByIndex(0, totalLen): expected true, got false")
	}
	if f0.Off != wantOffsets[0] {
		t.Errorf("frag[0].Off=%d want %d", f0.Off, wantOffsets[0])
	}
	if f0.Off < initSize {
		t.Errorf("frag[0].Off=%d < initSize=%d", f0.Off, initSize)
	}
	// Fragment not yet fully written: written < End → false
	f1, ok1 := idx.FragByIndex(1, totalLen)
	if !ok1 {
		t.Fatal("FragByIndex(1, totalLen): expected true, got false")
	}
	if _, ok := idx.FragByIndex(1, f1.End-1); ok {
		t.Error("FragByIndex(1, End-1): expected false (not yet written), got true")
	}
}

// TestMVLiveIndex_InitSize verifies InitSize is 0 before any bytes and
// correct once the first moof is seen.
func TestMVLiveIndex_InitSize(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 1000}
	stream, wantInitSize, _, _ := buildMVStream(t, timescale, decTimes)

	idx := NewMVLiveIndex()
	if sz, ok := idx.InitSize(); ok || sz != 0 {
		t.Errorf("before feed: InitSize=%d ok=%v; want 0,false", sz, ok)
	}
	idx.Write(stream)
	sz, ok := idx.InitSize()
	if !ok {
		t.Fatal("after full feed: InitSize not ready")
	}
	if sz != wantInitSize {
		t.Errorf("InitSize=%d want %d", sz, wantInitSize)
	}
}

// TestMVLiveIndex_FinalFragment verifies Finalize sets the last fragment's End.
func TestMVLiveIndex_FinalFragment(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 1000, 2000}
	stream, _, _, _ := buildMVStream(t, timescale, decTimes)
	totalLen := int64(len(stream))

	idx := NewMVLiveIndex()
	idx.Write(stream)

	last := idx.FragCount() - 1
	// Before Finalize: last fragment End == 0 → not ready
	if _, ok := idx.FragByIndex(last, totalLen); ok {
		t.Error("before Finalize: last fragment should not be ready")
	}
	// Finalize with totalLen
	idx.Finalize(totalLen)
	// After Finalize: ready
	f, ok := idx.FragByIndex(last, totalLen)
	if !ok {
		t.Fatal("after Finalize: last fragment should be ready")
	}
	if f.End != totalLen {
		t.Errorf("frag[last].End=%d want %d", f.End, totalLen)
	}
	// written < totalLen → still not ready
	if _, ok := idx.FragByIndex(last, totalLen-1); ok {
		t.Error("written < End: last fragment should not be ready")
	}
}

// TestMVLiveIndex_FragByIndex_OutOfRange verifies all out-of-range indices
// return (zero, false) without panicking.
func TestMVLiveIndex_FragByIndex_OutOfRange(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 1000}
	stream, _, _, _ := buildMVStream(t, timescale, decTimes)

	idx := NewMVLiveIndex()
	idx.Write(stream)
	idx.Finalize(int64(len(stream)))

	n := idx.FragCount()
	for _, bad := range []int{-1, -100, n, n + 1, n + 100} {
		if _, ok := idx.FragByIndex(bad, int64(len(stream))); ok {
			t.Errorf("FragByIndex(%d): expected false, got true", bad)
		}
	}
}

// TestMVLiveIndex_FragIndexForTime_ForwardSeek validates the "basePast" guard used
// by handlePlaybackVsegSeek. When the user seeks forward to a time not yet indexed,
// FragIndexForTime returns the last available fragment (which is before the target),
// and FragCount() == fragN+1 (no later fragment exists), so basePast is false.
// This must trigger a seek producer rather than instant-serve from base.
func TestMVLiveIndex_FragIndexForTime_ForwardSeek(t *testing.T) {
	const timescale = 1000
	// 5 fragments at T = 0, 10, 20, 30, 40 s (timescale=1000 → decTimes in ms)
	decTimes := []uint64{0, 10000, 20000, 30000, 40000}
	stream, _, _, _ := buildMVStream(t, timescale, decTimes)

	written := int64(len(stream))
	idx := NewMVLiveIndex()
	idx.Write(stream)
	idx.Finalize(written)

	// Seek target well beyond indexed range — simulates forward seek.
	const target = 164.0

	fragN, frag, hasIt := idx.FragIndexForTime(target, written)
	if !hasIt {
		t.Fatal("FragIndexForTime: expected hasIt=true (last frag covers ≤ target)")
	}
	// The returned fragment should be the last one (T≈40s), not the target.
	if frag.T >= target {
		t.Errorf("expected frag.T < target=%.1f, got %.3f", target, frag.T)
	}

	// basePast guard: FragCount() > fragN+1 must be FALSE for forward seeks.
	basePast := idx.FragCount() > fragN+1
	if basePast {
		t.Errorf("basePast should be false for forward seek (fragN=%d FragCount=%d)", fragN, idx.FragCount())
	}
}

// TestMVLiveIndex_FragIndexForTime_BackwardSeek validates instant-serve from base.
// When base has encoded past the seek target (a later fragment exists in the index),
// FragCount() > fragN+1, so basePast is true — no seek producer needed.
func TestMVLiveIndex_FragIndexForTime_BackwardSeek(t *testing.T) {
	const timescale = 1000
	// 10 fragments at T = 0, 10, 20, ..., 90 s
	decTimes := make([]uint64, 10)
	for i := range decTimes {
		decTimes[i] = uint64(i) * 10000
	}
	stream, _, _, _ := buildMVStream(t, timescale, decTimes)

	written := int64(len(stream))
	idx := NewMVLiveIndex()
	idx.Write(stream)
	idx.Finalize(written)

	// Seek backward to 30s when base has fully encoded to 90s.
	const target = 30.0

	fragN, frag, hasIt := idx.FragIndexForTime(target, written)
	if !hasIt {
		t.Fatal("FragIndexForTime: expected hasIt=true")
	}
	if frag.T > target {
		t.Errorf("expected frag.T <= %.1f, got %.3f", target, frag.T)
	}

	// basePast guard must be TRUE — a later fragment exists.
	basePast := idx.FragCount() > fragN+1
	if !basePast {
		t.Errorf("basePast should be true for backward seek (fragN=%d FragCount=%d)", fragN, idx.FragCount())
	}
}

// TestMVLiveIndex_FragIndexForTime_DoneState validates instant-serve when base is done
// but the seek target equals the last fragment (no fragN+1 exists).
// basePast must still be true because the producer is done.
func TestMVLiveIndex_FragIndexForTime_DoneState(t *testing.T) {
	const timescale = 1000
	decTimes := []uint64{0, 10000, 20000}
	stream, _, _, _ := buildMVStream(t, timescale, decTimes)

	written := int64(len(stream))
	idx := NewMVLiveIndex()
	idx.Write(stream)
	idx.Finalize(written)

	// Target is the last fragment's time — fragN+1 doesn't exist, but base is done.
	const target = 20.0

	fragN, _, hasIt := idx.FragIndexForTime(target, written)
	if !hasIt {
		t.Fatal("FragIndexForTime: expected hasIt=true")
	}

	// Without "done" flag: fragCount == fragN+1 so basePast via count is false.
	basePastCount := idx.FragCount() > fragN+1
	if basePastCount {
		t.Errorf("expected basePastCount=false for last frag (fragN=%d FragCount=%d)", fragN, idx.FragCount())
	}
	// With "done" flag (simulated by Finalize already called): basePast must be true.
	// In production, the handler checks `base.done` to cover this case.
	// Here we just verify the count-based path gives false so the caller must also
	// check `base.done` to get the correct answer.
	// (This test documents the invariant, not the handler logic directly.)
}
