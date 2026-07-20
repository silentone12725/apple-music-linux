// Package export implements the engine's media export pipeline.
//
// An ExportJob downloads one track, decrypts it, writes it to a user-specified
// path, and optionally embeds artwork, lyrics, and metadata tags.
// Jobs are enqueued on an ExportManager and processed by a bounded worker pool.
// Progress is emitted as structured events that the API layer forwards over SSE.
//
// Separation of concerns:
//   - ExportManager is responsible for media acquisition, decryption, tagging,
//     and writing files.  It knows nothing about HTTP or the TUI.
//   - The caller (apiserver.go) is responsible for routing HTTP requests to the
//     manager and forwarding events to SSE clients.
//   - The client (apple-music-linux) is responsible for UX, download queue
//     display, library browsing, and playback cache management.
package export

import (
	"time"
)

// Phase describes the current stage of an export job.
type Phase string

const (
	PhaseQueued      Phase = "queued"
	PhaseResolving   Phase = "resolving"   // fetching catalog metadata
	PhaseDownloading Phase = "downloading" // streaming+decrypting fMP4
	PhaseTagging     Phase = "tagging"     // embedding metadata, artwork, lyrics
	PhaseMoving      Phase = "moving"      // temp → final path
	PhaseDone        Phase = "done"
	PhaseFailed      Phase = "failed"
	PhaseCancelled   Phase = "cancelled"
)

// ExportCapabilities selects the content variant to export.
type ExportCapabilities struct {
	Lossless bool `json:"lossless"` // ALAC
	Atmos    bool `json:"atmos"`    // Dolby Atmos
	Video    bool `json:"video"`    // Music Video
}

// ExportOptions controls post-processing of the downloaded file.
type ExportOptions struct {
	// EmbedArtwork downloads and embeds the track's cover art.
	// ArtworkSize controls the square pixel dimension requested from Apple CDN
	// (default 3000; Apple usually caps at 3000×3000).
	EmbedArtwork bool `json:"embedArtwork"`
	ArtworkSize  int  `json:"artworkSize"`

	// EmbedLyrics fetches synchronized lyrics (LRC) and embeds them in the
	// lyrics tag.  Also writes a .lrc sidecar file if SaveLrcSidecar is true.
	EmbedLyrics    bool   `json:"embedLyrics"`
	LrcFormat      string `json:"lrcFormat"`      // "lrc" or "ttml"
	LrcType        string `json:"lrcType"`        // "lyrics" or "syllable-lyrics"
	SaveLrcSidecar bool   `json:"saveLrcSidecar"` // write .lrc file alongside audio

	// OverwritePolicy controls what happens when the output file already exists.
	// "skip" (default) — leave the existing file untouched.
	// "overwrite"       — replace the existing file.
	// "rename"          — append a counter suffix to produce a unique name.
	OverwritePolicy string `json:"overwritePolicy"`

	// ConvertToFLAC invokes ffmpeg to convert ALAC→FLAC after tagging.
	// Requires ffmpeg to be installed and on PATH (or FFmpegPath to be set).
	// The original .m4a is removed unless KeepOriginal is true.
	ConvertToFLAC bool   `json:"convertToFlac"`
	FFmpegPath    string `json:"ffmpegPath"`
	KeepOriginal  bool   `json:"keepOriginal"`
}

// FilenameTemplate is a path template relative to OutputDir.
// Supported variables:
//
//	{title}         track title
//	{artist}        primary artist
//	{album_artist}  album artist (falls back to artist)
//	{album}         album name
//	{track_number}  track number (plain integer)
//	{track_number:02d}  zero-padded to 2 digits
//	{disc_number}   disc number
//	{year}          4-digit release year (from ReleaseDate)
//	{genre}         first genre name
//	{codec}         "alac", "aac", or "atmos"
//	{ext}           file extension without dot ("m4a", "flac", "mp4")
//
// Example:
//
//	"{album_artist}/{album}/{track_number:02d} - {title}"
//
// produces:
//
//	Taylor Swift/Fearless (Platinum Edition)/01 - Fearless.m4a
//
// The default when empty is "{album_artist}/{album}/{track_number:02d} - {title}".
type FilenameTemplate string

// ExportRequest fully describes one export job.
type ExportRequest struct {
	// Track selection
	AssetID    string `json:"assetId"`
	Storefront string `json:"storefront"`
	Token      string `json:"token"`
	MUT        string `json:"mut"` // x-apple-music-user-token
	Language   string `json:"language"`

	// What to export
	Capabilities ExportCapabilities `json:"capabilities"`

	// Where to write
	OutputDir        string           `json:"outputDir"`
	FilenameTemplate FilenameTemplate `json:"filenameTemplate"`

	// Post-processing
	Options ExportOptions `json:"options"`
}

// ExportEvent is emitted for each significant state transition and is
// forwarded to SSE clients as a JSON object.
type ExportEvent struct {
	JobID   string `json:"jobId"`
	AssetID string `json:"assetId"`
	Phase   Phase  `json:"phase"`
	Percent int    `json:"percent"` // 0–100; meaningful only in PhaseDownloading
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ExportJob is the public view of an in-flight or completed export job.
// Its fields are safe to serialise to JSON and return to API clients.
type ExportJob struct {
	ID        string    `json:"jobId"`
	AssetID   string    `json:"assetId"`
	Phase     Phase     `json:"phase"`
	Percent   int       `json:"percent"`
	Output    string    `json:"output,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`

	// cancel is called to request cancellation; not exported.
	cancel func()
}
