package hls

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureServer serves engine/hls/testdata over HTTP so tests never touch the
// real network. Returns the server (caller closes) and its base URL.
func fixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		path := filepath.Join("testdata", name)
		data, err := os.ReadFile(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestOpenMaster_AudioVariants(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	m, err := OpenMaster(context.Background(), srv.URL+"/master_audio.m3u8")
	if err != nil {
		t.Fatalf("OpenMaster: %v", err)
	}
	if len(m.Variants) != 3 {
		t.Fatalf("got %d variants want 3", len(m.Variants))
	}
	for _, v := range m.Variants {
		if !strings.HasPrefix(v.URL, srv.URL) {
			t.Errorf("variant URL %q not resolved to absolute", v.URL)
		}
		if v.Bandwidth == 0 {
			t.Errorf("variant %q has zero bandwidth", v.URL)
		}
	}
}

func TestOpenMaster_VideoWithAlts(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	m, err := OpenMaster(context.Background(), srv.URL+"/master_video.m3u8")
	if err != nil {
		t.Fatalf("OpenMaster: %v", err)
	}
	groups := map[string]string{}
	for _, a := range m.Alternatives {
		groups[a.GroupID] = a.URI
	}
	if _, ok := groups["audio-stereo-256"]; !ok {
		t.Errorf("missing alternative group audio-stereo-256; got %v", groups)
	}
	if uri, ok := groups["audio-atmos"]; !ok {
		t.Errorf("missing alternative group audio-atmos; got %v", groups)
	} else if !strings.Contains(uri, "_gr3_") {
		t.Errorf("atmos URI %q lost _gr3_ rank marker", uri)
	}
}

func TestOpenMaster_RelativeURLs(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	m, err := OpenMaster(context.Background(), srv.URL+"/master_audio.m3u8")
	if err != nil {
		t.Fatalf("OpenMaster: %v", err)
	}
	for _, v := range m.Variants {
		if strings.HasPrefix(v.URL, "audio_") {
			t.Errorf("URL %q still relative", v.URL)
		}
		if !strings.HasPrefix(v.URL, "http") {
			t.Errorf("URL %q not absolute", v.URL)
		}
	}
}

func TestOpenMaster_MediaPlaylistFallback(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	// Point OpenMaster at a media playlist; it should wrap it as single-variant.
	url := srv.URL + "/media_unencrypted.m3u8"
	m, err := OpenMaster(context.Background(), url)
	if err != nil {
		t.Fatalf("OpenMaster: %v", err)
	}
	if len(m.Variants) != 1 {
		t.Fatalf("expected single wrapped variant, got %d", len(m.Variants))
	}
	if m.Variants[0].URL != url {
		t.Errorf("wrapped variant URL = %q want %q", m.Variants[0].URL, url)
	}
}

func TestOpenMedia_Encrypted(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	med, err := OpenMedia(context.Background(), srv.URL+"/media_encrypted.m3u8")
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	if !strings.HasSuffix(med.InitURL, "/init.mp4") {
		t.Errorf("InitURL = %q", med.InitURL)
	}
	if len(med.SegmentURLs) != 3 {
		t.Fatalf("got %d segments want 3", len(med.SegmentURLs))
	}
	if med.Encryption == nil {
		t.Fatal("expected Encryption info, got nil")
	}
	if med.Encryption.KIDBase64 != "base64kidhere==" {
		t.Errorf("KIDBase64 = %q want base64kidhere==", med.Encryption.KIDBase64)
	}
	if med.Encryption.URIPrefix != "skd://key001" {
		t.Errorf("URIPrefix = %q want skd://key001", med.Encryption.URIPrefix)
	}
}

func TestOpenMedia_Unencrypted(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	med, err := OpenMedia(context.Background(), srv.URL+"/media_unencrypted.m3u8")
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	if med.Encryption != nil {
		t.Errorf("expected nil Encryption, got %+v", med.Encryption)
	}
	if len(med.SegmentURLs) != 2 {
		t.Fatalf("got %d segments want 2", len(med.SegmentURLs))
	}
}

func TestOpenMedia_AllURLs(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	med, err := OpenMedia(context.Background(), srv.URL+"/media_encrypted.m3u8")
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	all := med.AllURLs()
	if len(all) != 4 {
		t.Fatalf("AllURLs len = %d want 4", len(all))
	}
	wantSuffix := []string{"/init.mp4", "/seg0.mp4", "/seg1.mp4", "/seg2.mp4"}
	for i, s := range wantSuffix {
		if !strings.HasSuffix(all[i], s) {
			t.Errorf("AllURLs[%d] = %q want suffix %q", i, all[i], s)
		}
	}
}

// ── Selection helpers (unit, no network) ─────────────────────────────────────

func TestSelectByCodec_Match(t *testing.T) {
	t.Parallel()
	m := &Master{Variants: []Variant{
		{URL: "a", Bandwidth: 256000, Codecs: "mp4a.40.2"},
		{URL: "b", Bandwidth: 320000, Codecs: "mp4a.40.2"},
		{URL: "c", Bandwidth: 900000, Codecs: "alac"},
	}}
	if got := m.SelectByCodec("mp4a.40.2"); got != "b" {
		t.Errorf("SelectByCodec(aac) = %q want b (highest matching bw)", got)
	}
	if got := m.SelectByCodec("alac"); got != "c" {
		t.Errorf("SelectByCodec(alac) = %q want c", got)
	}
}

func TestSelectByCodec_NoMatch(t *testing.T) {
	t.Parallel()
	m := &Master{Variants: []Variant{
		{URL: "a", Bandwidth: 256000, Codecs: "mp4a.40.2"},
		{URL: "b", Bandwidth: 320000, Codecs: "mp4a.40.2"},
	}}
	// No ec-3 variant → falls back to highest bandwidth overall.
	if got := m.SelectByCodec("ec-3"); got != "b" {
		t.Errorf("fallback = %q want b (highest bw)", got)
	}
}

func TestSelectAudioVariant_FirstPriority(t *testing.T) {
	t.Parallel()
	m := &Master{Alternatives: []Alternative{
		{GroupID: "audio-stereo-256", URI: "s_gr1_.m3u8"},
		{GroupID: "audio-atmos", URI: "a_gr1_.m3u8"},
	}}
	got, err := m.SelectAudioVariant([]string{"audio-atmos", "audio-stereo-256"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "a_gr1_.m3u8" {
		t.Errorf("got %q want atmos (first priority)", got)
	}
}

func TestSelectAudioVariant_RankWins(t *testing.T) {
	t.Parallel()
	m := &Master{Alternatives: []Alternative{
		{GroupID: "audio-atmos", URI: "a_gr1_.m3u8"},
		{GroupID: "audio-atmos", URI: "a_gr3_.m3u8"},
	}}
	got, err := m.SelectAudioVariant([]string{"audio-atmos"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "a_gr3_.m3u8" {
		t.Errorf("got %q want _gr3_ (higher rank)", got)
	}
}

func TestSelectAudioVariant_NoMatch(t *testing.T) {
	t.Parallel()
	// When no priority GROUP-ID matches, fall back to first available alternative.
	m := &Master{Alternatives: []Alternative{
		{GroupID: "audio-stereo-256", URI: "s_gr1_.m3u8"},
	}}
	got, err := m.SelectAudioVariant([]string{"audio-atmos"})
	if err != nil {
		t.Fatalf("expected fallback, got error: %v", err)
	}
	if got != "s_gr1_.m3u8" {
		t.Errorf("got %q want fallback s_gr1_.m3u8", got)
	}
}

func TestSelectAudioVariant_EmptyAlternatives(t *testing.T) {
	t.Parallel()
	m := &Master{}
	if _, err := m.SelectAudioVariant([]string{"audio-atmos"}); err == nil {
		t.Error("expected error when no alternatives exist at all")
	}
}

func TestSelectVideoVariant_MaxHeight(t *testing.T) {
	t.Parallel()
	m := &Master{Variants: []Variant{
		{URL: "http://x/video_1920x1080.m3u8", AverageBandwidth: 5000000},
		{URL: "http://x/video_1280x720.m3u8", AverageBandwidth: 3000000},
	}}
	got, err := m.SelectVideoVariant(720)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "1280x720") {
		t.Errorf("got %q want 720p variant", got)
	}
}

func TestSelectVideoVariant_NoMatch(t *testing.T) {
	t.Parallel()
	m := &Master{Variants: []Variant{
		{URL: "http://x/video_1920x1080.m3u8", AverageBandwidth: 5000000},
	}}
	if _, err := m.SelectVideoVariant(480); err == nil {
		t.Error("expected error when all variants exceed maxHeight")
	}
}

func TestSelectVideoVariant_BestFit(t *testing.T) {
	t.Parallel()
	m := &Master{Variants: []Variant{
		{URL: "http://x/video_1280x720.m3u8", AverageBandwidth: 3000000},
		{URL: "http://x/video_640x360.m3u8", AverageBandwidth: 1000000},
	}}
	// maxHeight 1080 permits both; highest bandwidth (720p) wins.
	got, err := m.SelectVideoVariant(1080)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "1280x720") {
		t.Errorf("got %q want highest-bandwidth fit (720p)", got)
	}
}

// ── OpenMediaCBCS ────────────────────────────────────────────────────────────

func TestOpenMediaCBCS_ALACByterange(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	med, err := OpenMediaCBCS(context.Background(), srv.URL+"/media_cbcs_alac.m3u8")
	if err != nil {
		t.Fatalf("OpenMediaCBCS: %v", err)
	}
	if !strings.HasSuffix(med.FileURL, "/track_m.mp4") {
		t.Errorf("FileURL = %q want suffix /track_m.mp4", med.FileURL)
	}
	if !strings.HasPrefix(med.FileURL, "http") {
		t.Errorf("FileURL %q not absolute", med.FileURL)
	}
	if len(med.KeyURIs) != 4 {
		t.Fatalf("KeyURIs len = %d want 4", len(med.KeyURIs))
	}
	// Segment 0: prefetch key URI set by first EXT-X-KEY
	if !strings.Contains(med.KeyURIs[0], "P000000000/s1/e1") {
		t.Errorf("KeyURIs[0] = %q want prefetch P000000000/s1/e1", med.KeyURIs[0])
	}
	// Segment 1: content key URI set by second EXT-X-KEY
	if !strings.Contains(med.KeyURIs[1], "p1238037727/c6") {
		t.Errorf("KeyURIs[1] = %q want content key p1238037727/c6", med.KeyURIs[1])
	}
	// Segments 2-3: no new EXT-X-KEY → empty string (key inherited from seg 1)
	if med.KeyURIs[2] != "" {
		t.Errorf("KeyURIs[2] = %q want empty (no key change)", med.KeyURIs[2])
	}
	if med.KeyURIs[3] != "" {
		t.Errorf("KeyURIs[3] = %q want empty (no key change)", med.KeyURIs[3])
	}
}

func TestOpenMediaCBCS_FileURLAbsolute(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	med, err := OpenMediaCBCS(context.Background(), srv.URL+"/media_cbcs_alac.m3u8")
	if err != nil {
		t.Fatal(err)
	}
	// FileURL must be resolved to absolute using the playlist base URL.
	if strings.HasPrefix(med.FileURL, "track_m.mp4") {
		t.Errorf("FileURL %q still relative, expected absolute", med.FileURL)
	}
	if !strings.HasPrefix(med.FileURL, "http://") {
		t.Errorf("FileURL %q not absolute HTTP URL", med.FileURL)
	}
}

func TestOpenMediaCBCS_FiltersMixedKeys(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	// Playlist has both identity and streamingkeydelivery EXT-X-KEY lines.
	// Only the streamingkeydelivery URIs should survive into KeyURIs.
	med, err := OpenMediaCBCS(context.Background(), srv.URL+"/media_cbcs_mixed_keys.m3u8")
	if err != nil {
		t.Fatalf("OpenMediaCBCS: %v", err)
	}
	for i, uri := range med.KeyURIs {
		if uri != "" && strings.Contains(uri, "identityKeyRequest") {
			t.Errorf("KeyURIs[%d] = %q contains identity key — should be filtered", i, uri)
		}
	}
	// First segment should have the streamingkeydelivery URI.
	if !strings.Contains(med.KeyURIs[0], "P000000000/s1/e1") {
		t.Errorf("KeyURIs[0] = %q want streamingkeydelivery prefetch URI", med.KeyURIs[0])
	}
}

// ── filterStreamingKeyDelivery (unit, no network) ────────────────────────────

func TestFilterStreamingKeyDelivery_KeepsStreamingKeyDelivery(t *testing.T) {
	t.Parallel()
	in := `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg0.mp4
`
	out := filterStreamingKeyDelivery(in)
	if !strings.Contains(out, "streamingkeydelivery") {
		t.Error("streamingkeydelivery key line was stripped but should be kept")
	}
}

func TestFilterStreamingKeyDelivery_StripsNonStreamingKeyDelivery(t *testing.T) {
	t.Parallel()
	in := `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://play.itunes.apple.com/identityKeyRequest/abc",KEYFORMAT="identity",IV=0xdeadbeef
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg0.mp4
`
	out := filterStreamingKeyDelivery(in)
	if strings.Contains(out, "identityKeyRequest") {
		t.Error("identity key line survived filter but should be stripped")
	}
	if !strings.Contains(out, "streamingkeydelivery") {
		t.Error("streamingkeydelivery key line was stripped but should be kept")
	}
}

func TestFilterStreamingKeyDelivery_NoKeysPassthrough(t *testing.T) {
	t.Parallel()
	in := `#EXTM3U
#EXTINF:6.0,
seg0.mp4
#EXT-X-ENDLIST
`
	out := filterStreamingKeyDelivery(in)
	if !strings.Contains(out, "seg0.mp4") {
		t.Error("segment line was removed from playlist with no keys")
	}
}

// ── Benchmarks ──────────────────────────────────────────────────────────────

func BenchmarkOpenMaster(b *testing.B) {
	b.ReportAllocs()
	data, _ := os.ReadFile("testdata/master_audio.m3u8")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(data)
	}))
	defer srv.Close()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := OpenMaster(context.Background(), srv.URL+"/master_audio.m3u8"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkOpenMedia(b *testing.B) {
	b.ReportAllocs()
	data, _ := os.ReadFile("testdata/media_encrypted.m3u8")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(data)
	}))
	defer srv.Close()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := OpenMedia(context.Background(), srv.URL+"/media_encrypted.m3u8"); err != nil {
			b.Fatal(err)
		}
	}
}
