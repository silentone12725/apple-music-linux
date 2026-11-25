package fairplay

import (
	"bufio"
	"bytes"
	"testing"

	"engine/core/hls"
)

func TestEffectiveKeyURI(t *testing.T) {
	keys := []string{cbcsPrefetchKey, "skd://real", "", "", "skd://next", ""}
	for i, want := range []string{cbcsPrefetchKey, "skd://real", "skd://real", "skd://real", "skd://next", "skd://next"} {
		if got := effectiveKeyURI(keys, i); got != want {
			t.Errorf("fragment %d: %q, want %q", i, got, want)
		}
	}
	if got := effectiveKeyURI(keys, 99); got != "skd://next" {
		t.Errorf("past end: %q", got)
	}
	if got := effectiveKeyURI(nil, 3); got != "" {
		t.Errorf("no keys: %q", got)
	}
}

// A handshake on a fresh connection starts with the adamID length byte —
// never with SwitchKeys' four zero bytes, which the server would misread.
func TestSendKeyHandshakeBytes(t *testing.T) {
	var buf bytes.Buffer
	rw := bufio.NewReadWriter(bufio.NewReader(&bytes.Buffer{}), bufio.NewWriter(&buf))
	if err := sendKeyHandshake(rw, "1440833098", "skd://real"); err != nil {
		t.Fatal(err)
	}
	rw.Flush()
	// Exactly the wrapper's handle() header: [len][adamID][len][keyURI].
	want := append(append([]byte{10}, "1440833098"...), append([]byte{10}, "skd://real"...)...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("handshake bytes = %q, want %q", buf.Bytes(), want)
	}

	buf.Reset()
	sendKeyHandshake(rw, "1440833098", cbcsPrefetchKey)
	rw.Flush()
	if buf.Bytes()[0] != 1 || buf.Bytes()[1] != '0' {
		t.Fatalf("prefetch key must be sent under adamID \"0\": %q", buf.Bytes())
	}
}

func TestSendFragKeyStartsWithFragmentZeroKey(t *testing.T) {
	var buf bytes.Buffer
	rw := bufio.NewReadWriter(bufio.NewReader(&bytes.Buffer{}), bufio.NewWriter(&buf))
	src := &cbcsSource{
		adamID:  "1440833098",
		keyURIs: []string{cbcsPrefetchKey, "skd://real"},
	}

	var armed string
	src.sendFragKey(0, rw, &armed)
	rw.Flush()
	want := append(append([]byte{1, '0'}, byte(len(cbcsPrefetchKey))), cbcsPrefetchKey...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("fragment 0 key bytes = %q, want %q", buf.Bytes(), want)
	}

	buf.Reset()
	src.sendFragKey(1, rw, &armed)
	rw.Flush()
	wantReal := append([]byte{0, 0, 0, 0, byte(len(src.adamID))}, src.adamID...)
	// The playlist URI goes out bare, as upstream sends it: no ",<kid>" suffix.
	wantReal = append(wantReal, byte(len("skd://real")))
	wantReal = append(wantReal, "skd://real"...)
	if !bytes.Equal(buf.Bytes(), wantReal) {
		t.Fatalf("fragment 1 must switch away from sentinel first, got %q", buf.Bytes())
	}
}

// Ignore tags after the first content key.
func TestUpstreamKeyURIs(t *testing.T) {
	in := []string{cbcsPrefetchKey, "", "skd://real", "skd://later"}
	got := upstreamKeyURIs(in)
	want := []string{cbcsPrefetchKey, "", "skd://real", ""}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("key %d = %q, want %q", i, got[i], want[i])
		}
	}
	if in[3] != "skd://later" {
		t.Fatal("upstreamKeyURIs must not mutate the playlist's slice")
	}
	if len(upstreamKeyURIs([]string{"skd://only"})) != 1 || len(upstreamKeyURIs(nil)) != 0 {
		t.Fatal("short inputs must keep their length")
	}
	if got := FirstAudioKeyURI(in); got != "skd://real" {
		t.Fatalf("FirstAudioKeyURI = %q", got)
	}
}

func TestCBCSSourceFromPastEnd(t *testing.T) {
	src := CBCSSeekableSource("1", nil, &hls.CBCSMedia{SegmentDurations: []float64{10, 10, 10}}, 0)
	skip, actual := src.SourceFrom(999)
	if s := skip.(*cbcsSkipSource); s.startFrag != 2 || actual != 20 {
		t.Fatalf("startFrag=%d actual=%.1f, want last segment (2) at 20.0", s.startFrag, actual)
	}
}

// The armed key belongs to one connection: a second run of the same source must handshake again.
func TestSendFragKeyArmsEachConnectionAfresh(t *testing.T) {
	src := &cbcsSource{adamID: "1", keyURIs: []string{cbcsPrefetchKey, "skd://real"}}
	for run := range 2 {
		var buf bytes.Buffer
		rw := bufio.NewReadWriter(bufio.NewReader(&bytes.Buffer{}), bufio.NewWriter(&buf))
		var armed string
		src.sendFragKey(0, rw, &armed)
		rw.Flush()
		if buf.Len() == 0 {
			t.Fatalf("run %d sent no key on its fresh connection", run)
		}
	}
}
