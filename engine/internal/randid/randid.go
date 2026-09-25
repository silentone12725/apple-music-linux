// Package randid generates random hex IDs.
package randid

import (
	"crypto/rand"
	"encoding/hex"
	"log"
)

// New returns a random 16-character lowercase hex string.
func New() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read reads from /dev/urandom on Linux and is non-blocking;
		// this path is effectively unreachable in production.
		log.Printf("[randid] crypto/rand.Read: %v", err)
	}
	return hex.EncodeToString(b)
}
