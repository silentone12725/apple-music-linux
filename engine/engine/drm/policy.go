package drm

import "strings"

// ResolveBackendPolicy decides which backend to prefer and which (if any) to
// fall back to. It is a pure function (no I/O, no globals) so both the engine
// and tests can exercise every branch directly.
//
// Precedence:
//  1. preferred set explicitly ("embedded"|"process"|"auto") — honored as-is;
//     "auto" expands to the current best-available order (embedded, process).
//  2. preferred unset AND legacyEmbedded (the deprecated
//     `use-embedded-backend: true`) — preserves the exact pre-fallback-feature
//     behavior: embedded only, NO automatic fallback. A config that explicitly
//     opted into Embedded before this feature existed gets exactly what it
//     asked for, not a new fallback it never requested.
//  3. Neither set (the common case: no config, or the bool left at its false
//     zero-value) — the new default: "auto" (embedded, falling back to process).
//
// Without a wrapper binary path (hasWrapper=false) only ProcessBackend is
// constructible, regardless of any other setting.
func ResolveBackendPolicy(hasWrapper bool, preferred, fallback string, legacyEmbedded bool) (resolvedPreferred, resolvedFallback string) {
	norm := func(s string) string {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "embedded":
			return "embedded"
		case "process":
			return "process"
		case "auto":
			return "auto"
		default:
			return ""
		}
	}
	// "auto" picks the best available backend today (Embedded, falling back to
	// Process). As more backends appear (e.g. native DRM), auto's order evolves
	// with no config change: native → embedded → process.
	const autoPreferred, autoFallback = "embedded", "process"

	if !hasWrapper {
		return "process", ""
	}
	if p := norm(preferred); p != "" {
		if p == "auto" {
			return autoPreferred, autoFallback
		}
		return p, norm(fallback)
	}
	if legacyEmbedded {
		return "embedded", "" // exact legacy semantics: no fallback
	}
	return autoPreferred, autoFallback
}
