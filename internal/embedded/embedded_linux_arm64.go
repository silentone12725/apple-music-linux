//go:build linux && arm64

package embedded

import "embed"

// WrapperBinary holds the wrapper executable embedded at build time.
// The binary is extracted to a private temp directory at runtime.
//
//go:embed wrapper_arm64
var WrapperBinary []byte

// AppleMusicCLIBinary holds the apple-music-cli executable embedded at build time.
//
//go:embed apple-music-cli_arm64
var AppleMusicCLIBinary []byte

// RootFS contains the embedded wrapper root filesystem.
//
//go:embed rootfs_arm64/**
var RootFS embed.FS

// RootFSPrefix is the embedded rootfs folder prefix.
const RootFSPrefix = "rootfs_arm64"
