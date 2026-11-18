package main

import (
	"os"
	"path/filepath"
	"testing"

	"engine/core/drm"
)

func TestClampQuality(t *testing.T) {
	none := drm.CapabilityState{}
	ready := drm.CapabilityState{CBCS: true, ALAC: true, Atmos: true}
	readyHi := drm.CapabilityState{CBCS: true, ALAC: true, Atmos: true, HiRes: true}
	cases := []struct {
		name                      string
		l, h, a                   bool
		have                      drm.CapabilityState
		wantL, wantH, wantA, drop bool
	}{
		{"signed out, lossless becomes AAC", true, false, false, none, false, false, false, true},
		{"signed out, hi-res becomes AAC", true, true, false, none, false, false, false, true},
		{"signed out, atmos becomes AAC", false, false, true, none, false, false, false, true},
		{"signed out, AAC request is untouched", false, false, false, none, false, false, false, false},
		{"ready, lossless is untouched", true, false, false, ready, true, false, false, false},
		{"ready but hi-res disabled keeps capped lossless", true, true, false, ready, true, false, false, true},
		{"ready with hi-res, hi-res is untouched", true, true, false, readyHi, true, true, false, false},
		{"ready, atmos is untouched", false, false, true, ready, false, false, true, false},
		{"hi-res without lossless is dropped", false, true, false, readyHi, false, false, false, true},
	}
	for _, tc := range cases {
		l, h, a, dropped := clampQuality(tc.l, tc.h, tc.a, tc.have)
		if l != tc.wantL || h != tc.wantH || a != tc.wantA || dropped != tc.drop {
			t.Errorf("%s: got l=%v h=%v a=%v dropped=%v, want l=%v h=%v a=%v dropped=%v", tc.name, l, h, a, dropped, tc.wantL, tc.wantH, tc.wantA, tc.drop)
		}
	}
}

func TestDRMCapabilitiesAreNoneWithoutALayer(t *testing.T) {
	s := &APIServer{}
	if got := s.drmCapabilities(); got != (drm.CapabilityState{}) {
		t.Errorf("no DRM layer must report no capabilities, got %+v", got)
	}
}

func TestPlaybackCacheQualifierSeparatesTheALACTiers(t *testing.T) {
	cases := []struct {
		codec string
		rate  int
		want  string
	}{
		{"alac", 44100, "alac"},
		{"alac", 48000, "alac"}, // the top of the capped tier
		{"alac", 0, "alac"},     // rate unknown: the capped file, never a hi-res one
		{"alac", 96000, "alac-hires"},
		{"alac", 192000, "alac-hires"},
		{"aac", 44100, "aac"},
		{"aac", 192000, "aac"}, // only ALAC has tiers
		{"atmos", 48000, "atmos"},
	}
	for _, tc := range cases {
		if got := playbackCacheQualifier(tc.codec, tc.rate); got != tc.want {
			t.Errorf("%s @ %d = %q, want %q", tc.codec, tc.rate, got, tc.want)
		}
	}
}

// Files cached before the tiers were told apart do not say which tier they hold, so the version bump must
// remove them, the hi-res ones included, and leave everything else.
func TestInvalidateALACCacheRemovesBothTiersOnce(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"1-alac.m4a", "2-alac-hires.m4a", "3-aac.m4a", "4-atmos.m4a"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	invalidateALACCacheIfStale(dir)
	for name, wantGone := range map[string]bool{"1-alac.m4a": true, "2-alac-hires.m4a": true, "3-aac.m4a": false, "4-atmos.m4a": false} {
		_, err := os.Stat(filepath.Join(dir, name))
		if gone := os.IsNotExist(err); gone != wantGone {
			t.Errorf("%s: gone=%v, want %v", name, gone, wantGone)
		}
	}
	// A file cached after the bump survives the next start.
	fresh := filepath.Join(dir, "5-alac-hires.m4a")
	if err := os.WriteFile(fresh, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	invalidateALACCacheIfStale(dir)
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("a current-version cache file was removed: %v", err)
	}
}
