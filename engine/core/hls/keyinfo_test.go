package hls

import (
	"fmt"
	"testing"
)

const keyInfoPlaylist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:;base64,QUJDREVGR0hJSktMTU5PUA==",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"
#EXTINF:5.0,
seg0.mp4
%s#EXTINF:5.0,
seg1.mp4
#EXT-X-ENDLIST
`

// The key attributes are kept for diagnostics: they show which key system a playlist declares, and a key that changes
// between segments is visible as more than one distinct key URI.
func TestParseMediaRecordsKeyInfo(t *testing.T) {
	const second = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:;base64,UVJTVFVWV1hZWjAxMjM0NQ==",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"
`
	for _, tc := range []struct {
		name, mid string
		wantKeys  int
	}{
		{"one key", "", 1},
		{"key changes mid-playlist", second, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			med, err := parseMedia("https://example.test/a/media.m3u8", []byte(fmt.Sprintf(keyInfoPlaylist, tc.mid)))
			if err != nil {
				t.Fatal(err)
			}
			if med.Encryption == nil {
				t.Fatal("no encryption info parsed")
			}
			e := med.Encryption
			if e.Method != "SAMPLE-AES" || e.KeyFormat != "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" {
				t.Errorf("method=%q keyformat=%q", e.Method, e.KeyFormat)
			}
			if e.URIPrefix != "data:;base64" || e.KIDBase64 != "QUJDREVGR0hJSktMTU5PUA==" {
				t.Errorf("prefix=%q kid=%q", e.URIPrefix, e.KIDBase64)
			}
			if e.KeyCount != tc.wantKeys {
				t.Errorf("KeyCount = %d, want %d", e.KeyCount, tc.wantKeys)
			}
		})
	}
}

func TestMasterVariantFor(t *testing.T) {
	m := &Master{Variants: []Variant{
		{URL: "https://example.test/hd.m3u8", Resolution: "1918x798", VideoRange: "SDR"},
		{URL: "https://example.test/uhd.m3u8", Resolution: "3840x1598", VideoRange: "PQ"},
	}}
	v, ok := m.VariantFor("https://example.test/uhd.m3u8")
	if !ok || v.Resolution != "3840x1598" || v.VideoRange != "PQ" {
		t.Fatalf("VariantFor = %+v, %v", v, ok)
	}
	if _, ok := m.VariantFor("https://example.test/none.m3u8"); ok {
		t.Fatal("found a variant that is not in the master")
	}
}
