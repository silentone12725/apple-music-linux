package e2e

// integration_test.go — live Apple Music integration tests.
//
// These tests are SKIPPED by default.  They run only when all required
// environment variables are set:
//
//	AM_TEST_ADAM_ID     Apple Music track ID (e.g. "1488408568")
//	AM_TEST_TOKEN       Bearer token (without "Bearer " prefix)
//	AM_TEST_MUT         Media User Token (x-apple-music-user-token)
//
// Optional:
//	AM_TEST_STOREFRONT  Storefront code (default: "us")
//	AM_TEST_CBCS_ADDR   FairPlay TCP socket address (default: "127.0.0.1:10020")
//	AM_TEST_ATMOS_ID    Adam ID for an Atmos-capable track (enables Atmos test)
//
// Run with:
//
//	go test ./engine/e2e/ -run Integration -v \
//	    -timeout 120s \
//	    AM_TEST_ADAM_ID=1488408568 \
//	    AM_TEST_TOKEN=<token> \
//	    AM_TEST_MUT=<mut>
//
// Each test writes its verification artifacts to verification/ at the repo root
// (SHA-256 hash, byte count, fragment count from mp4ff).  These files are the
// evidence records for the Runtime Verified claims in CLAUDE.md.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/itouakirai/mp4ff/mp4"

	"main/engine/apple"
	"main/engine/fairplay"
	"main/engine/pipeline"
	"main/engine/playback"
)

// ── environment helpers ───────────────────────────────────────────────────────

func integrationCreds(t *testing.T) (adamID, token, mut, storefront, cbcsAddr string) {
	t.Helper()
	adamID = os.Getenv("AM_TEST_ADAM_ID")
	token = os.Getenv("AM_TEST_TOKEN")
	mut = os.Getenv("AM_TEST_MUT")
	if adamID == "" || token == "" || mut == "" {
		t.Skip("integration test requires AM_TEST_ADAM_ID, AM_TEST_TOKEN, AM_TEST_MUT")
	}
	storefront = os.Getenv("AM_TEST_STOREFRONT")
	if storefront == "" {
		storefront = "us"
	}
	cbcsAddr = os.Getenv("AM_TEST_CBCS_ADDR")
	if cbcsAddr == "" {
		cbcsAddr = "127.0.0.1:10020"
	}
	return
}

// repoRoot returns the root of the repository by walking up from this file.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find repo root")
		}
		dir = parent
	}
}

// writeArtifact writes data to verification/<subdir>/<name>, creating dirs.
func writeArtifact(t *testing.T, subdir, name string, data []byte) string {
	t.Helper()
	dir := filepath.Join(repoRoot(t), "verification", subdir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write artifact %s: %v", path, err)
	}
	t.Logf("artifact written: %s", path)
	return path
}

// ── core stream helper ────────────────────────────────────────────────────────

type streamResult struct {
	Bytes         int    `json:"bytes"`
	SHA256        string `json:"sha256"`
	FragmentCount int    `json:"fragmentCount"`
	Codec         string `json:"codec,omitempty"`
	SampleCount   int    `json:"sampleCount,omitempty"`
}

func streamTrack(t *testing.T, mgr *playback.Manager, adamID, storefront string, req playback.OpenRequest) streamResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	sess, err := mgr.Open(ctx, req)
	if err != nil {
		t.Fatalf("Open %s: %v", adamID, err)
	}
	defer mgr.Release(sess.ID)

	var buf bytes.Buffer
	if err := mgr.Stream(ctx, sess.ID, pipeline.KindAudio, &buf); err != nil {
		t.Fatalf("Stream %s: %v", adamID, err)
	}

	data := buf.Bytes()
	h := sha256.Sum256(data)
	res := streamResult{
		Bytes:  len(data),
		SHA256: fmt.Sprintf("%x", h),
	}

	// Count fragments using mp4ff (best-effort; don't fail the test on parse error).
	if f, err := mp4.DecodeFile(bytes.NewReader(data)); err == nil && f.IsFragmented() {
		res.FragmentCount = len(f.Segments)
	}

	return res
}

// ── Integration tests ─────────────────────────────────────────────────────────

// TestIntegration_ALAC streams an ALAC track through the engine and records
// the SHA-256 and fragment count as a verification artifact.
//
// Evidence produced: verification/output-hashes/<adamID>-engine-alac-<date>.json
// Claim: engine CBCS path produces output for this adamID.
// To prove byte-level parity: run compare-outputs.sh with the same adamID.
func TestIntegration_ALAC(t *testing.T) {
	adamID, token, mut, sf, cbcsAddr := integrationCreds(t)

	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
	res := streamTrack(t, mgr, adamID, sf, playback.OpenRequest{
		AssetID:    adamID,
		Storefront: sf,
		Token:      token,
		MUT:        mut,
		Lossless:   true,
	})

	t.Logf("ALAC: %d bytes, %d fragments, SHA-256=%s", res.Bytes, res.FragmentCount, res.SHA256[:16]+"…")

	if res.Bytes < 1<<16 {
		t.Errorf("suspiciously small output: %d bytes", res.Bytes)
	}
	if res.FragmentCount == 0 {
		t.Log("(fragment count unavailable — mp4ff parse failed; not a failure)")
	}

	artifact, _ := json.MarshalIndent(map[string]any{
		"adamID":        adamID,
		"storefront":    sf,
		"contentType":   "alac",
		"source":        "engine",
		"date":          time.Now().Format("2006-01-02"),
		"bytes":         res.Bytes,
		"sha256":        res.SHA256,
		"fragmentCount": res.FragmentCount,
	}, "", "  ")
	date := time.Now().Format("2006-01-02")
	writeArtifact(t, "output-hashes", fmt.Sprintf("%s-engine-alac-%s.json", adamID, date), artifact)
}

// TestIntegration_AAC streams an AAC track through the engine (CTR/Widevine path).
//
// Evidence produced: verification/output-hashes/<adamID>-engine-aac-<date>.json
func TestIntegration_AAC(t *testing.T) {
	adamID, token, mut, sf, cbcsAddr := integrationCreds(t)

	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
	res := streamTrack(t, mgr, adamID, sf, playback.OpenRequest{
		AssetID:    adamID,
		Storefront: sf,
		Token:      token,
		MUT:        mut,
		// No Lossless: true → falls through to AAC CTR path.
	})

	t.Logf("AAC: %d bytes, SHA-256=%s", res.Bytes, res.SHA256[:16]+"…")

	if res.Bytes < 1<<16 {
		t.Errorf("suspiciously small output: %d bytes", res.Bytes)
	}

	artifact, _ := json.MarshalIndent(map[string]any{
		"adamID":      adamID,
		"storefront":  sf,
		"contentType": "aac",
		"source":      "engine",
		"date":        time.Now().Format("2006-01-02"),
		"bytes":       res.Bytes,
		"sha256":      res.SHA256,
	}, "", "  ")
	date := time.Now().Format("2006-01-02")
	writeArtifact(t, "output-hashes", fmt.Sprintf("%s-engine-aac-%s.json", adamID, date), artifact)
}

// TestIntegration_Atmos streams an Atmos track (if AM_TEST_ATMOS_ID is set).
//
// Evidence produced: verification/output-hashes/<adamID>-engine-atmos-<date>.json
func TestIntegration_Atmos(t *testing.T) {
	_, token, mut, sf, cbcsAddr := integrationCreds(t)
	atmosID := os.Getenv("AM_TEST_ATMOS_ID")
	if atmosID == "" {
		t.Skip("AM_TEST_ATMOS_ID not set")
	}

	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
	res := streamTrack(t, mgr, atmosID, sf, playback.OpenRequest{
		AssetID:    atmosID,
		Storefront: sf,
		Token:      token,
		MUT:        mut,
		Atmos:      true,
	})

	t.Logf("Atmos: %d bytes, %d fragments, SHA-256=%s", res.Bytes, res.FragmentCount, res.SHA256[:16]+"…")

	if res.Bytes < 1<<16 {
		t.Errorf("suspiciously small output: %d bytes", res.Bytes)
	}

	artifact, _ := json.MarshalIndent(map[string]any{
		"adamID":        atmosID,
		"storefront":    sf,
		"contentType":   "atmos",
		"source":        "engine",
		"date":          time.Now().Format("2006-01-02"),
		"bytes":         res.Bytes,
		"sha256":        res.SHA256,
		"fragmentCount": res.FragmentCount,
	}, "", "  ")
	date := time.Now().Format("2006-01-02")
	writeArtifact(t, "output-hashes", fmt.Sprintf("%s-engine-atmos-%s.json", atmosID, date), artifact)
}

// TestIntegration_ConcurrentSessions opens N sessions simultaneously and
// verifies each produces identical output to a reference run.
// Records goroutine counts before/after.
func TestIntegration_ConcurrentSessions(t *testing.T) {
	const N = 5
	adamID, token, mut, sf, cbcsAddr := integrationCreds(t)

	// Reference run first (sequential, single session).
	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
	ref := streamTrack(t, mgr, adamID, sf, playback.OpenRequest{
		AssetID: adamID, Storefront: sf, Token: token, MUT: mut, Lossless: true,
	})
	t.Logf("Reference: %d bytes SHA-256=%s", ref.Bytes, ref.SHA256[:16]+"…")

	goroutinesBefore := countGoroutines()

	// N concurrent sessions, all for the same track.
	type result struct {
		i   int
		res streamResult
		err string
	}
	ch := make(chan result, N)
	for i := range N {
		go func(i int) {
			m := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
			r := streamTrack(t, m, adamID, sf, playback.OpenRequest{
				AssetID: adamID, Storefront: sf, Token: token, MUT: mut, Lossless: true,
			})
			ch <- result{i: i, res: r}
		}(i)
	}

	var mismatches []string
	for range N {
		r := <-ch
		if r.err != "" {
			t.Errorf("session %d: %s", r.i, r.err)
			continue
		}
		if r.res.SHA256 != ref.SHA256 {
			mismatches = append(mismatches, fmt.Sprintf("session %d: sha256=%s want %s",
				r.i, r.res.SHA256[:16]+"…", ref.SHA256[:16]+"…"))
		}
	}
	if len(mismatches) > 0 {
		t.Errorf("concurrent sessions produced different output:\n%s", strings.Join(mismatches, "\n"))
	}

	goroutinesAfter := countGoroutines()
	t.Logf("goroutines: before=%d after=%d delta=%d", goroutinesBefore, goroutinesAfter, goroutinesAfter-goroutinesBefore)

	date := time.Now().Format("2006-01-02")
	artifact, _ := json.MarshalIndent(map[string]any{
		"adamID":           adamID,
		"storefront":       sf,
		"sessions":         N,
		"referenceHash":    ref.SHA256,
		"mismatches":       len(mismatches),
		"goroutinesBefore": goroutinesBefore,
		"goroutinesAfter":  goroutinesAfter,
		"date":             date,
	}, "", "  ")
	writeArtifact(t, "load-tests", fmt.Sprintf("%s-concurrent-%d-%s.json", adamID, N, date), artifact)
}

// TestIntegration_CancelMidStream verifies that cancelling the context
// mid-stream aborts the pipeline and returns promptly.
func TestIntegration_CancelMidStream(t *testing.T) {
	adamID, token, mut, sf, cbcsAddr := integrationCreds(t)

	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr)))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	sess, err := mgr.Open(ctx, playback.OpenRequest{
		AssetID: adamID, Storefront: sf, Token: token, MUT: mut, Lossless: true,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer mgr.Release(sess.ID)

	// Cancel after a short delay — enough for the download to start.
	streamCtx, streamCancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer streamCancel()

	start := time.Now()
	err = mgr.Stream(streamCtx, sess.ID, pipeline.KindAudio, io.Discard)
	elapsed := time.Since(start)

	if err == nil {
		t.Log("stream completed before cancel fired — track may be very small or cached")
	} else if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("expected context error, got: %v", err)
	}
	t.Logf("cancel mid-stream: returned in %v with err=%v", elapsed, err)

	// Should not have waited much longer than the cancel deadline.
	if elapsed > 2*time.Second {
		t.Errorf("stream took %v after cancel — context not propagated promptly", elapsed)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func countGoroutines() int {
	buf := make([]byte, 1<<16)
	n := runtime.Stack(buf, true)
	return strings.Count(string(buf[:n]), "goroutine ")
}
