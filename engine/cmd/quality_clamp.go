package main

import (
	"engine/core/drm"
	"engine/core/pipeline"
)

// clampQuality limits requested audio variants to what FairPlay allows right now. Lossless and Atmos are
// decrypted through FairPlay, which only a ready DRM session provides, so without one the request is served
// as AAC instead of opening a session that cannot play. Hi-res is a tier of lossless: it goes when lossless
// does, and when this engine does not allow it. dropped reports whether anything was lowered; a request that
// already fits comes back unchanged, so a signed-in engine is not affected.
func clampQuality(lossless, hiRes, atmos bool, have drm.CapabilityState) (l, h, a, dropped bool) {
	l, h, a = lossless, hiRes, atmos
	if l && !have.ALAC {
		l, dropped = false, true
	}
	if a && !have.Atmos {
		a, dropped = false, true
	}
	if h && (!l || !have.HiRes) {
		h, dropped = false, true
	}
	return l, h, a, dropped
}

// drmCapabilities is what the DRM layer allows right now: nothing without a ready FairPlay session, or in a
// build with no DRM layer.
func (s *APIServer) drmCapabilities() drm.CapabilityState {
	if s.dm == nil { // nil when built without adamplay_backend
		return drm.CapabilityState{}
	}
	return s.dm.Status().Capabilities
}

// playbackCacheQualifier is the disk-cache qualifier of a session's audio: the codec, and for ALAC above
// 48 kHz a "-hires" suffix. The two ALAC tiers are different files, so they cache apart; keyed by codec alone,
// changing the tier in Settings replayed a cached file of the other one.
func playbackCacheQualifier(codec string, sampleRate int) string {
	if codec == string(pipeline.CodecALAC) && sampleRate > 48000 {
		return codec + hiResQualifierSuffix
	}
	return codec
}

const hiResQualifierSuffix = "-hires"
