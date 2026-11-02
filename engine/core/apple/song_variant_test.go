package apple

import (
	"engine/core/hls"
	"engine/core/pipeline"
	"testing"
)

func TestSongVariantSelection(t *testing.T) {
	ec3 := hls.Variant{URL: "ec3", Codecs: "ec-3", Bandwidth: 768000, AverageBandwidth: 640000}
	alac := hls.Variant{URL: "alac", Codecs: "alac", Bandwidth: 2000000}
	aac := hls.Variant{URL: "aac", Codecs: "mp4a.40.2", Bandwidth: 3000000}
	cases := []struct {
		name, requested string
		fallback        bool
		variants        []hls.Variant
		wantURL         string
		wantCodec       pipeline.Codec
	}{
		{"EC-3 wins over higher bandwidth ALAC", "ec-3", true, []hls.Variant{aac, alac, ec3}, "ec3", pipeline.CodecAtmos},
		{"missing EC-3 explicitly falls back to ALAC", "ec-3", true, []hls.Variant{aac, alac}, "alac", pipeline.CodecALAC},
		{"fallback requires permission", "ec-3", false, []hls.Variant{alac}, "", ""},
		{"AAC never masquerades as Atmos", "ec-3", true, []hls.Variant{aac}, "", ""},
		{"AAC never masquerades as ALAC", "alac", true, []hls.Variant{aac}, "", ""},
		{"stereo request does not select EC-3", "alac", true, []hls.Variant{ec3}, "", ""},
		{"empty playlist", "ec-3", true, nil, "", ""},
		{"unsupported request", "mp4a.40.2", true, []hls.Variant{aac}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, codec, err := selectSongVariant(&hls.Master{Variants: tc.variants}, tc.requested, tc.fallback)
			if (err != nil) != (tc.wantURL == "") {
				t.Fatalf("error=%v, wantURL=%q", err, tc.wantURL)
			}
			if v.URL != tc.wantURL || codec != tc.wantCodec {
				t.Fatalf("got %q/%q want %q/%q", v.URL, codec, tc.wantURL, tc.wantCodec)
			}
			if codec == pipeline.CodecAtmos && v.AverageBandwidth != ec3.AverageBandwidth {
				t.Fatal("selected manifest metadata lost")
			}
		})
	}
}

func TestNativeAudioDoesNotInventFormat(t *testing.T) {
	for _, c := range []pipeline.Codec{pipeline.CodecALAC, pipeline.CodecAtmos} {
		br, ch, mime := audioFormatFields(c)
		if br != 0 || ch != 0 {
			t.Fatalf("%s claims unmeasured bitrate/channels: %d/%d", c, br, ch)
		}
		want := `audio/mp4; codecs="alac"`
		if c == pipeline.CodecAtmos {
			want = `audio/mp4; codecs="ec-3"`
		}
		if mime != want {
			t.Fatalf("MIME=%q want %q", mime, want)
		}
	}
	br, ch, mime := audioFormatFields(pipeline.CodecAAC)
	if br != 256000 || ch != 2 || mime != `audio/mp4; codecs="mp4a.40.2"` {
		t.Fatal("known AAC asset format changed")
	}
}
