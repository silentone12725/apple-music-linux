// Package m3u8safe wraps github.com/grafov/m3u8 decoding. The library
// (v0.11.1, unmaintained) nil-derefs on some malformed playlists — e.g.
// "#EXT-X-MAP" without a URI — and a panic in a background goroutine (prefetch,
// pipeline) would take down the whole engine. Playlists come from the network,
// so every decode goes through here and a panic becomes an ordinary error.
package m3u8safe

import (
	"bytes"
	"fmt"
	"io"

	"github.com/grafov/m3u8"
)

// DecodeFrom is m3u8.DecodeFrom with panics converted to errors.
func DecodeFrom(r io.Reader, strict bool) (p m3u8.Playlist, t m3u8.ListType, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			p, t, err = nil, 0, fmt.Errorf("m3u8: malformed playlist: %v", rec)
		}
	}()
	return m3u8.DecodeFrom(r, strict)
}

// Decode is m3u8.Decode with panics converted to errors.
func Decode(buf bytes.Buffer, strict bool) (m3u8.Playlist, m3u8.ListType, error) {
	return DecodeFrom(&buf, strict)
}
