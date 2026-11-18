package export

import "testing"

func TestDeriveQualityFollowsTheRequestedTier(t *testing.T) {
	hiResTrack := []string{"lossless", "hi-res-lossless"}
	cases := []struct {
		name   string
		cap    ExportCapabilities
		traits []string
		want   string
	}{
		{"hi-res track, cap on (hiRes off)", ExportCapabilities{Lossless: true}, hiResTrack, "Lossless"},
		{"hi-res track, hi-res requested", ExportCapabilities{Lossless: true, HiRes: true}, hiResTrack, "Hi-Res Lossless"},
		{"plain lossless track, hi-res requested", ExportCapabilities{Lossless: true, HiRes: true}, []string{"lossless"}, "Lossless"},
		{"hiRes without lossless is AAC", ExportCapabilities{HiRes: true}, hiResTrack, "AAC"},
		{"atmos wins", ExportCapabilities{Atmos: true, Lossless: true, HiRes: true}, hiResTrack, "Atmos"},
		{"video wins", ExportCapabilities{Video: true, Lossless: true}, hiResTrack, "MV"},
	}
	for _, tc := range cases {
		if got := deriveQuality(tc.cap, tc.traits); got != tc.want {
			t.Errorf("%s: deriveQuality = %q, want %q", tc.name, got, tc.want)
		}
	}
}
