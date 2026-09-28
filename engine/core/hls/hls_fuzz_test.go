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

func TestURLsFromPastEndReportsLastSegmentsStart(t *testing.T) {
	m := &Media{SegmentURLs: []string{"s0", "s1", "s2"}, SegmentDurations: []float64{10, 10, 10}}
	urls, actual := m.URLsFrom(999)
	// Clamped to the last segment (index 2), then stepped back one → index 1 at 10 s.
	if len(urls) != 2 || urls[0] != "s1" || actual != 10 {
		t.Fatalf("urls=%v actual=%.1f, want [s1 s2] at 10.0", urls, actual)
	}
}

func TestSelectVideoVariantWithoutAverageBandwidth(t *testing.T) {
	m := &Master{Variants: []Variant{
		{URL: "low", Bandwidth: 1_000_000, Codecs: "avc1", Resolution: "640x360"},
		{URL: "high", Bandwidth: 8_000_000, Codecs: "avc1", Resolution: "1920x1080"},
		{URL: "mid", Bandwidth: 4_000_000, Codecs: "avc1", Resolution: "1280x720"},
	}}
	for range 20 {
		if got, _ := m.SelectVideoVariant(1080); got != "high" {
			t.Fatalf("picked %q, want the highest-bandwidth variant", got)
		}
	}
}
