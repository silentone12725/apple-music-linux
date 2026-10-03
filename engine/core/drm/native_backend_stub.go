//go:build linux && !native_backend

package drm

// NewNativeBackend returns nil when the native_backend build tag is absent
// (i.e. the binary was built without CGO DRM support). This stub prevents
// apiserver.go from failing to compile when the tag is not set.
func NewNativeBackend(drmDir string) DRMBackend {
	return nil
}
