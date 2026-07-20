package runv3

// compare.go — structural comparison of DecryptMP4 vs DecryptMP4Streaming.
//
// Design:
//   - sideCapture (unexported): buffers raw bytes while processing one path.
//   - fragCapture (unexported): per-fragment raw bytes; discarded after stats
//     are extracted so callers can control memory use via DumpMode.
//   - FragmentStats, CompareReport (exported): lightweight, no raw bytes, safe
//     for JSON serialisation and regression tests.
//   - CompareResult (exported): wraps the report with the raw bytes that file-
//     writing callers need; DumpMode controls how much is retained.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/itouakirai/mp4ff/mp4"
)

// ─── Dump mode ────────────────────────────────────────────────────────────────

// DumpMode controls how much raw fragment data is retained in CompareResult.
type DumpMode int

const (
	// DumpNone keeps only hashes and lengths — minimal memory footprint.
	DumpNone DumpMode = iota
	// DumpFirstDiff retains only the first fragment pair where encoded bytes differ.
	DumpFirstDiff
	// DumpAll retains encoded bytes for every fragment pair.
	DumpAll
)

// ─── Lightweight report types (no raw bytes) ──────────────────────────────────

// SideStats holds aggregate stats for one decryption path.
type SideStats struct {
	InitLen    int      `json:"init_len"`
	InitSHA256 string   `json:"init_sha256"`
	InitBoxes  []string `json:"init_boxes"`
	FragCount  int      `json:"frag_count"`
}

// FragmentStats holds per-fragment metadata for one decryption path.
type FragmentStats struct {
	SeqNumber       uint32 `json:"seq_number"`
	TrackID         uint32 `json:"track_id"`
	SampleCount     uint32 `json:"sample_count"`
	TrunDataOffset  int32  `json:"trun_data_offset"`
	SencPresent     bool   `json:"senc_present"`
	SencSampleCount int    `json:"senc_sample_count"`
	MdatLen         int    `json:"mdat_len"`
	MdatSHA256      string `json:"mdat_sha256"` // hex SHA-256 of decrypted sample bytes
	EncodedLen      int    `json:"encoded_len"`
	EncodedSHA256   string `json:"encoded_sha256"` // hex SHA-256 of full encoded fragment
}

// FragmentReport is the per-fragment cross-path comparison.
type FragmentReport struct {
	Index         int           `json:"index"`
	Download      FragmentStats `json:"download"`
	Stream        FragmentStats `json:"stream"`
	MdatEqual     bool          `json:"mdat_equal"`
	EncodedEqual  bool          `json:"encoded_equal"`
	FirstByteDiff int           `json:"first_byte_diff"` // -1 if equal
}

// CompareReport is the lightweight, JSON-serialisable result of a comparison.
// It contains only hashes, lengths, flags, and offsets — no raw bytes.
type CompareReport struct {
	EncryptedSHA256    string           `json:"encrypted_sha256"`
	Download           SideStats        `json:"download"`
	Stream             SideStats        `json:"stream"`
	InitEqual          bool             `json:"init_equal"`
	InitFirstByteDiff  int              `json:"init_first_byte_diff"` // -1 if equal
	FragCountEqual     bool             `json:"frag_count_equal"`
	Fragments          []FragmentReport `json:"fragments"`
	FirstDiffStage     string           `json:"first_diff_stage"` // "identical"|"init"|"frag_N"
	FinalOutputEqual   bool             `json:"final_output_equal"`
	FinalFirstByteDiff int              `json:"final_first_byte_diff"` // -1 if equal
}

// ─── Full result (report + optional raw bytes) ────────────────────────────────

// FragPair holds encoded bytes for one fragment from both paths.
type FragPair struct {
	Index    int
	Download []byte
	Stream   []byte
}

// CompareResult is returned by CompareDecryptors.  It wraps the lightweight
// CompareReport with raw bytes that callers need to write output files.
// Fields below Report are nil/empty when DumpMode == DumpNone.
type CompareResult struct {
	Report *CompareReport

	// Init segment bytes from each path (always populated — init is small).
	DownloadInit []byte
	StreamInit   []byte

	// Full concatenated output (init + all fragments) from each path.
	DownloadFull []byte
	StreamFull   []byte

	// FragPairs contains per-fragment encoded bytes selected by DumpMode:
	//   DumpNone:      always empty
	//   DumpFirstDiff: at most one entry — the first differing fragment pair
	//   DumpAll:       one entry per fragment
	FragPairs []FragPair
}

// ─── Internal capture types ───────────────────────────────────────────────────

type fragCapture struct {
	stats        FragmentStats
	encodedBytes []byte // kept only when DumpMode requires it
}

type sideCapture struct {
	stats      SideStats
	initBytes  []byte
	frags      []fragCapture
	fullOutput bytes.Buffer
}

// ─── Public API ───────────────────────────────────────────────────────────────

// CompareDecryptors feeds raw into both DecryptMP4 and DecryptMP4Streaming,
// captures metadata after every stage, and returns a structural diff.
//
// dump controls per-fragment byte retention:
//   - DumpNone: only hashes/lengths kept (lowest memory)
//   - DumpFirstDiff: raw bytes for the first diverging fragment pair
//   - DumpAll: raw bytes for every fragment pair
func CompareDecryptors(raw []byte, key []byte, dump DumpMode) (*CompareResult, error) {
	report := &CompareReport{
		EncryptedSHA256: hex256(raw),
	}
	result := &CompareResult{Report: report}

	dlSide, err := runDownloadCapture(raw, key)
	if err != nil {
		return nil, fmt.Errorf("download path: %w", err)
	}
	stSide, err := runStreamCapture(raw, key)
	if err != nil {
		return nil, fmt.Errorf("stream path: %w", err)
	}

	report.Download = dlSide.stats
	report.Stream = stSide.stats
	result.DownloadInit = dlSide.initBytes
	result.StreamInit = stSide.initBytes
	result.DownloadFull = dlSide.fullOutput.Bytes()
	result.StreamFull = stSide.fullOutput.Bytes()

	report.InitEqual = bytes.Equal(dlSide.initBytes, stSide.initBytes)
	report.InitFirstByteDiff = firstDiffIndex(dlSide.initBytes, stSide.initBytes)
	report.FragCountEqual = len(dlSide.frags) == len(stSide.frags)

	n := len(dlSide.frags)
	if len(stSide.frags) < n {
		n = len(stSide.frags)
	}

	foundFirstDiff := false
	for i := 0; i < n; i++ {
		dl := dlSide.frags[i]
		st := stSide.frags[i]

		mdatEq := dl.stats.MdatSHA256 == st.stats.MdatSHA256 &&
			dl.stats.MdatLen == st.stats.MdatLen

		// Compare encoded bytes when both are present; fall back to SHA-256
		// comparison when bytes were not retained (DumpNone path).
		encEq := false
		firstByte := -1
		if dl.encodedBytes != nil && st.encodedBytes != nil {
			encEq = bytes.Equal(dl.encodedBytes, st.encodedBytes)
			firstByte = firstDiffIndex(dl.encodedBytes, st.encodedBytes)
		} else {
			encEq = dl.stats.EncodedSHA256 == st.stats.EncodedSHA256 &&
				dl.stats.EncodedLen == st.stats.EncodedLen
		}

		fr := FragmentReport{
			Index:         i,
			Download:      dl.stats,
			Stream:        st.stats,
			MdatEqual:     mdatEq,
			EncodedEqual:  encEq,
			FirstByteDiff: firstByte,
		}
		report.Fragments = append(report.Fragments, fr)

		switch dump {
		case DumpAll:
			result.FragPairs = append(result.FragPairs, FragPair{
				Index:    i,
				Download: dl.encodedBytes,
				Stream:   st.encodedBytes,
			})
		case DumpFirstDiff:
			if !encEq && !foundFirstDiff {
				result.FragPairs = append(result.FragPairs, FragPair{
					Index:    i,
					Download: dl.encodedBytes,
					Stream:   st.encodedBytes,
				})
				foundFirstDiff = true
			}
		}
	}

	report.FirstDiffStage = "identical"
	if !report.InitEqual {
		report.FirstDiffStage = "init"
	} else {
		for _, fr := range report.Fragments {
			if !fr.EncodedEqual {
				report.FirstDiffStage = fmt.Sprintf("frag_%d", fr.Index)
				break
			}
		}
	}

	report.FinalOutputEqual = bytes.Equal(result.DownloadFull, result.StreamFull)
	report.FinalFirstByteDiff = firstDiffIndex(result.DownloadFull, result.StreamFull)

	return result, nil
}

// FirstDiff returns the index of the first differing byte between a and b,
// or -1 if they are equal.  Exported for use by the cmd/mvcompare frontend.
func FirstDiff(a, b []byte) int { return firstDiffIndex(a, b) }

// ─── Download path capture ────────────────────────────────────────────────────

func runDownloadCapture(raw []byte, key []byte) (sideCapture, error) {
	var side sideCapture

	inMp4, err := mp4.DecodeFile(bytes.NewReader(raw))
	if err != nil {
		return side, fmt.Errorf("DecodeFile: %w", err)
	}
	if !inMp4.IsFragmented() || inMp4.Init == nil {
		return side, fmt.Errorf("not fragmented or missing init")
	}

	decryptInfo, err := mp4.DecryptInit(inMp4.Init)
	if err != nil {
		return side, fmt.Errorf("DecryptInit: %w", err)
	}

	var initBuf bytes.Buffer
	if err := inMp4.Init.Encode(&initBuf); err != nil {
		return side, fmt.Errorf("encode init: %w", err)
	}
	side.initBytes = initBuf.Bytes()
	side.stats = SideStats{
		InitLen:    len(side.initBytes),
		InitSHA256: hex256(side.initBytes),
		InitBoxes:  topLevelBoxTypes(side.initBytes),
	}
	side.fullOutput.Write(side.initBytes)

	for _, seg := range inMp4.Segments {
		for _, frag := range seg.Fragments {
			if decErr := mp4.DecryptFragment(frag, decryptInfo, key); decErr != nil && !isNoSencBox(decErr) {
				return side, fmt.Errorf("DecryptFragment: %w", decErr)
			}
			fc := captureFragment(frag)
			side.fullOutput.Write(fc.encodedBytes)
			side.frags = append(side.frags, fc)
		}
	}

	side.stats.FragCount = len(side.frags)
	return side, nil
}

// ─── Streaming path capture ───────────────────────────────────────────────────

func runStreamCapture(raw []byte, key []byte) (sideCapture, error) {
	var side sideCapture

	br := bufio.NewReaderSize(bytes.NewReader(raw), 1<<20)

	init, offset, err := readInitSegment(br)
	if err != nil {
		return side, fmt.Errorf("readInitSegment: %w", err)
	}

	decryptInfo, err := mp4.DecryptInit(init)
	if err != nil {
		return side, fmt.Errorf("DecryptInit: %w", err)
	}

	var initBuf bytes.Buffer
	if err := init.Encode(&initBuf); err != nil {
		return side, fmt.Errorf("encode init: %w", err)
	}
	side.initBytes = initBuf.Bytes()
	side.stats = SideStats{
		InitLen:    len(side.initBytes),
		InitSHA256: hex256(side.initBytes),
		InitBoxes:  topLevelBoxTypes(side.initBytes),
	}
	side.fullOutput.Write(side.initBytes)

	for {
		frag, err := readNextFragment(br, &offset)
		if err != nil {
			if errors.Is(err, io.EOF) || isUnexpectedEOF(err) {
				break
			}
			return side, fmt.Errorf("readNextFragment: %w", err)
		}

		if decErr := mp4.DecryptFragment(frag, decryptInfo, key); decErr != nil && !isNoSencBox(decErr) {
			return side, fmt.Errorf("DecryptFragment: %w", decErr)
		}

		fc := captureFragment(frag)
		side.fullOutput.Write(fc.encodedBytes)
		side.frags = append(side.frags, fc)
	}

	side.stats.FragCount = len(side.frags)
	return side, nil
}

// ─── Fragment capture ─────────────────────────────────────────────────────────

func captureFragment(frag *mp4.Fragment) fragCapture {
	var fc fragCapture

	// Snapshot mdat samples BEFORE Encode (which calls SetTrunDataOffsets and
	// may reorder children but does not change mdat content).
	if frag.Mdat != nil {
		mdatCopy := make([]byte, len(frag.Mdat.Data))
		copy(mdatCopy, frag.Mdat.Data)
		fc.stats.MdatLen = len(mdatCopy)
		fc.stats.MdatSHA256 = hex256(mdatCopy)
	}

	// Extract moof metadata before Encode rewrites trun.DataOffset.
	if frag.Moof != nil {
		if frag.Moof.Mfhd != nil {
			fc.stats.SeqNumber = frag.Moof.Mfhd.SequenceNumber
		}
		for _, traf := range frag.Moof.Trafs {
			if traf.Tfhd != nil {
				fc.stats.TrackID = traf.Tfhd.TrackID
			}
			for _, trun := range traf.Truns {
				fc.stats.TrunDataOffset = trun.DataOffset
				fc.stats.SampleCount = trun.SampleCount()
				break
			}
			for _, child := range traf.GetChildren() {
				if child.Type() == "senc" {
					fc.stats.SencPresent = true
					if senc, ok := child.(*mp4.SencBox); ok {
						fc.stats.SencSampleCount = int(senc.SampleCount)
					}
				}
			}
			break
		}
	}

	// Encode to get the final on-wire bytes (SetTrunDataOffsets is called here).
	var encBuf bytes.Buffer
	frag.Encode(&encBuf) //nolint:errcheck — bytes.Buffer never returns an error
	fc.encodedBytes = encBuf.Bytes()
	fc.stats.EncodedLen = len(fc.encodedBytes)
	fc.stats.EncodedSHA256 = hex256(fc.encodedBytes)

	// Capture trun.DataOffset as written (post-SetTrunDataOffsets).
	if frag.Moof != nil {
		for _, traf := range frag.Moof.Trafs {
			for _, trun := range traf.Truns {
				fc.stats.TrunDataOffset = trun.DataOffset
				break
			}
			break
		}
	}

	return fc
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func hex256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func firstDiffIndex(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return n
	}
	return -1
}

// topLevelBoxTypes returns the box type strings of the top-level boxes in data.
func topLevelBoxTypes(data []byte) []string {
	var types []string
	r := bytes.NewReader(data)
	var off int
	for r.Len() >= 8 {
		hdr := make([]byte, 8)
		if _, err := io.ReadFull(r, hdr); err != nil {
			break
		}
		size := int(hdr[0])<<24 | int(hdr[1])<<16 | int(hdr[2])<<8 | int(hdr[3])
		if size < 8 {
			break
		}
		types = append(types, string(hdr[4:8]))
		off += size
		if off > len(data) {
			break
		}
		r.Seek(int64(off), io.SeekStart)
	}
	return types
}

func isUnexpectedEOF(err error) bool {
	return errors.Is(err, io.ErrUnexpectedEOF)
}

// keep context import used only in tests
var _ = context.Background
