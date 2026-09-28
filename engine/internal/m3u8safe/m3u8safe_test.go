package m3u8safe

import (
	"strings"
	"testing"
)

func TestDecodeFromMalformedMapDoesNotPanic(t *testing.T) {
	// Found by FuzzParseMedia: the upstream decoder nil-derefs on this input.
	if _, _, err := DecodeFrom(strings.NewReader("#EXT-X-MAP:0\n0"), true); err == nil {
		t.Fatal("want an error for a malformed playlist")
	}
}

func TestDecodeFromValid(t *testing.T) {
	_, typ, err := DecodeFrom(strings.NewReader("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.mp4\n#EXT-X-ENDLIST\n"), true)
	if err != nil || typ == 0 {
		t.Fatalf("valid playlist: type=%v err=%v", typ, err)
	}
}
