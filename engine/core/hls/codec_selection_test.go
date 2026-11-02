package hls

import "testing"

func TestStrictCodecTokens(t *testing.T) {
	m := &Master{Variants: []Variant{
		{URL: "substring", Codecs: "not-ec-3", Bandwidth: 9000},
		{URL: "suffix", Codecs: "ec-3-extra", Bandwidth: 8000},
		{URL: "blank", Codecs: "", Bandwidth: 7000},
		{URL: "match", Codecs: "avc1.640028, EC-3 ", Bandwidth: 1000},
		{URL: "zero", Codecs: "alac"},
		{Codecs: "ec-3", Bandwidth: 10000},
	}}
	v, ok := m.SelectVariantByCodec("ec-3")
	if !ok || v.URL != "match" {
		t.Fatalf("exact token: %+v %v", v, ok)
	}
	v, ok = m.SelectVariantByCodec("alac")
	if !ok || v.URL != "zero" {
		t.Fatalf("zero-bandwidth match: %+v %v", v, ok)
	}
	for _, codec := range []string{"", " ", "ec", "mp4a.40.2"} {
		if _, ok := m.SelectVariantByCodec(codec); ok {
			t.Fatalf("unexpected match for %q", codec)
		}
	}
}
