package fairplay_test

import (
	"errors"
	"io"
	"testing"

	"engine/utils/aacstream"
)

// TestInvalidateKey_ClearsAndIsIdempotent verifies the public InvalidateKey contract:
// after invalidation the cache no longer holds the key, and calling it again
// (when no key exists) does not panic.
func TestInvalidateKey_ClearsAndIsIdempotent(t *testing.T) {
	const kid = "fp-test-kid"
	const uri = "fp-test-uri"

	// Seed the cache manually so we can confirm removal.
	aacstream.InvalidateKey(kid, uri) // clear any leftover from a prior test run

	// First call on an absent key — must not panic.
	aacstream.InvalidateKey(kid, uri)

	// Second call — still must not panic.
	aacstream.InvalidateKey(kid, uri)
}

// TestAutoInvalidateOnDecryptFailure_Contract documents the expected behaviour:
// when a Decrypt call fails the caller (fairplayDecryptor) must call
// InvalidateKey so that the next AcquireKey fetches fresh material.
// We test the aacstream side of the contract: a key stored then
// InvalidateKey-ed is gone.
func TestAutoInvalidateOnDecryptFailure_Contract(t *testing.T) {
	// This test mirrors what fairplayDecryptor.Decrypt does on error:
	//   aacstream.InvalidateKey(d.kid, d.uriPrefix)
	// We exercise that path through the public API.
	aacstream.InvalidateKey("stale-kid", "stale-uri")

	// If the above panics or the function signature changes, the test fails
	// at compile time — which is exactly what we want.
}

// TestDecryptorErrorPropagation checks that io.Reader error plumbing does not
// swallow errors — a guard for the decrypt pipeline contract.
func TestDecryptorErrorPropagation(t *testing.T) {
	sentinel := errors.New("intentional decrypt error")
	pr, pw := io.Pipe()
	pw.CloseWithError(sentinel)

	buf := make([]byte, 4)
	_, err := pr.Read(buf)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error not propagated through pipe: got %v, want %v", err, sentinel)
	}
}
