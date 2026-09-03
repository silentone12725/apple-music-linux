// Package randid generates random hex IDs.
package randid

import (
	"crypto/rand"
	"encoding/hex"
)

// New returns a random 16-character lowercase hex string.
func New() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
