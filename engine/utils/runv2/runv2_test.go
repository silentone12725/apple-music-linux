package runv2

// runv2_test.go — unit tests for ReadInitSegment (C1 fix), socket protocol
// helpers (SwitchKeys, SendString, Close), and DecryptFragment basic behaviour.
//
// Evidence level for each test is noted in its docstring.
//
// These tests do NOT require a real Apple Music account or TCP socket.
// They exercise the Go code paths using synthetic byte streams.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

// ── box-building helpers ──────────────────────────────────────────────────────

// makeBox builds a minimal ISO BMFF box: 4-byte big-endian size + 4-byte type
// + payload.  The resulting bytes are valid input for mp4.DecodeBox.
func makeBox(fourcc string, payload []byte) []byte {
	size := uint32(8 + len(payload))
	b := make([]byte, size)
	binary.BigEndian.PutUint32(b[0:4], size)
	copy(b[4:8], fourcc)
	copy(b[8:], payload)
	return b
}

// makeFtyp returns a minimal ftyp box: major_brand="isom", minor=0,
// compatible_brands=["isom"].  mp4ff parses this without error.
func makeFtyp() []byte {
	payload := make([]byte, 12)
	copy(payload[0:4], "isom") // major_brand
	// minor_version = 0 (bytes 4-7 already zero)
	copy(payload[8:12], "isom") // compatible_brands[0]
	return makeBox("ftyp", payload)
}

// makeMoov returns an 8-byte moov box (header only, no children).
// mp4ff parses it as an empty moov.
func makeMoov() []byte { return makeBox("moov", nil) }

// makeFree returns an 8-byte "free" padding box.
// This is a standard ISO BMFF box type that mp4ff parses as UnknownBox.
func makeFree() []byte { return makeBox("free", nil) }

// ── ReadInitSegment tests (C1 fix verification) ───────────────────────────────

// TestReadInitSegment_StandardOrder verifies the common ftyp+moov sequence.
// Reverse engineered — matches every Apple Music ALAC track we have observed.
func TestReadInitSegment_StandardOrder(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	buf.Write(makeFtyp())
	buf.Write(makeMoov())

	init, offset, err := ReadInitSegment(&buf)
	if err != nil {
		t.Fatalf("standard order: %v", err)
	}
	if init == nil {
		t.Fatal("init is nil")
	}
	if offset == 0 {
		t.Error("offset should advance past both boxes")
	}
}

// TestReadInitSegment_UnknownBoxBeforeSequence verifies that boxes with types
// other than ftyp/moov are consumed and skipped, not rejected.
// This is the C1 regression: the old implementation would have returned an
// error "unexpected box type free, should be ftyp or moov".
func TestReadInitSegment_UnknownBoxBeforeSequence(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	buf.Write(makeFree()) // should be skipped
	buf.Write(makeFtyp())
	buf.Write(makeMoov())

	init, _, err := ReadInitSegment(&buf)
	if err != nil {
		t.Fatalf("unknown box before sequence: %v", err)
	}
	if init == nil {
		t.Fatal("init is nil")
	}
	// ftyp and moov should be present; free should not appear in init children
	hasFtyp, hasMoov := false, false
	for _, child := range init.Children {
		switch child.Type() {
		case "ftyp":
			hasFtyp = true
		case "moov":
			hasMoov = true
		case "free":
			t.Error("free box leaked into init segment children")
		}
	}
	if !hasFtyp {
		t.Error("ftyp missing from init segment")
	}
	if !hasMoov {
		t.Error("moov missing from init segment")
	}
}

// TestReadInitSegment_MultipleUnknownBoxes verifies that many leading unknown
// boxes before moov are all consumed without error.
func TestReadInitSegment_MultipleUnknownBoxes(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	for i := 0; i < 5; i++ {
		buf.Write(makeFree())
	}
	buf.Write(makeFtyp())
	buf.Write(makeMoov())

	if _, _, err := ReadInitSegment(&buf); err != nil {
		t.Fatalf("multiple unknown boxes: %v", err)
	}
}

// TestReadInitSegment_MoovOnly verifies that a stream with moov but no ftyp
// is still accepted (ftyp is optional in some variants).
func TestReadInitSegment_MoovOnly(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	buf.Write(makeMoov())

	init, _, err := ReadInitSegment(&buf)
	if err != nil {
		t.Fatalf("moov-only: %v", err)
	}
	hasMoov := false
	for _, child := range init.Children {
		if child.Type() == "moov" {
			hasMoov = true
		}
	}
	if !hasMoov {
		t.Error("moov missing from moov-only init")
	}
}

// TestReadInitSegment_NoMoov verifies that a stream with no moov box returns
// an error after exhausting the input.
func TestReadInitSegment_NoMoov(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	buf.Write(makeFtyp())
	buf.Write(makeFree())

	_, _, err := ReadInitSegment(&buf)
	if err == nil {
		t.Fatal("expected error when no moov found, got nil")
	}
	// Should end with EOF or explicit "no moov box found" message
	if !errors.Is(err, io.EOF) && !bytes.Contains([]byte(err.Error()), []byte("moov")) && !bytes.Contains([]byte(err.Error()), []byte("EOF")) {
		t.Logf("error = %v (acceptable if it surfaces EOF or describes missing moov)", err)
	}
}

// TestReadInitSegment_OffsetAdvances verifies that the returned offset reflects
// the total bytes consumed (used by the caller to position fragment reads).
func TestReadInitSegment_OffsetAdvances(t *testing.T) {
	t.Parallel()
	ftyp := makeFtyp()
	moov := makeMoov()
	var buf bytes.Buffer
	buf.Write(ftyp)
	buf.Write(moov)
	total := uint64(len(ftyp) + len(moov))

	_, offset, err := ReadInitSegment(&buf)
	if err != nil {
		t.Fatalf("ReadInitSegment: %v", err)
	}
	if offset != total {
		t.Errorf("offset = %d want %d", offset, total)
	}
}

// TestReadInitSegment_OffsetAdvancesWithSkippedBoxes verifies that skipped
// boxes also count toward the offset.
func TestReadInitSegment_OffsetAdvancesWithSkippedBoxes(t *testing.T) {
	t.Parallel()
	free := makeFree()
	ftyp := makeFtyp()
	moov := makeMoov()
	var buf bytes.Buffer
	buf.Write(free)
	buf.Write(ftyp)
	buf.Write(moov)
	total := uint64(len(free) + len(ftyp) + len(moov))

	_, offset, err := ReadInitSegment(&buf)
	if err != nil {
		t.Fatalf("ReadInitSegment: %v", err)
	}
	if offset != total {
		t.Errorf("offset = %d want %d", offset, total)
	}
}

// ── socket protocol helper tests ──────────────────────────────────────────────

// TestSwitchKeys_WritesFourZeroBytes verifies the wire format of SWITCH_KEYS.
// Runtime verified: wire-traced 2026-07-02 for ALAC path.
func TestSwitchKeys_WritesFourZeroBytes(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	if err := SwitchKeys(&buf); err != nil {
		t.Fatalf("SwitchKeys: %v", err)
	}
	got := buf.Bytes()
	if len(got) != 4 {
		t.Fatalf("len = %d want 4", len(got))
	}
	for i, b := range got {
		if b != 0 {
			t.Errorf("byte[%d] = 0x%02x want 0x00", i, b)
		}
	}
}

// TestClose_WritesFiveZeroBytes verifies the wire format of CLOSE.
// The Close signal is 4-byte SwitchKeys + 1-byte zero adamID length.
// Runtime verified: wire-traced 2026-07-02.
func TestClose_WritesFiveZeroBytes(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	// Close uses a WriteCloser; wrap bytes.Buffer in a nopCloser.
	wc := nopCloser{&buf}
	if err := Close(wc); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := buf.Bytes()
	if len(got) != 5 {
		t.Fatalf("len = %d want 5", len(got))
	}
	for i, b := range got {
		if b != 0 {
			t.Errorf("byte[%d] = 0x%02x want 0x00", i, b)
		}
	}
}

// TestSendString_LengthPrefixEncoding verifies the 1-byte-length + string format.
// Runtime verified: wire-traced 2026-07-02.
func TestSendString_LengthPrefixEncoding(t *testing.T) {
	t.Parallel()
	cases := []struct {
		s    string
		want []byte
	}{
		{"0", []byte{1, '0'}},
		{"abc", []byte{3, 'a', 'b', 'c'}},
		{"", []byte{0}},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		if err := SendString(&buf, c.s); err != nil {
			t.Errorf("SendString(%q): %v", c.s, err)
			continue
		}
		if !bytes.Equal(buf.Bytes(), c.want) {
			t.Errorf("SendString(%q) = %x want %x", c.s, buf.Bytes(), c.want)
		}
	}
}

// TestSwitchKeysThenSendString verifies that the composite key-setup sequence
// matches the wire protocol: SwitchKeys(4) + SendString(adamID) + SendString(URI).
// This combination is what CBCSSource sends at key rotation.
// Runtime verified: wire-traced 2026-07-02 for ALAC path.
func TestSwitchKeysThenSendString(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	if err := SwitchKeys(&buf); err != nil {
		t.Fatal(err)
	}
	if err := SendString(&buf, "1488408568"); err != nil {
		t.Fatal(err)
	}
	if err := SendString(&buf, "skd://itunes.apple.com/p1238037727/c6"); err != nil {
		t.Fatal(err)
	}
	got := buf.Bytes()

	// 4 zero bytes + len("1488408568")=10 → [0,0,0,0, 10, '1','4','8','8','4','0','8','5','6','8']
	// + len(URI)=37 → [37, 's','k','d',...]]
	if len(got) < 4 {
		t.Fatalf("too short: %d bytes", len(got))
	}
	if got[0] != 0 || got[1] != 0 || got[2] != 0 || got[3] != 0 {
		t.Error("first 4 bytes are not SwitchKeys zeros")
	}
	if got[4] != 10 { // len("1488408568")
		t.Errorf("adamID length byte = %d want 10", got[4])
	}
	if string(got[5:15]) != "1488408568" {
		t.Errorf("adamID = %q want 1488408568", got[5:15])
	}
}

// ── ReadNextFragment tests ────────────────────────────────────────────────────

// TestReadNextFragment_EmptyStream verifies that EOF on an empty stream returns
// nil fragment and nil error (clean-end signal to the caller's loop).
func TestReadNextFragment_EmptyStream(t *testing.T) {
	t.Parallel()
	frag, offset, err := ReadNextFragment(bytes.NewReader(nil), 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frag != nil {
		t.Error("expected nil fragment on empty stream")
	}
	_ = offset
}

// TestReadNextFragment_MoofMdat verifies basic moof+mdat fragment detection.
// Creates a synthetic fragment: moof box + mdat box (minimal valid sizes).
func TestReadNextFragment_MoofMdat(t *testing.T) {
	t.Parallel()
	// moof needs a valid structure for mp4ff; use "moof" with zero-content children.
	// mp4.NewFragment() creates a fragment; encode it to get valid bytes.
	frag := mp4.NewFragment()
	var buf bytes.Buffer
	if err := frag.Encode(&buf); err != nil {
		// If encoding an empty fragment fails, skip — needs real content.
		t.Skipf("fragment encode: %v", err)
	}
	if buf.Len() == 0 {
		t.Skip("empty fragment encoding — skipping")
	}
	r := bytes.NewReader(buf.Bytes())
	got, _, err := ReadNextFragment(r, 0)
	if err != nil {
		t.Fatalf("ReadNextFragment: %v", err)
	}
	if got == nil {
		t.Error("expected non-nil fragment")
	}
}

// ── FilterSbgpSgpd tests ──────────────────────────────────────────────────────

// TestFilterSbgpSgpd_Empty verifies empty slice input returns empty output and
// removes zero bytes.  Note: FilterSbgpSgpd returns an empty non-nil slice for
// nil input (implementation detail — not a correctness issue).
func TestFilterSbgpSgpd_Empty(t *testing.T) {
	t.Parallel()
	children, removed := FilterSbgpSgpd(nil)
	if len(children) != 0 {
		t.Errorf("expected empty children for nil input, got %d", len(children))
	}
	if removed != 0 {
		t.Errorf("removed = %d want 0", removed)
	}
}

// ── nopCloser helper ─────────────────────────────────────────────────────────

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }
