package hls

import (
	"net/url"
	"testing"
)

func FuzzParseMedia(f *testing.F) {
	f.Add([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.9,\nseg0.mp4\n#EXT-X-ENDLIST\n"))
	f.Add([]byte("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXTINF:4,\n#EXT-X-BYTERANGE:500@100\nfile.mp4\n"))
	f.Fuzz(func(t *testing.T, body []byte) {
		_, _ = parseMedia("https://example.test/a/p.m3u8", body)
	})
}

func FuzzParseMaster(f *testing.F) {
	f.Add([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS=\"mp4a.40.2\"\nv.m3u8\n"))
	f.Add([]byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"x\",URI=\"a.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nv.m3u8\n"))
	base, _ := url.Parse("https://example.test/a/master.m3u8")
	f.Fuzz(func(t *testing.T, body []byte) {
		_, _ = parseMaster(base, base.String(), body)
	})
}
