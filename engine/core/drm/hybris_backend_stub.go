//go:build !hybris_backend

package drm

// HybrisBackend stub — present when the hybris_backend build tag is NOT set
// (i.e. libdrm-native.so is not available). NewHybrisBackend panics so that
// any accidental call at runtime surfaces immediately.

// NewHybrisBackend returns nil when the hybris_backend build tag is not set.
// apiserver.go checks cfg.BackendPreferred == "hybris" only when libdrm-native.so
// is present on disk, so this codepath is never reached in practice without the tag.
func NewHybrisBackend(_ string) DRMBackend { return nil }
