// Package fairplay is the sole DRM adapter in the engine.
//
// It exposes two things:
//
//  1. LicenseProvider — given key metadata from an HLS playlist, acquires a
//     Decryptor.  This is the only type in the entire engine that holds key
//     bytes; they enter fairplayDecryptor and never leave it.
//
//  2. HLSSource — builds a pipeline.Source that downloads HLS segments.
//     This function lives here rather than in engine/hls because utils/runv3
//     is the authorised segment downloader and this is the only engine package
//     permitted to import it.
//
// Trust boundary: key bytes enter the unexported fairplayDecryptor struct via
// LicenseProvider.Open and are passed directly to runv3.DecryptMP4Streaming.
// They are never stored, logged, or returned to any caller above this package.
package fairplay

import (
	"context"
	"fmt"
	"io"

	"apple-music-cli/engine/bench"
	"apple-music-cli/engine/hls"
	"apple-music-cli/engine/pipeline"
	"apple-music-cli/utils/runv3"
)

// ── Licence acquisition ───────────────────────────────────────────────────────

// LicenseRequest carries the key metadata extracted from an encrypted HLS
// media playlist.  All fields come from the playlist; none are invented here.
type LicenseRequest struct {
	AssetID        string // Apple Music asset ID — needed in the licence request body
	KIDBase64      string // base64 key ID from EXT-X-KEY URI (after the comma)
	URIPrefix      string // KSM URI prefix from EXT-X-KEY URI (before the comma)
	Token          string // bearer token (without "Bearer " prefix)
	MediaUserToken string
}

// LicenseProvider acquires a Decryptor for one encrypted stream.
// It is the only interface in the engine that touches DRM key material.
type LicenseProvider interface {
	Open(ctx context.Context, req LicenseRequest) (pipeline.Decryptor, error)
}

// New returns the default LicenseProvider backed by utils/runv3.
func New() LicenseProvider { return &fpLicenseProvider{} }

type fpLicenseProvider struct{}

func (p *fpLicenseProvider) Open(ctx context.Context, req LicenseRequest) (pipeline.Decryptor, error) {
	tr := bench.FromContext(ctx)
	tr.RecordLicenseStart()
	keyBytes, err := runv3.AcquireKey(ctx,
		req.AssetID, req.KIDBase64, req.URIPrefix, req.Token, req.MediaUserToken)
	tr.RecordLicenseEnd()
	if err != nil {
		return nil, fmt.Errorf("fairplay licence: %w", err)
	}
	return &fairplayDecryptor{key: keyBytes}, nil
}

// fairplayDecryptor is the ONLY type in the engine that holds key bytes.
// It is unexported; callers receive it only through the pipeline.Decryptor interface.
type fairplayDecryptor struct {
	key []byte
}

func (d *fairplayDecryptor) Decrypt(ctx context.Context, r io.Reader, w io.Writer) error {
	return runv3.DecryptMP4Streaming(ctx, r, d.key, w)
}

// ── HLS segment source ────────────────────────────────────────────────────────

// HLSSource returns a pipeline.Source that downloads and concatenates HLS
// segments using the AIMD parallel downloader from utils/runv3.
//
// urls must be [initURL, seg0, seg1, …] as returned by hls.Media.AllURLs().
//
// HLSSource lives in this package rather than engine/hls because utils/runv3
// is the only authorised segment downloader, and this is the only engine
// package permitted to import it.  The function is otherwise a pure transport
// concern with no DRM knowledge.
func HLSSource(urls []string) pipeline.Source { return &hlsSource{urls: urls} }

type hlsSource struct {
	urls []string
}

func (s *hlsSource) Stream(ctx context.Context, w io.Writer) error {
	return runv3.DownloadSegments(ctx, s.urls, w)
}

// HLSSeekableSource returns a pipeline.SeekableSource backed by a full HLS
// media playlist.  Unlike HLSSource (which bakes in a fixed URL list),
// HLSSeekableSource retains the playlist so it can recompute the URL slice
// for an arbitrary seek time via Media.URLsFrom.
func HLSSeekableSource(med *hls.Media) pipeline.SeekableSource {
	return &hlsSeekableSource{media: med}
}

type hlsSeekableSource struct {
	media *hls.Media
}

func (s *hlsSeekableSource) Stream(ctx context.Context, w io.Writer) error {
	return runv3.DownloadSegments(ctx, s.media.AllURLs(), w)
}

func (s *hlsSeekableSource) SourceFrom(startSec float64) (pipeline.Source, float64) {
	urls, actual := s.media.URLsFrom(startSec)
	return &hlsSource{urls: urls}, actual
}

// ── Passthrough (AAC clear content) ──────────────────────────────────────────

// PassthroughDecryptor returns a Decryptor that strips the PSSH box from the
// init segment and copies all fragments to output unchanged. Use for AAC
// content that Apple Music CDN serves without content-level encryption.
func PassthroughDecryptor() pipeline.Decryptor { return &passthroughDecryptor{} }

type passthroughDecryptor struct{}

func (p *passthroughDecryptor) Decrypt(ctx context.Context, r io.Reader, w io.Writer) error {
	return runv3.PassthroughStreaming(ctx, r, w)
}
