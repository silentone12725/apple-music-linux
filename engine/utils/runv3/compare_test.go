package runv3_test

// compare_test.go — regression tests for the decryptor comparison framework.
//
// Two test levels:
//
// 1. Unit tests (always run): verify helper logic — FirstDiff, topLevelBoxTypes,
//    CompareReport JSON marshalling.  These exercise the comparison plumbing
//    without needing any media data.
//
// 2. Integration test (opt-in): feeds a real encrypted fixture through both
//    decryptors.  Requires environment variables:
//
//	MVCOMPARE_FIXTURE=/path/to/encrypted.raw  (concatenated HLS segment bytes)
//	MVCOMPARE_KEY=<hexkey>                    (16-byte AES key as hex)
//
//    Run with:
//	go test ./utils/runv3/... -run TestCompareDecryptors_Integration -v
//
// Once the video streaming bug is fixed, update TestCompareDecryptors_Integration
// to call t.Errorf (not t.Logf) when FirstDiffStage != "identical".

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"apple-music-cli/utils/runv3"
)

// ─── Unit tests ───────────────────────────────────────────────────────────────

func TestFirstDiff_Equal(t *testing.T) {
	a := []byte{1, 2, 3, 4}
	if d := runv3.FirstDiff(a, append([]byte(nil), a...)); d != -1 {
		t.Errorf("expected -1 for equal slices, got %d", d)
	}
}

func TestFirstDiff_Length(t *testing.T) {
	a := []byte{1, 2, 3}
	b := []byte{1, 2, 3, 4}
	if d := runv3.FirstDiff(a, b); d != 3 {
		t.Errorf("expected 3 (length mismatch), got %d", d)
	}
}

func TestFirstDiff_Content(t *testing.T) {
	a := []byte{0, 1, 2, 0xFF}
	b := []byte{0, 1, 0, 0xFF}
	if d := runv3.FirstDiff(a, b); d != 2 {
		t.Errorf("expected 2, got %d", d)
	}
}

func TestCompareReport_JSON(t *testing.T) {
	rpt := &runv3.CompareReport{
		EncryptedSHA256: "abc123",
		InitEqual:       true,
		FirstDiffStage:  "identical",
		Fragments: []runv3.FragmentReport{
			{
				Index: 0,
				Download: runv3.FragmentStats{
					SeqNumber:      1,
					TrackID:        1,
					SampleCount:    10,
					TrunDataOffset: 48,
					MdatLen:        1024,
					MdatSHA256:     "deadbeef",
					EncodedLen:     1032,
					EncodedSHA256:  "cafebabe",
				},
				MdatEqual:     true,
				EncodedEqual:  true,
				FirstByteDiff: -1,
			},
		},
	}

	data, err := json.Marshal(rpt)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	var rt runv3.CompareReport
	if err := json.Unmarshal(data, &rt); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	if rt.EncryptedSHA256 != rpt.EncryptedSHA256 {
		t.Errorf("EncryptedSHA256 round-trip: got %q", rt.EncryptedSHA256)
	}
	if len(rt.Fragments) != 1 {
		t.Fatalf("expected 1 fragment, got %d", len(rt.Fragments))
	}
	if rt.Fragments[0].Download.TrunDataOffset != 48 {
		t.Errorf("TrunDataOffset: got %d", rt.Fragments[0].Download.TrunDataOffset)
	}
}

func TestDumpMode_Values(t *testing.T) {
	// Verify the exported DumpMode constants are distinct so callers can rely
	// on switch statements being exhaustive.
	modes := []runv3.DumpMode{runv3.DumpNone, runv3.DumpFirstDiff, runv3.DumpAll}
	seen := map[runv3.DumpMode]bool{}
	for _, m := range modes {
		if seen[m] {
			t.Errorf("duplicate DumpMode value: %d", m)
		}
		seen[m] = true
	}
}

// ─── Integration test (opt-in, requires real fixture) ────────────────────────

// TestCompareDecryptors_Integration decrypts a real Apple Music MV fixture
// through both paths and reports divergence.
//
// After the streaming bug is fixed, change the t.Logf at the end to t.Errorf
// so the test becomes a permanent regression gate.
func TestCompareDecryptors_Integration(t *testing.T) {
	fixturePath := os.Getenv("MVCOMPARE_FIXTURE")
	keyHex := os.Getenv("MVCOMPARE_KEY")
	if fixturePath == "" || keyHex == "" {
		t.Skip("set MVCOMPARE_FIXTURE=/path/to/raw.bin and MVCOMPARE_KEY=<hex> to run")
	}

	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		t.Fatalf("decode key: %v", err)
	}

	result, err := runv3.CompareDecryptors(raw, key, runv3.DumpFirstDiff)
	if err != nil {
		t.Fatalf("CompareDecryptors: %v", err)
	}
	rpt := result.Report

	t.Logf("encrypted SHA256:   %s", rpt.EncryptedSHA256)
	t.Logf("init equal:         %v  (dl_boxes=%v  st_boxes=%v)",
		rpt.InitEqual, rpt.Download.InitBoxes, rpt.Stream.InitBoxes)
	t.Logf("frag counts:        dl=%d  st=%d  equal=%v",
		rpt.Download.FragCount, rpt.Stream.FragCount, rpt.FragCountEqual)
	t.Logf("first diff stage:   %s", rpt.FirstDiffStage)
	t.Logf("final output equal: %v", rpt.FinalOutputEqual)

	for _, fr := range rpt.Fragments {
		if !fr.EncodedEqual || !fr.MdatEqual {
			t.Logf("frag %d: mdat=%v encoded=%v (first_byte=%d)",
				fr.Index, fr.MdatEqual, fr.EncodedEqual, fr.FirstByteDiff)
			t.Logf("  download:  seq=%-4d track=%-2d samples=%-4d dataOff=%-6d senc=%v(%d)  mdat=%d",
				fr.Download.SeqNumber, fr.Download.TrackID, fr.Download.SampleCount,
				fr.Download.TrunDataOffset, fr.Download.SencPresent, fr.Download.SencSampleCount,
				fr.Download.MdatLen)
			t.Logf("  streaming: seq=%-4d track=%-2d samples=%-4d dataOff=%-6d senc=%v(%d)  mdat=%d",
				fr.Stream.SeqNumber, fr.Stream.TrackID, fr.Stream.SampleCount,
				fr.Stream.TrunDataOffset, fr.Stream.SencPresent, fr.Stream.SencSampleCount,
				fr.Stream.MdatLen)
		}
	}

	// Write the first-diff fragment pair so it can be inspected with mp4ff-info
	// or ffprobe.
	for _, fp := range result.FragPairs {
		dl := "/tmp/fixture_frag_dl.mp4"
		st := "/tmp/fixture_frag_st.mp4"
		os.WriteFile(dl, fp.Download, 0644)
		os.WriteFile(st, fp.Stream, 0644)
		t.Logf("wrote first-diff pair: %s  %s", dl, st)
	}

	// TODO: flip to t.Errorf once the streaming bug is confirmed fixed.
	if rpt.FirstDiffStage != "identical" {
		t.Logf("KNOWN BUG — divergence at stage %q — update to t.Errorf after fix",
			rpt.FirstDiffStage)
	}
}
