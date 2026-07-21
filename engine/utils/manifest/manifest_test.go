package manifest

import (
	"net/url"
	"strings"
	"testing"

	"github.com/grafov/m3u8"

	"apple-music-cli/utils/structs"
)

// masterFixture is a synthetic EnhancedHls master with one variant per format,
// mirroring the shape Apple returns (codec + audio group naming convention).
const masterFixture = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=256000,BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
aac256/prog.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000,BANDWIDTH=1000000,CODECS="alac",AUDIO="alac-stereo-44100-16"
alac/prog.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=768000,BANDWIDTH=768000,CODECS="ec-3",AUDIO="atmos-2768"
atmos/prog.m3u8
`

func parseMaster(t *testing.T) (*m3u8.MasterPlaylist, *url.URL) {
	t.Helper()
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(masterFixture), true)
	if err != nil || listType != m3u8.MASTER {
		t.Fatalf("decode fixture: err=%v type=%v", err, listType)
	}
	base, _ := url.Parse("https://cdn.example.com/master/main.m3u8")
	return from.(*m3u8.MasterPlaylist), base
}

func TestSelectVariant_ALAC(t *testing.T) {
	master, base := parseMaster(t)
	cfg := structs.ConfigSet{AlacMax: 192000}
	sel, err := SelectVariant(master, base, FormatALAC, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sel.MediaURL, "/master/alac/prog.m3u8") {
		t.Errorf("ALAC media URL = %q, want alac/prog.m3u8", sel.MediaURL)
	}
	if sel.Display != "16-bit / 44100 Hz" {
		t.Errorf("ALAC display = %q", sel.Display)
	}
}

func TestSelectVariant_Atmos(t *testing.T) {
	master, base := parseMaster(t)
	cfg := structs.ConfigSet{AtmosMax: 2768}
	sel, err := SelectVariant(master, base, FormatAtmos, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sel.MediaURL, "/master/atmos/prog.m3u8") {
		t.Errorf("Atmos media URL = %q", sel.MediaURL)
	}
	if sel.Quality != "2768 Kbps" {
		t.Errorf("Atmos quality = %q", sel.Quality)
	}
}

func TestSelectVariant_AAC(t *testing.T) {
	master, base := parseMaster(t)
	cfg := structs.ConfigSet{AacType: "aac"} // audio-stereo-256 → "aac" after regex
	sel, err := SelectVariant(master, base, FormatAAC, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sel.MediaURL, "/master/aac256/prog.m3u8") {
		t.Errorf("AAC media URL = %q", sel.MediaURL)
	}
}

// TestSelectVariant_AtmosMaxExcludes verifies the AtmosMax cap: when the only
// Atmos variant exceeds the cap, selection falls through to "no codec found".
func TestSelectVariant_AtmosMaxExcludes(t *testing.T) {
	master, base := parseMaster(t)
	cfg := structs.ConfigSet{AtmosMax: 100} // 2768 > 100 → excluded
	_, err := SelectVariant(master, base, FormatAtmos, cfg)
	if err == nil {
		t.Fatal("expected no-codec error when Atmos variant exceeds AtmosMax")
	}
}

func TestSelectVariant_NoMatch(t *testing.T) {
	master, base := parseMaster(t)
	cfg := structs.ConfigSet{AacType: "aac-he"} // no HE variant present
	if _, err := SelectVariant(master, base, FormatAAC, cfg); err == nil {
		t.Fatal("expected error when no AAC variant matches AacType")
	}
}
