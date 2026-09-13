package diskcache

// Decision benchmark for Improvement #3: should the AAC cache-MISS path stream
// while downloading (BeginStreamingPut) instead of download-then-serve
// (BeginPut → ServeContent)?
//
// The current AAC path (handlers_playback.go) fills a BeginPut writer with the
// FULL decrypted fMP4, commits, then serves via http.ServeContent — so the
// client's first byte arrives only AFTER the whole track has downloaded. The
// author's stated reasoning: "AAC files are small enough that the download
// overhead is not noticeable." This measures whether that holds.
//
// It compares time-to-first-byte for both real cache primitives against a
// simulated segmented download (fixed per-segment delay), at 4-min and 10-min
// track sizes. Timing is relative (streaming vs full-download under the SAME
// simulated network), so the structural delta is deterministic even though
// absolute ms vary by machine.
//
// Run: go test ./core/diskcache/ -run AAC_TTFB -v

import (
	"io"
	"testing"
	"time"
)

// segmentedFiller writes `segments` chunks of `segBytes` into w, sleeping
// `perSeg` before each — a stand-in for pm.Stream pulling HLS segments off the
// CDN and decrypting them into the cache writer.
func segmentedFiller(w io.Writer, segments int, segBytes int, perSeg time.Duration) {
	chunk := make([]byte, segBytes)
	for i := 0; i < segments; i++ {
		time.Sleep(perSeg)
		w.Write(chunk) //nolint:errcheck
	}
}

type aacTrack struct {
	name     string
	segments int
}

func TestAAC_TTFB_StreamingVsFullDownload(t *testing.T) {
	// Apple AAC HLS ≈ 6s segments; 256 kbps ≈ 192 KB per 6s segment.
	const segBytes = 192 * 1024
	// Per-segment simulated download time. Small + fixed so the test is fast and
	// the streaming-vs-full ratio is what's asserted, not wall-clock ms.
	const perSeg = 3 * time.Millisecond

	tracks := []aacTrack{
		{"4min", 40},   // ~7.7 MB
		{"10min", 100}, // ~19.2 MB
	}

	for _, tr := range tracks {
		t.Run(tr.name, func(t *testing.T) {
			// ── Path A: current AAC path — full download, then first byte ──
			cacheA, _ := New(t.TempDir())
			pwA, err := cacheA.BeginPut("asset", "aac")
			if err != nil || pwA == nil {
				t.Fatalf("BeginPut: %v", err)
			}
			startA := time.Now()
			segmentedFiller(pwA, tr.segments, segBytes, perSeg)
			if err := pwA.Commit(); err != nil {
				t.Fatalf("commit: %v", err)
			}
			f, ok := cacheA.Get("asset", "aac")
			if !ok {
				t.Fatal("cache Get miss after commit")
			}
			one := make([]byte, 1)
			f.Read(one) //nolint:errcheck — first byte readable only now
			ttfbFull := time.Since(startA)
			f.Close()

			// ── Path B: streaming path — first byte while still downloading ──
			cacheB, _ := New(t.TempDir())
			spw, err := cacheB.BeginStreamingPut("asset", "aac")
			if err != nil || spw == nil {
				t.Fatalf("BeginStreamingPut: %v", err)
			}
			reader := spw.NewReader()
			startB := time.Now()
			go func() {
				segmentedFiller(spw, tr.segments, segBytes, perSeg)
				spw.Commit() //nolint:errcheck
			}()
			reader.Read(one) //nolint:errcheck — unblocks on the FIRST segment
			ttfbStream := time.Since(startB)
			reader.Close()

			t.Logf("[%s] TTFB full-download=%v  streaming=%v  speedup=%.1fx",
				tr.name, ttfbFull.Round(time.Millisecond),
				ttfbStream.Round(time.Millisecond),
				float64(ttfbFull)/float64(ttfbStream))

			// Structural invariant: streaming delivers byte 0 after ~1 segment,
			// full-download after all N. Assert a large, deterministic gap.
			if ttfbStream*4 >= ttfbFull {
				t.Fatalf("VERDICT: streaming not materially faster (full=%v stream=%v) — #3 not worth it for %s",
					ttfbFull, ttfbStream, tr.name)
			}
		})
	}

	t.Log("VERDICT #3: streaming serves byte 0 after the FIRST segment; the current path serves " +
		"it only after the WHOLE track is downloaded + committed (ServeContent needs the committed " +
		"file). Real download is parallel, so the gain is (whole-track download time − one segment), " +
		"not the serial ratio shown above — i.e. bounded by total_bytes / effective_bandwidth: " +
		"~1-2s for a 4-min track on fast wifi, several seconds on slow links or 10-min tracks. " +
		"The ALAC streaming path already runs this exact mechanism in prod, so extending it to AAC " +
		"is LOW RISK. Implement IF cold-start latency on long tracks / slow links matters; the " +
		"original 'AAC files are small' call is fair for 4-min-on-fast-wifi.")
}
