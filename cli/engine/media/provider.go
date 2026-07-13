// Package media defines the Provider abstraction that decouples the engine
// from any specific streaming service or DRM system.
//
// A Provider knows how to convert an opaque asset ID into a set of ready-to-run
// pipeline.Streams.  It handles service authentication, catalog resolution,
// variant selection, and key acquisition entirely internally.  None of those
// details appear in the returned Session.
//
// This lets PlaybackManager, DownloadManager, and QueueManager work identically
// regardless of whether the underlying source is Apple Music, a local file, a
// DASH stream, or any future provider.
package media

import (
	"context"

	"main/engine/pipeline"
)

// Metadata holds the publicly-visible properties of a media item.
// It contains no DRM material and is safe to serialise.
type Metadata struct {
	Title      string
	ArtistName string
	AlbumName  string
	DurationMs int
	ArtworkURL string
	HasLyrics  bool
}

// Track is a single decodable media track within a Session.
// The Open func lazily acquires any necessary resources (connections, licences)
// and returns a pipeline.Stream ready to pipe to any io.Writer.
//
// Kind and Codec are set by the Provider that created the track; the caller
// never needs to inspect them to route playback — it simply asks for the Kind
// it wants when opening a stream.
type Track struct {
	Kind       pipeline.StreamKind
	Codec      pipeline.Codec
	SampleRate int // optional; meaningful only for lossless audio
	BitDepth   int // optional; meaningful only for lossless audio
	Open       func(context.Context) (*pipeline.Stream, error)
}

// Session is the result of a successful Provider.Open call.
// It carries the item's metadata and the full set of available tracks.
type Session struct {
	Kind     string // "song" | "mv" | "podcast" | "radio" …
	Metadata Metadata
	Tracks   []Track
}

// OpenRequest carries the parameters that Providers use to locate and open a
// media item.  Not all providers use all fields.
type OpenRequest struct {
	AssetID    string
	Storefront string
	Token      string // service bearer token (no "Bearer " prefix)
	MUT        string // Apple Media User Token; ignored by non-Apple providers
	Language   string

	// Quality / capability hints — providers pick the best match they support.
	Lossless bool
	Atmos    bool
	Video    bool // request a music video if available

	// MV variant selection hints.
	MVMaxHeight       int
	MVAudioPriorities []string
}

// Provider converts an opaque asset ID into a media Session.
// Implementations must be safe to call concurrently.
type Provider interface {
	Open(ctx context.Context, req OpenRequest) (*Session, error)
}
