package hls

import (
	"net/url"
	"testing"
)

// A variant's HDCP-LEVEL says what output protection it demands, which is what separates a tier a software client may
// play from one it may not.
func TestParseMasterKeepsHDCPLevel(t *testing.T) {
	body := `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=20000000,AVERAGE-BANDWIDTH=19000000,CODECS="hvc1.2.20000000.H150.B0,mp4a.40.2",RESOLUTION=3840x1598,VIDEO-RANGE=SDR,HDCP-LEVEL=TYPE-1
uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10000000,AVERAGE-BANDWIDTH=9500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1918x798,VIDEO-RANGE=SDR
hd.m3u8
`
	base, _ := url.Parse("https://example.test/master.m3u8")
	m, err := parseMaster(base, base.String(), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(m.Variants))
	}
	if got := m.Variants[0].HDCPLevel; got != "TYPE-1" {
		t.Errorf("uhd HDCPLevel = %q, want TYPE-1", got)
	}
	if got := m.Variants[1].HDCPLevel; got != "" {
		t.Errorf("hd HDCPLevel = %q, want empty", got)
	}
}

// ALLOWED-CPC names the key systems (and their security levels) that may play a variant. The m3u8 library does not
// expose it, so it is read from the EXT-X-STREAM-INF lines.
func TestParseMasterKeepsAllowedCPC(t *testing.T) {
	body := `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=20000000,CODECS="hvc1.2.4,mp4a.40.2",RESOLUTION=3840x1598,ALLOWED-CPC="com.apple.streamingkeydelivery:Main/AppleMain,com.microsoft.playready:SL3000"
uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1918x798,ALLOWED-CPC="com.microsoft.playready:SL2000,urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed:WIDEVINE_SOFTWARE"
hd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=864x360
sd.m3u8
`
	base, _ := url.Parse("https://example.test/master.m3u8")
	m, err := parseMaster(base, base.String(), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"com.apple.streamingkeydelivery:Main/AppleMain,com.microsoft.playready:SL3000",
		"com.microsoft.playready:SL2000,urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed:WIDEVINE_SOFTWARE",
		"",
	}
	for i, w := range want {
		if got := m.Variants[i].AllowedCPC; got != w {
			t.Errorf("variant %d AllowedCPC = %q, want %q", i, got, w)
		}
	}
}

func TestCPCSummary(t *testing.T) {
	for in, want := range map[string]string{
		"": "unspecified",
		"com.apple.streamingkeydelivery:Main/AppleMain,com.microsoft.playready:SL3000": "fairplay:Main/AppleMain playready:SL3000",
		"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed:WIDEVINE_SOFTWARE":              "widevine:WIDEVINE_SOFTWARE",
	} {
		if got := CPCSummary(in); got != want {
			t.Errorf("CPCSummary(%q) = %q, want %q", in, got, want)
		}
	}
}
