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

func TestCBCSSourceFromPastEnd(t *testing.T) {
	src := CBCSSeekableSource("1", nil, &hls.CBCSMedia{SegmentDurations: []float64{10, 10, 10}}, 0)
	skip, actual := src.SourceFrom(999)
	if s := skip.(*cbcsSkipSource); s.startFrag != 2 || actual != 20 {
		t.Fatalf("startFrag=%d actual=%.1f, want last segment (2) at 20.0", s.startFrag, actual)
	}
}
