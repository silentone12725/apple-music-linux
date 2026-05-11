//go:build linux && !amd64 && !arm64

package embedded

// WrapperBinary is not available for this architecture.
var WrapperBinary []byte
