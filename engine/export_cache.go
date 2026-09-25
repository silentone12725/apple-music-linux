package main

import (
	"io"

	"engine/core/diskcache"
)

// diskAudioCache adapts the playback disk cache to export.AudioCache so audio
// exports can reuse bytes playback already fetched instead of downloading the
// track a second time.
type diskAudioCache struct{ c *diskcache.Cache }

func (d diskAudioCache) Path(assetID, qualifier string) (string, bool) {
	return d.c.Path(assetID, qualifier)
}

// TailReader reports a tail only when playback has an in-progress streaming
// download for this exact asset+qualifier.
func (d diskAudioCache) TailReader(assetID, qualifier string) (io.ReadCloser, bool) {
	sw := d.c.GetStreaming(assetID, qualifier)
	if sw == nil {
		return nil, false
	}
	return streamingReadCloser{sw.NewReader()}, true
}

// streamingReadCloser adapts diskcache.StreamingReader (whose Close returns
// nothing) to io.ReadCloser.
type streamingReadCloser struct{ r *diskcache.StreamingReader }

func (s streamingReadCloser) Read(p []byte) (int, error) { return s.r.Read(p) }
func (s streamingReadCloser) Close() error               { s.r.Close(); return nil }
