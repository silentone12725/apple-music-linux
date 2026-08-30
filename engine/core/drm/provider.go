// Package drm exposes Apple Music DRM capabilities to the engine.
//
// Architecture:
//
//	PlaybackManager → DRMProvider → DRMManager → DRMBackend → (ExternalBackend | EmbeddedBackend)
//
// DRMProvider is the only interface playback code uses. It has no knowledge
// of wrappers, processes, ports, or transports.
//
// DRMManager implements DRMProvider and owns the full DRM lifecycle: process
// management, authentication orchestration, session management, and
// restart policy.
//
// DRMBackend is the swappable transport layer. Phase 1 uses ExternalBackend
// (subprocess + TCP); Phase 2 replaces it with EmbeddedBackend (CGO). The
// interface above DRMBackend never changes between phases.
package drm

import "context"

// DRMProvider is the interface playback code uses for DRM operations.
// It carries no knowledge of transports, ports, or backend implementations.
// cbcs.go calls Decrypt; neither the provider nor the caller knows or cares
// whether decryption happens over TCP or a direct C function call.
type DRMProvider interface {
	// Decrypt decrypts CBCS samples for the given adamID and key URI.
	// If the DRM backend is not running but a valid session exists, the
	// implementation auto-starts the backend before decrypting.
	// Returns ErrNotAuthenticated if no session exists.
	Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error)

	// GetM3U8 returns the HLS URL for the given Apple Music adamID.
	GetM3U8(ctx context.Context, adamID uint64) (string, error)

	// GetAccount returns cached account information (storefront, tokens).
	GetAccount(ctx context.Context) (AccountInfo, error)
}

// DecryptRequest carries the inputs for a CBCS decryption operation.
type DecryptRequest struct {
	AdamID  string
	KeyURI  string
	Samples [][]byte
}

// DecryptResponse carries the decrypted output samples in the same order
// as the input.
type DecryptResponse struct {
	Samples [][]byte
}

// AccountInfo holds the cached Apple Music account information.
type AccountInfo struct {
	StorefrontID string
	DevToken     string
	MusicToken   string
}

// ErrNotAuthenticated is returned by Decrypt and GetM3U8 when no valid
// DRM session exists and auto-start is not possible.
type NotAuthenticatedError struct{}

func (NotAuthenticatedError) Error() string { return "DRM session not authenticated" }

var ErrNotAuthenticated = NotAuthenticatedError{}
