package aacstream

// Test DemuxFMP4ToES: build a real single-track avc1 fMP4 with mp4ff, run the
// demuxer, and verify the ES output — header (magic, codec string from the SPS
// profile/level, non-empty avcC) and per-sample records (keyframe flag, PTS in
// microseconds, exact sample bytes). This proves the wire format the WebCodecs
// renderer parses.
//
// Run: go test ./utils/aacstream/ -run VideoES -v

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

func TestVideoES_DemuxRoundTrip(t *testing.T) {
	const timescale = 90000
	// Real High@4.0 SPS/PPS (NAL header byte included): profile=0x64, compat=0x00,
	// level=0x28 → codec "avc1.640028".
	sps := []byte{0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x84,
		0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc9, 0x20}
	pps := []byte{0x68, 0xe9, 0x7b, 0x2c, 0x8b}

	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(timescale, "video", "und")
	if err := init.Moov.Trak.SetAVCDescriptor("avc1", [][]byte{sps}, [][]byte{pps}, true); err != nil {
		t.Fatalf("SetAVCDescriptor: %v", err)
	}
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		t.Fatalf("init encode: %v", err)
	}

	// One fragment, three samples: a keyframe then two delta frames, each an AVCC
	// length-prefixed dummy NAL. dur=3000 ticks @90k = 33.33ms.
	mkAVCC := func(payload []byte) []byte {
		b := make([]byte, 4+len(payload))
		binary.BigEndian.PutUint32(b[:4], uint32(len(payload)))
		copy(b[4:], payload)
		return b
	}
	sampleData := [][]byte{
		mkAVCC([]byte{0x65, 0x11, 0x22, 0x33}), // IDR (keyframe)
		mkAVCC([]byte{0x41, 0x44, 0x55}),       // non-IDR
		mkAVCC([]byte{0x41, 0x66, 0x77, 0x88}),
	}
	frag, err := mp4.CreateFragment(1, 1)
	if err != nil {
		t.Fatalf("create fragment: %v", err)
	}
	syncFlags := mp4.SampleFlags{SampleIsNonSync: false, SampleDependsOn: 2}.Encode()
	nonSync := mp4.SampleFlags{SampleIsNonSync: true, SampleDependsOn: 1}.Encode()
	for i, d := range sampleData {
		flags := nonSync
		if i == 0 {
			flags = syncFlags
		}
		frag.AddFullSample(mp4.FullSample{
			Sample:     mp4.Sample{Flags: flags, Dur: 3000, Size: uint32(len(d))},
			DecodeTime: uint64(i * 3000),
			Data:       d,
		})
	}
	if err := frag.Encode(&buf); err != nil {
		t.Fatalf("frag encode: %v", err)
	}

	// ── Demux ──
	var es bytes.Buffer
	if err := DemuxFMP4ToES(context.Background(), &buf, &es); err != nil {
		t.Fatalf("DemuxFMP4ToES: %v", err)
	}

	// ── Parse + verify ──
	r := bytes.NewReader(es.Bytes())
	magic := make([]byte, 4)
	if _, err := io.ReadFull(r, magic); err != nil || string(magic) != esMagic {
		t.Fatalf("bad magic %q", magic)
	}
	codec := readLP16(t, r)
	if string(codec) != "avc1.640028" {
		t.Fatalf("codec = %q, want avc1.640028", codec)
	}
	avcC := readLP16(t, r)
	if len(avcC) < 4 || avcC[0] != 1 {
		t.Fatalf("avcC malformed (len=%d)", len(avcC))
	}

	wantPTSus := []int64{0, 33333, 66666} // i*3000 ticks @90k → µs
	for i, want := range sampleData {
		var hdr [17]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			t.Fatalf("sample %d header: %v", i, err)
		}
		key := hdr[0]&1 == 1
		pts := int64(binary.BigEndian.Uint64(hdr[1:9]))
		n := binary.BigEndian.Uint32(hdr[13:17])
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			t.Fatalf("sample %d data: %v", i, err)
		}
		if (i == 0) != key {
			t.Fatalf("sample %d keyframe=%v, want %v", i, key, i == 0)
		}
		if pts != wantPTSus[i] {
			t.Fatalf("sample %d pts=%dµs, want %d", i, pts, wantPTSus[i])
		}
		if !bytes.Equal(data, want) {
			t.Fatalf("sample %d data mismatch", i)
		}
	}
	if r.Len() != 0 {
		t.Fatalf("trailing bytes: %d", r.Len())
	}
	t.Log("VERDICT: DemuxFMP4ToES emits correct header (codec/avcC) + per-sample keyframe/PTS/data — WebCodecs-ready ES.")
}

func readLP16(t *testing.T, r io.Reader) []byte {
	t.Helper()
	var l [2]byte
	if _, err := io.ReadFull(r, l[:]); err != nil {
		t.Fatalf("len prefix: %v", err)
	}
	p := make([]byte, binary.BigEndian.Uint16(l[:]))
	if _, err := io.ReadFull(r, p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	return p
}
