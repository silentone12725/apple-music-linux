//go:build linux && !amd64 && !arm64

package embedded

import "embed"

// WrapperBinary is not available for this architecture.
var WrapperBinary []byte

// AppleMusicCLIBinary is not available for this architecture.
var AppleMusicCLIBinary []byte

// RootFS is not available for this architecture.
var RootFS embed.FS

// RootFSPrefix is empty when no rootfs is embedded.
const RootFSPrefix = ""
