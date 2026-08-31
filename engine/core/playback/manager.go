// Package playback is the coordination layer between transport adapters and
// the engine internals.
//
// The Manager's job:
//  1. Ask a media.Provider to open the asset as a Session with typed Tracks.
//  2. Call Track.Open for each track to get a ready-to-run pipeline.Stream.
//  3. Attach the streams to a private playContext.
//  4. On stream requests, call pipeline.Run(ctx, stream, dst).
//
// The Manager does not know about:
//   - Apple Music, Spotify, or any specific media source
//   - HLS, DASH, manifests, or variants
//   - FairPlay, Widevine, keys, or decryption
//   - HTTP, gRPC, D-Bus, or any transport
package playback

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"sync"
	"time"

	"engine/core/apple"
	"engine/core/media"
	"engine/core/pipeline"
)

const sessionTTL = 4 * time.Hour

// OpenRequest carries everything the Manager needs to open a playback session.
// Fields map directly to media.OpenRequest; the manager is a transparent relay.
type OpenRequest struct {
	AssetID           string
	Storefront        string
	Token             string
	MUT               string
	Language          string
	Lossless          bool
	Atmos             bool
	Video             bool
	MVMaxHeight       int
	MVAudioPriorities []string
}

// Manager creates and manages playback sessions.
// It is the single entry point for all transport adapters; none of them need
// to know about the apple, fairplay, hls, or pipeline packages.
type Manager struct {
	provider media.Provider
	mu       sync.RWMutex
	sessions map[string]*Session
	contexts map[string]*playContext
}

// New returns a Manager backed by the Apple Music provider.
// Swap apple.NewProvider() for any media.Provider to change the source.
func New() *Manager {
	m := &Manager{provider: apple.NewProvider(), sessions: make(map[string]*Session), contexts: make(map[string]*playContext)}
	go m.reap()
	return m
}

// NewWithProvider returns a Manager backed by the given provider.
// Use this when the caller needs to configure the provider before wiring it
// (e.g. passing a CBCS socket address to apple.NewProviderWithCBCS).
func NewWithProvider(p media.Provider) *Manager {
	m := &Manager{provider: p, sessions: make(map[string]*Session), contexts: make(map[string]*playContext)}
	go m.reap()
	return m
}

// Open resolves the asset, opens all tracks, and returns a public Session.
// The private playContext (with pipeline.Stream state) is stored internally.
func (m *Manager) Open(ctx context.Context, req OpenRequest) (*Session, error) {
	ms, err := m.provider.Open(ctx, media.OpenRequest{
		AssetID:           req.AssetID,
		Storefront:        req.Storefront,
		Token:             req.Token,
		MUT:               req.MUT,
		Language:          req.Language,
		Lossless:          req.Lossless,
		Atmos:             req.Atmos,
		Video:             req.Video,
		MVMaxHeight:       req.MVMaxHeight,
		MVAudioPriorities: req.MVAudioPriorities,
	})
	if err != nil {
		return nil, err
	}

	sess := &Session{
		ID:           newID(),
		AssetID:      req.AssetID,
		Storefront:   req.Storefront,
		Type:         ms.Kind,
		Title:        ms.Metadata.Title,
		ArtistName:   ms.Metadata.ArtistName,
		AlbumName:    ms.Metadata.AlbumName,
		DurationMs:   ms.Metadata.DurationMs,
		ArtworkURL:   ms.Metadata.ArtworkURL,
		VideoHeights: ms.VideoHeights,
		ExpiresIn:    int(sessionTTL.Seconds()),
	}
	sess.Capabilities.Lyrics = ms.Metadata.HasLyrics
	sess.Streams.Audio = "/api/v1/playback/" + sess.ID + "/audio"

	pctx := &playContext{
		streams: make(map[pipeline.StreamKind]*pipeline.Stream),
		expiry:  time.Now().Add(sessionTTL),
	}

	for _, track := range ms.Tracks {
		stream, err := track.Open(ctx)
		if err != nil {
			return nil, fmt.Errorf("open %s stream: %w", track.Kind, err)
		}
		pctx.streams[track.Kind] = stream

		switch track.Kind {
		case pipeline.KindAudio:
			sess.Capabilities.Audio = true
			if sess.Codec == "" {
				sess.Codec = string(track.Codec)
				sess.SampleRate = track.SampleRate
				sess.BitDepth = track.BitDepth
				sess.SpatialAudio = track.SpatialAudio
			}
			_, sess.Capabilities.Seekable = stream.Source.(pipeline.SeekableSource)
		case pipeline.KindVideo:
			sess.Capabilities.Video = true
			sess.Capabilities.VideoCodec = track.CodecString
			sess.Streams.Video = "/api/v1/playback/" + sess.ID + "/video"
		}
	}

	m.store(sess, pctx)
	return sess, nil
}

// Stream pipes the decrypted media for sessionID/kind to dst.
// dst can be http.ResponseWriter, *os.File, io.PipeWriter, or anything.
func (m *Manager) Stream(ctx context.Context, sessionID string, kind pipeline.StreamKind, dst io.Writer) error {
	_, pctx, ok := m.lookup(sessionID)
	if !ok {
		return fmt.Errorf("session %s not found or expired", sessionID)
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return fmt.Errorf("session %s has no %s stream", sessionID, kind)
	}
	return pipeline.Run(ctx, stream, dst)
}

// StreamFrom starts the stream at approximately startSec seconds into the
// track and pipes it to dst through the same stages as Stream().
// Only supported for streams whose Source implements pipeline.SeekableSource
// (AAC); returns an error for other codecs.
// The returned actualStart is the actual presentation start (segment-granular,
// may be slightly earlier than startSec).
func (m *Manager) StreamFrom(ctx context.Context, sessionID string, kind pipeline.StreamKind, startSec float64, dst io.Writer) (float64, error) {
	_, pctx, ok := m.lookup(sessionID)
	if !ok {
		return 0, fmt.Errorf("session %s not found or expired", sessionID)
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return 0, fmt.Errorf("session %s has no %s stream", sessionID, kind)
	}
	seekable, ok := stream.Source.(pipeline.SeekableSource)
	if !ok {
		return 0, fmt.Errorf("session %s stream is not seekable", sessionID)
	}
	seekSource, actualStart := seekable.SourceFrom(startSec)
	seekStream := &pipeline.Stream{
		Source: seekSource,
		Stages: stream.Stages,
		Kind:   stream.Kind,
		Codec:  stream.Codec,
	}
	return actualStart, pipeline.Run(ctx, seekStream, dst)
}

// GetSession returns the public Session descriptor for the given ID.
func (m *Manager) GetSession(id string) (*Session, bool) {
	sess, _, ok := m.lookup(id)
	return sess, ok
}

// GetSeekStart returns the segment-granular actual start time for the given
// seek offset, computed from the session's already-fetched playlist.
// This is the same computation StreamFrom performs, exposed separately so
// callers can set response headers before streaming begins.
// Returns (0, false) if the session doesn't exist or the stream is not seekable.
func (m *Manager) GetSeekStart(id string, kind pipeline.StreamKind, startSec float64) (float64, bool) {
	_, pctx, ok := m.lookup(id)
	if !ok {
		return 0, false
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return 0, false
	}
	seekable, ok := stream.Source.(pipeline.SeekableSource)
	if !ok {
		return 0, false
	}
	_, actual := seekable.SourceFrom(startSec)
	return actual, true
}

// Release deletes a session and its private context.
func (m *Manager) Release(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	delete(m.contexts, id)
	m.mu.Unlock()
}

// ── Internal ──────────────────────────────────────────────────────────────────

func (m *Manager) store(sess *Session, pctx *playContext) {
	m.mu.Lock()
	if m.sessions == nil {
		m.sessions = make(map[string]*Session)
		m.contexts = make(map[string]*playContext)
	}
	m.contexts[sess.ID] = pctx // context first — lookup won't see the session without its context
	m.sessions[sess.ID] = sess
	m.mu.Unlock()
}

func (m *Manager) lookup(id string) (*Session, *playContext, bool) {
	m.mu.RLock()
	pctx, ok := m.contexts[id]
	if !ok {
		m.mu.RUnlock()
		return nil, nil, false
	}
	sess := m.sessions[id]
	m.mu.RUnlock()
	if time.Now().After(pctx.expiry) {
		m.Release(id)
		return nil, nil, false
	}
	return sess, pctx, true
}

func (m *Manager) reap() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		m.mu.Lock()
		for id, pctx := range m.contexts {
			if now.After(pctx.expiry) {
				delete(m.sessions, id)
				delete(m.contexts, id)
			}
		}
		m.mu.Unlock()
	}
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}
