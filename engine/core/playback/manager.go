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
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"engine/core/apple"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/internal/randid"
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

// openFlight deduplicates concurrent Open calls for the same asset.
// If two callers race for the same (assetID, storefront, codec) combination,
// the second waits for the first and receives the same Session — preventing
// duplicate DRM sessions from being opened and orphaned.
type openFlight struct {
	done chan struct{}
	sess *Session
	err  error
}

// Manager creates and manages playback sessions.
// It is the single entry point for all transport adapters; none of them need
// to know about the apple, fairplay, hls, or pipeline packages.
type Manager struct {
	provider   media.Provider
	mu         sync.RWMutex
	sessions   map[string]*Session
	contexts   map[string]*playContext
	assetIndex map[string]string // openKey → sessionID; secondary index for resume reuse
	inflightMu sync.Mutex
	inflight   map[string]*openFlight // key: assetID+storefront+capabilities

	// activeStreams counts pipeline.Run calls currently pulling bytes from Apple
	// for real playback. Background cache-warming consults it so it never
	// competes for bandwidth with the stream the user is actually listening to
	// — the same rule Apple's Android client applies in
	// PlayerLoadControl.shouldPrepareNextPeriodForCaching, which pre-caches the
	// next queue item only when the current period is NOT reading from network.
	activeStreams atomic.Int64
}

// IsStreaming reports whether any playback stream is currently pulling from the
// network. Used to defer background prefetch while real playback is in flight.
func (m *Manager) IsStreaming() bool { return m.activeStreams.Load() > 0 }

// ActiveStreams returns the number of in-flight playback streams (for metrics).
func (m *Manager) ActiveStreams() int { return int(m.activeStreams.Load()) }

// New returns a Manager backed by the Apple Music provider.
// Swap apple.NewProvider() for any media.Provider to change the source.
func New() *Manager {
	m := &Manager{provider: apple.NewProvider(), sessions: make(map[string]*Session), contexts: make(map[string]*playContext), assetIndex: make(map[string]string), inflight: make(map[string]*openFlight)}
	go m.reap()
	return m
}

// NewWithProvider returns a Manager backed by the given provider.
// Use this when the caller needs to configure the provider before wiring it
// (e.g. passing a CBCS socket address to apple.NewProviderWithCBCS).
func NewWithProvider(p media.Provider) *Manager {
	m := &Manager{provider: p, sessions: make(map[string]*Session), contexts: make(map[string]*playContext), assetIndex: make(map[string]string), inflight: make(map[string]*openFlight)}
	go m.reap()
	return m
}

// openKey builds a deduplication key from the fields that determine whether
// two Open calls would produce the same session type.
func openKey(req OpenRequest) string {
	flags := fmt.Sprintf("%v:%v:%v:%d", req.Lossless, req.Atmos, req.Video, req.MVMaxHeight)
	return req.AssetID + ":" + req.Storefront + ":" + flags
}

// Open resolves the asset, opens all tracks, and returns a public Session.
// The private playContext (with pipeline.Stream state) is stored internally.
//
// Concurrent calls for the same (assetID, storefront, capabilities) key are
// deduplicated: the second caller waits for the first to finish and receives
// the same Session, preventing orphaned DRM sessions.
func (m *Manager) Open(ctx context.Context, req OpenRequest) (*Session, error) {
	key := openKey(req)

	// Reuse an existing valid session for this asset+capabilities combination.
	// Mirrors Android SVFootHillSessionController.getExistingContextKey — avoids
	// a full DRM round-trip when the user pauses and resumes the same track.
	if sess := m.getByAssetKey(key); sess != nil {
		return sess, nil
	}

	m.inflightMu.Lock()
	if m.inflight == nil {
		m.inflight = make(map[string]*openFlight)
	}
	if fl, ok := m.inflight[key]; ok {
		// A concurrent call is already opening this asset — join it.
		m.inflightMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-fl.done:
			return fl.sess, fl.err
		}
	}
	fl := &openFlight{done: make(chan struct{})}
	m.inflight[key] = fl
	m.inflightMu.Unlock()

	// We are the leader: open the session, then signal all waiters.
	fl.sess, fl.err = m.openDirect(ctx, req, key)
	close(fl.done)
	m.inflightMu.Lock()
	delete(m.inflight, key)
	m.inflightMu.Unlock()
	return fl.sess, fl.err
}

func (m *Manager) openDirect(ctx context.Context, req OpenRequest, assetKey string) (*Session, error) {
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
		MVMaxHeight:  req.MVMaxHeight,
		ExpiresIn:    int(sessionTTL.Seconds()),
	}
	sess.Capabilities.Lyrics = ms.Metadata.HasLyrics
	sess.Streams.Audio = "/api/v1/playback/" + sess.ID + "/audio"

	pctx := &playContext{
		streams:          make(map[pipeline.StreamKind]*pipeline.Stream),
		expiry:           time.Now().Add(sessionTTL),
		mvProgressiveURL: ms.MVProgressiveURL,
		mvDownloadKey:    ms.MVDownloadKey,
	}

	log.Printf("[openDirect] %s: provider returned %d tracks", req.AssetID, len(ms.Tracks))
	for _, track := range ms.Tracks {
		log.Printf("[openDirect] %s: calling track.Open kind=%s", req.AssetID, track.Kind)
		stream, err := track.Open(ctx)
		if err != nil {
			log.Printf("[openDirect] %s: track.Open kind=%s FAILED: %v", req.AssetID, track.Kind, err)
			return nil, fmt.Errorf("open %s stream: %w", track.Kind, err)
		}
		log.Printf("[openDirect] %s: track.Open kind=%s OK", req.AssetID, track.Kind)
		pctx.streams[track.Kind] = stream

		switch track.Kind {
		case pipeline.KindAudio:
			sess.Capabilities.Audio = true
			if sess.Codec == "" {
				sess.Codec = string(track.Codec)
				sess.SampleRate = track.SampleRate
				sess.BitDepth = track.BitDepth
				sess.BitRate = track.BitRate
				sess.ChannelCount = track.ChannelCount
				sess.CodecMIMEType = track.CodecMIMEType
				sess.SpatialAudio = track.SpatialAudio
			}
			_, sess.Capabilities.Seekable = stream.Source.(pipeline.SeekableSource)
		case pipeline.KindVideo:
			sess.Capabilities.Video = true
			sess.Capabilities.VideoCodec = track.CodecString
			sess.Streams.Video = "/api/v1/playback/" + sess.ID + "/video"
		}
	}

	m.store(assetKey, sess, pctx)
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
	m.activeStreams.Add(1)
	defer m.activeStreams.Add(-1)
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
	m.activeStreams.Add(1)
	defer m.activeStreams.Add(-1)
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

// GetProgressiveURL returns the raw CDN URL for the video stream if its
// underlying Source implements pipeline.URLSource (i.e. it is an mvod
// progressive source). Returns ("", false) for HLS-based streams.
func (m *Manager) GetProgressiveURL(id string, kind pipeline.StreamKind) (string, bool) {
	_, pctx, ok := m.lookup(id)
	if !ok {
		return "", false
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return "", false
	}
	us, ok := stream.Source.(pipeline.URLSource)
	if !ok {
		return "", false
	}
	return us.SourceURL(), true
}

// GetMVProgressiveInfo returns the progressive CDN URL and downloadKey cookie
// token for an MV session. Both are empty strings when unavailable.
func (m *Manager) GetMVProgressiveInfo(id string) (url, key string, ok bool) {
	_, pctx, found := m.lookup(id)
	if !found {
		return "", "", false
	}
	return pctx.mvProgressiveURL, pctx.mvDownloadKey, pctx.mvProgressiveURL != ""
}

// Release deletes a session and its private context.
func (m *Manager) Release(id string) {
	m.mu.Lock()
	if sess, ok := m.sessions[id]; ok {
		// Remove from asset index so the next Open for this asset re-opens DRM.
		for k, v := range m.assetIndex {
			if v == sess.ID {
				delete(m.assetIndex, k)
				break
			}
		}
	}
	delete(m.sessions, id)
	delete(m.contexts, id)
	m.mu.Unlock()
}

// ── Internal ──────────────────────────────────────────────────────────────────

// getByAssetKey returns a live session for the given asset key, or nil if none exists.
func (m *Manager) getByAssetKey(assetKey string) *Session {
	m.mu.RLock()
	sessID, ok := m.assetIndex[assetKey]
	if !ok {
		m.mu.RUnlock()
		return nil
	}
	pctx, ok := m.contexts[sessID]
	if !ok || time.Now().After(pctx.expiry) {
		m.mu.RUnlock()
		return nil
	}
	sess := m.sessions[sessID]
	m.mu.RUnlock()
	return sess
}

func (m *Manager) store(assetKey string, sess *Session, pctx *playContext) {
	m.mu.Lock()
	if m.sessions == nil {
		m.sessions = make(map[string]*Session)
		m.contexts = make(map[string]*playContext)
		m.assetIndex = make(map[string]string)
	}
	m.contexts[sess.ID] = pctx // context first — lookup won't see the session without its context
	m.sessions[sess.ID] = sess
	if assetKey != "" {
		m.assetIndex[assetKey] = sess.ID
	}
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
	expired := time.Now().After(pctx.expiry)
	m.mu.RUnlock()
	if expired {
		// Upgrade to write lock and re-check before deleting — the reaper may
		// have already removed the entry between the RUnlock and here.
		m.mu.Lock()
		if _, still := m.contexts[id]; still {
			delete(m.sessions, id)
			delete(m.contexts, id)
		}
		m.mu.Unlock()
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
		// Sweep asset index: remove entries pointing to sessions that no longer exist.
		for k, sessID := range m.assetIndex {
			if _, ok := m.sessions[sessID]; !ok {
				delete(m.assetIndex, k)
			}
		}
		m.mu.Unlock()
	}
}

func newID() string { return randid.New() }
