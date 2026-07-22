// Package pipeline defines the foundational types of the media engine.
//
// A pipeline is:
//
//	Source → Stage → Stage → Stage → io.Writer
//
// Source produces encrypted bytes. Each Stage reads from the previous and
// writes to the next. The final Stage writes to whatever io.Writer the caller
// provides: http.ResponseWriter, os.File, io.Pipe, FFmpeg stdin — anything.
//
// The Decrypt stage is just a Stage. Transcode is just a Stage. Repair,
// remux, gain normalisation — all Stages. Adding a new processing step never
// changes the pipeline interface.
//
// Stream bundles a Source, its Stages, and the stream's type metadata so that
// Run(ctx, stream, dst) is the only call site needed at every layer above.
package pipeline

import (
	"context"
	"io"
)

// ── Stream type metadata ───────────────────────────────────────────────────────

// StreamKind identifies the media track that a stream carries.
// Callers use this to request a specific track from a session rather than
// relying on separate StreamAudio/StreamVideo methods.
type StreamKind int

const (
	KindAudio    StreamKind = iota // primary audio (ALAC, AAC, Atmos)
	KindVideo                      // video track (H.264, HEVC)
	KindSubtitle                   // subtitle / caption track
	KindChapter                    // chapter markers
	KindPreview                    // short preview clip
)

func (k StreamKind) String() string {
	switch k {
	case KindAudio:
		return "audio"
	case KindVideo:
		return "video"
	case KindSubtitle:
		return "subtitle"
	case KindChapter:
		return "chapter"
	case KindPreview:
		return "preview"
	default:
		return "unknown"
	}
}

// Codec identifies the stream's output format.
// For streams with a Decrypt stage, this is the codec inside the fMP4.
// For transcoded streams, this is the transcoded format.
type Codec string

const (
	CodecALAC  Codec = "alac"
	CodecAAC   Codec = "aac"
	CodecAtmos Codec = "atmos"
	CodecH264  Codec = "h264"
	CodecHEVC  Codec = "hevc"
	CodecFLAC  Codec = "flac" // transcoded output
	CodecOpus  Codec = "opus" // transcoded output
)

// ── Interfaces ────────────────────────────────────────────────────────────────

// Source assembles a complete encrypted byte stream and writes it to w.
// It handles segment fetching, ordering, caching, and retry internally.
// It never touches key material.
type Source interface {
	Stream(ctx context.Context, w io.Writer) error
}

// SeekableSource is an optional extension of Source that can produce a new
// Source starting at an approximate time offset.  Seeking is segment-granular:
// actualStart is the presentation timestamp of the first segment, which may be
// slightly earlier than startSec.  The returned Source uses the same transport
// and must be run through the same Stages as the original stream.
type SeekableSource interface {
	Source
	SourceFrom(startSec float64) (source Source, actualStart float64)
}

// Decryptor decrypts an encrypted fMP4 stream into clear output.
// It is the sole holder of key bytes anywhere in the engine.
// Only engine/fairplay creates Decryptors; everything else uses this interface.
type Decryptor interface {
	Decrypt(ctx context.Context, r io.Reader, w io.Writer) error
}

// Stage is one transformation step in the pipeline.
// Each Stage reads from r (the previous stage's output) and writes to w.
// Stages are composable: adding a new processing step is adding a new Stage.
type Stage interface {
	Process(ctx context.Context, r io.Reader, w io.Writer) error
}

// HeaderWriter is an optional interface for io.Writers that can receive HTTP headers.
// Sources (like cbcsSource) can use this to propagate Content-Length to the client.
type HeaderWriter interface {
	io.Writer
	SetHeader(key, value string)
}

// ── Built-in stages ───────────────────────────────────────────────────────────

// DecryptStage wraps a Decryptor as a Stage.
// It is the only Stage that creates or touches key material.
func DecryptStage(dec Decryptor) Stage { return &decryptStage{dec: dec} }

type decryptStage struct{ dec Decryptor }

func (d *decryptStage) Process(ctx context.Context, r io.Reader, w io.Writer) error {
	return d.dec.Decrypt(ctx, r, w)
}

// ── Stream ────────────────────────────────────────────────────────────────────

// Stream is a complete, self-contained media stream ready to run.
// It carries type metadata (Kind, Codec) alongside the processing chain.
// Every layer above pipeline deals only with *Stream values.
//
// Kind and Codec are set by the Provider that built the Track (e.g.
// apple.AppleMusicProvider), not by the DRM layer, because the Provider
// knows what the content is and the DRM layer does not.
type Stream struct {
	Source Source
	Stages []Stage
	Kind   StreamKind
	Codec  Codec
}

// ── Seek context ─────────────────────────────────────────────────────────────

// seekActualStartKey is the context key for the actual segment start time on
// the seek path. PassthroughStreaming reads this to seed the tfdt accumulator
// at the correct song position instead of from the native (segment-relative) 0.
type seekActualStartKey struct{}

// ContextWithActualStart returns a child context that carries the actual start
// time (seconds) of the first segment in a seek stream.
func ContextWithActualStart(ctx context.Context, sec float64) context.Context {
	return context.WithValue(ctx, seekActualStartKey{}, sec)
}

// ActualStartFromContext extracts the seek actual-start set by ContextWithActualStart.
// Returns (0, false) if not set.
func ActualStartFromContext(ctx context.Context) (float64, bool) {
	v, ok := ctx.Value(seekActualStartKey{}).(float64)
	return v, ok
}

// seekTargetKey carries the user-requested seek time so PassthroughStreaming
// can drop leading fragments before that position (sub-segment accuracy).
type seekTargetKey struct{}

func ContextWithSeekTarget(ctx context.Context, sec float64) context.Context {
	return context.WithValue(ctx, seekTargetKey{}, sec)
}

func SeekTargetFromContext(ctx context.Context) (float64, bool) {
	v, ok := ctx.Value(seekTargetKey{}).(float64)
	return v, ok
}

// Run executes the stream pipeline into dst.
// It chains: Source → Stages[0] → Stages[1] → … → dst
// and blocks until the pipeline completes or ctx is cancelled.
//
//	dst = http.ResponseWriter  → live playback
//	dst = os.File              → download to disk
//	dst = io.PipeWriter        → feed another process (FFmpeg, etc.)
func Run(ctx context.Context, stream *Stream, dst io.Writer) error {
	return runChain(ctx, stream.Source, stream.Stages, dst)
}

// runChain recursively chains stages with io.Pipes.
// The last stage writes directly to dst; all earlier stages write to pipes
// that become the next stage's reader.
func runChain(ctx context.Context, src Source, stages []Stage, dst io.Writer) error {
	if len(stages) == 0 {
		return src.Stream(ctx, dst)
	}

	// Feed the first N-1 stages through a pipe into the last stage.
	pr, pw := io.Pipe()
	go func() {
		var err error
		if len(stages) == 1 {
			err = src.Stream(ctx, pw)
		} else {
			err = runChain(ctx, src, stages[:len(stages)-1], pw)
		}
		if err != nil {
			pw.CloseWithError(err)
		} else {
			pw.Close()
		}
	}()
	return stages[len(stages)-1].Process(ctx, pr, dst)
}
