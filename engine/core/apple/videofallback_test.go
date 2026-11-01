package apple

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"engine/core/fairplay"
	"engine/core/hls"
	"engine/core/pipeline"
	"engine/utils/mvlabel"
)

func fallbackMaster() (*hls.Master, hls.Variant) {
	m := &hls.Master{Variants: []hls.Variant{
		{URL: "uhd", Resolution: "3840x1598", Codecs: "hvc1.2.4", Bandwidth: 20000000},
		{URL: "hd", Resolution: "1918x798", Codecs: "avc1.640028", Bandwidth: 10000000},
		{URL: "sd", Resolution: "864x360", Codecs: "avc1.64001e", Bandwidth: 1000000},
	}}
	first, _ := m.VariantFor("uhd")
	return m, first
}

func refused() error {
	return fmt.Errorf("acquire licence: %w", fmt.Errorf("fairplay licence: %w, code: -42604, status: -1021", fairplay.ErrLicenceRefused))
}

// fakeOpener fails the variants in refuse and opens any other.
func fakeOpener(refuse map[string]error, tried *[]string) func(hls.Variant) func(context.Context) (*pipeline.Stream, error) {
	return func(v hls.Variant) func(context.Context) (*pipeline.Stream, error) {
		return func(context.Context) (*pipeline.Stream, error) {
			*tried = append(*tried, v.URL)
			if err := refuse[v.URL]; err != nil {
				return nil, err
			}
			return &pipeline.Stream{Kind: pipeline.KindVideo}, nil
		}
	}
}

func TestVideoOpenFallsBackWhenTheLicenceIsRefused(t *testing.T) {
	const id = "fallback-asset-1"
	defer refusals.Delete(id)
	m, first := fallbackMaster()
	var tried []string
	open := openVideoWithFallback(m, first, id, 2160, fakeOpener(map[string]error{"uhd": refused()}, &tried))
	st, err := open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(tried) != "[uhd hd]" {
		t.Errorf("tried %v, want [uhd hd]", tried)
	}
	if st.CodecString != "avc1.640028" {
		t.Errorf("CodecString = %q, want the fallback variant's", st.CodecString)
	}
	if got := mvlabel.Get(); got != "1918x798" {
		t.Errorf("quality label = %q, want 1918x798", got)
	}
	// The refusal is remembered: a reopen starts below it.
	if got := capByRefusal(id, 2160); got != 1597 {
		t.Errorf("capByRefusal = %d, want 1597", got)
	}
	if got := capByRefusal(id, 720); got != 720 {
		t.Errorf("a request already below the refused height must not change, got %d", got)
	}
	if got := capByRefusal("other-asset", 2160); got != 2160 {
		t.Errorf("another video must not be capped, got %d", got)
	}
}

func TestVideoOpenKeepsWorkingDownTheTiers(t *testing.T) {
	const id = "fallback-asset-2"
	defer refusals.Delete(id)
	m, first := fallbackMaster()
	var tried []string
	open := openVideoWithFallback(m, first, id, 2160, fakeOpener(map[string]error{"uhd": refused(), "hd": refused()}, &tried))
	if _, err := open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(tried) != "[uhd hd sd]" {
		t.Errorf("tried %v, want [uhd hd sd]", tried)
	}
}

func TestVideoOpenFailsWhenEveryTierIsRefused(t *testing.T) {
	const id = "fallback-asset-3"
	defer refusals.Delete(id)
	m, first := fallbackMaster()
	var tried []string
	open := openVideoWithFallback(m, first, id, 2160, fakeOpener(map[string]error{"uhd": refused(), "hd": refused(), "sd": refused()}, &tried))
	_, err := open(context.Background())
	if !errors.Is(err, fairplay.ErrLicenceRefused) {
		t.Fatalf("err = %v, want the licence refusal", err)
	}
	if fmt.Sprint(tried) != "[uhd hd sd]" {
		t.Errorf("tried %v", tried)
	}
}

// Only a refusal moves down a tier; a network failure or a cancelled open is reported as it is.
func TestVideoOpenDoesNotFallBackOnOtherErrors(t *testing.T) {
	m, first := fallbackMaster()
	netErr := errors.New("dial tcp: i/o timeout")
	var tried []string
	open := openVideoWithFallback(m, first, "fallback-asset-4", 2160, fakeOpener(map[string]error{"uhd": netErr}, &tried))
	if _, err := open(context.Background()); !errors.Is(err, netErr) {
		t.Fatalf("err = %v, want the network error", err)
	}
	if fmt.Sprint(tried) != "[uhd]" {
		t.Errorf("tried %v, want only the first variant", tried)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tried = nil
	open = openVideoWithFallback(m, first, "fallback-asset-5", 2160, fakeOpener(map[string]error{"uhd": refused()}, &tried))
	if _, err := open(ctx); err == nil {
		t.Fatal("a cancelled open must fail, not fall back")
	}
	if fmt.Sprint(tried) != "[uhd]" {
		t.Errorf("tried %v after cancellation", tried)
	}
}

func TestQualityLineSaysWhatWasRequestedAndWhatPlays(t *testing.T) {
	uhd := hls.Variant{URL: "uhd", Resolution: "3840x1598", Codecs: "hvc1.2.4", VideoRange: "PQ", Bandwidth: 20000000}
	hd := hls.Variant{URL: "hd", Resolution: "1918x798", Codecs: "avc1.640028", VideoRange: "SDR", Bandwidth: 10200000}
	for _, tc := range []struct {
		name             string
		requested        int
		selected, played hls.Variant
		want             string
	}{
		{"fell back from 4K", 2160, uhd, hd,
			"[mv-quality] a1: requested 4K (2160p) -> PLAYING 1918x798 avc1.640028 range=SDR 10.2 Mbps (FELL BACK from 3840x1598 hvc1.2.4: licence refused)"},
		{"as requested", 1080, hd, hd,
			"[mv-quality] a1: requested 1080p -> PLAYING 1918x798 avc1.640028 range=SDR 10.2 Mbps (the tallest this video offers within the request)"},
		{"exact match", 798, hd, hd,
			"[mv-quality] a1: requested 798p -> PLAYING 1918x798 avc1.640028 range=SDR 10.2 Mbps"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := qualityLine("a1", tc.requested, tc.selected, tc.played); got != tc.want {
				t.Errorf("\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

func TestDescribeVariantsListsEachTierWithItsProtection(t *testing.T) {
	got := describeVariants([]hls.Variant{
		{Resolution: "864x360", Codecs: "avc1.64001e,mp4a.40.2", VideoRange: "SDR"},
		{Resolution: "3840x1598", Codecs: "hvc1.2.20000000.H150.B0,mp4a.40.2", VideoRange: "SDR", HDCPLevel: "TYPE-1", AllowedCPC: "com.apple.streamingkeydelivery:Main/AppleMain,com.microsoft.playready:SL3000"},
		{Resolution: "1918x798", Codecs: "avc1.640028,mp4a.40.2", VideoRange: "SDR"},
		{Resolution: "1918x798", Codecs: "avc1.640028,mp4a.40.2", VideoRange: "SDR"}, // a second bitrate of the same tier
		{Resolution: "", Codecs: "mp4a.40.2"},                                        // audio-only entry: no height
	})
	const want = "1598p:hvc1:SDR:TYPE-1:[fairplay:Main/AppleMain playready:SL3000] 798p:avc1:SDR::[unspecified] 360p:avc1:SDR::[unspecified]"
	if got != want {
		t.Errorf("describeVariants = %q, want %q", got, want)
	}
}
