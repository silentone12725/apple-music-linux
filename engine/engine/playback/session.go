package playback

import (
	"time"

	"apple-music-cli/engine/pipeline"
)

// Session is the public session descriptor returned to API clients.
// It contains no DRM material and is safe to serialise to JSON.
// Every field with a json tag is client-visible; there are no unexported fields.
type Session struct {
	ID         string `json:"sessionId"`
	AssetID    string `json:"assetId"`
	Storefront string `json:"storefront"`
	Type       string `json:"type"` // "song" | "mv"

	Codec      string `json:"codec,omitempty"`
	SampleRate int    `json:"sampleRate,omitempty"`
	BitDepth   int    `json:"bitDepth,omitempty"`

	Capabilities struct {
		Audio    bool `json:"audio"`
		Video    bool `json:"video"`
		Lyrics   bool `json:"lyrics"`
		Seekable bool `json:"seekable"` // true when audio stream supports ?t= restart
	} `json:"capabilities"`

	Streams struct {
		Audio string `json:"audio,omitempty"`
		Video string `json:"video,omitempty"`
	} `json:"streams"`

	Title      string `json:"title"`
	ArtistName string `json:"artistName"`
	AlbumName  string `json:"albumName,omitempty"`
	DurationMs int    `json:"durationMs"`
	ArtworkURL string `json:"artworkUrl"`

	ExpiresIn int `json:"expiresIn"`
}

// playContext is the private engine state bound to one session.
// Streams are keyed by StreamKind so the API can request any track type
// without requiring separate methods for audio vs. video vs. future kinds.
//
// The context is stored in a separate sync.Map from the Session, so that a
// lease refresh can replace the context (rebuilding Source + Decryptor) while
// leaving the Session (and the client's sessionId) completely unchanged.
type playContext struct {
	streams map[pipeline.StreamKind]*pipeline.Stream
	expiry  time.Time
}
