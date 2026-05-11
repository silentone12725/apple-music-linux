//go:build linux && amd64

package embedded

import _ "embed"

// WrapperBinary holds the wrapper executable embedded at build time.
// The binary is extracted to a private temp directory at runtime.
//
//go:embed wrapper_amd64
var WrapperBinary []byte
