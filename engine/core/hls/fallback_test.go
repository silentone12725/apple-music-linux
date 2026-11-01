package hls

import "testing"

func TestVideoFallback(t *testing.T) {
	m := &Master{Variants: []Variant{
		{URL: "https://example.test/uhd.m3u8", Resolution: "3840x1598", Codecs: "hvc1.2.4.L153.B0", Bandwidth: 20000000},
		{URL: "https://example.test/hevc1080.m3u8", Resolution: "1920x806", Codecs: "hvc1.1.6.L120.90", Bandwidth: 9000000},
		{URL: "https://example.test/hd.m3u8", Resolution: "1918x798", Codecs: "avc1.640028", Bandwidth: 10000000},
		{URL: "https://example.test/hd-low.m3u8", Resolution: "1918x798", Codecs: "avc1.640028", Bandwidth: 6000000},
		{URL: "https://example.test/sd.m3u8", Resolution: "1024x428", Codecs: "avc1.64001f", Bandwidth: 3000000},
		{URL: "https://example.test/small.m3u8", Resolution: "864x360", Codecs: "avc1.64001e", Bandwidth: 1000000},
	}}
	for _, tc := range []struct {
		name, failed, want string
		ok                 bool
	}{
		{"4K falls back to the tallest H.264, not HEVC", "https://example.test/uhd.m3u8", "https://example.test/hd.m3u8", true},
		{"H.264 falls back to the next lower height", "https://example.test/hd.m3u8", "https://example.test/sd.m3u8", true},
		{"then lower again", "https://example.test/sd.m3u8", "https://example.test/small.m3u8", true},
		{"nothing is lower than the smallest", "https://example.test/small.m3u8", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failed, ok := m.VariantFor(tc.failed)
			if !ok {
				t.Fatal("test variant missing")
			}
			got, ok := m.VideoFallback(failed)
			if ok != tc.ok || got.URL != tc.want {
				t.Errorf("VideoFallback = %q, %v; want %q, %v", got.URL, ok, tc.want, tc.ok)
			}
		})
	}
	if _, ok := m.VideoFallback(Variant{URL: "https://example.test/unknown.m3u8"}); ok {
		t.Error("a variant with no height must not produce a fallback")
	}
}

func TestVariantHeight(t *testing.T) {
	for _, tc := range []struct {
		v    Variant
		want int
	}{
		{Variant{Resolution: "3840x1598"}, 1598},
		{Variant{URL: "https://cdn.test/x/MV_video_gr290_sdr_1918x798_cbcs.m3u8"}, 798},
		{Variant{}, 0},
	} {
		if got := tc.v.Height(); got != tc.want {
			t.Errorf("%+v.Height() = %d, want %d", tc.v, got, tc.want)
		}
	}
}
