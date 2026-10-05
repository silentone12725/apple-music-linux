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
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"engine/core/media"
	"engine/core/pipeline"
)

const sessionTTL = 4 * time.Hour

// touchEvery is how often use of a session pushes its expiry back out.
const touchEvery = 5 * time.Minute

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

	// Private opens a session owned exclusively by the caller: it never reuses
	// an existing session, never joins a concurrent Open for the same asset,
	// and is never indexed for reuse by later Opens. Exports use this so their
	// Release can never delete a session that playback is still serving.
	Private bool
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
	provider       media.Provider
	mu             sync.RWMutex
	sessions       map[string]*Session
	contexts       map[string]*playContext
	assetIndex     map[string]string // openKey → sessionID; secondary index for resume reuse
	sessionToAsset map[string]string // sessionID → openKey; reverse of assetIndex for O(1) Release
	inflightMu     sync.Mutex
	inflight       map[string]*openFlight // key: assetID+storefront+capabilities

	// activeStreams counts every in-flight pipeline.Run, foreground and
	// background alike (for metrics).
	activeStreams atomic.Int64

	// fgActive counts Foreground streams — real playback. Background
	// cache-warming consults it so it never competes for bandwidth with the
	// stream the user is actually listening to — the same rule Apple's Android
	// client applies in PlayerLoadControl.shouldPrepareNextPeriodForCaching,
	// which pre-caches the next queue item only when the current period is NOT
	// reading from network. Background streams (exports) are excluded so they
	// never make prefetch believe playback is active.
	fgActive atomic.Int64
	// fgBytes is the cumulative number of bytes written by Foreground streams.
	fgBytes atomic.Int64
	// fgNeedBps is the sum of the required rates of active Foreground streams.
	fgNeedBps atomic.Int64

	// releaseHook is told about every session that is removed — released, expired on
	// lookup or swept by the reaper — so owners of per-session resources (producers,
	// scratch files) can free them. Called outside m.mu.
	hookMu      sync.Mutex
	releaseHook func(sessionID string)
	released    []string // removed sessions not yet reported to the hook (guarded by mu)
}

// Class tells the Manager who a stream is for. It is carried on the context
// passed to Stream/StreamFrom; the zero value is Foreground.
type Class int

const (
	// Foreground is real playback: it owns the bandwidth budget.
	Foreground Class = iota
	// Background is opportunistic work (exports) that must yield to playback.
	Background
)

type classKey struct{}

// WithClass returns a child context that tags streams run with it as class c.
func WithClass(ctx context.Context, c Class) context.Context {
	return context.WithValue(ctx, classKey{}, c)
}

func classFrom(ctx context.Context) Class {
	c, _ := ctx.Value(classKey{}).(Class)
	return c
}

// Fallback required rates when a session does not report its bit-rate.
const (
	defaultAudioNeedBps = 1_500_000 / 8 // ~1.5 Mb/s in bytes/s
	defaultVideoNeedBps = 8_000_000 / 8 // ~8 Mb/s in bytes/s
)

// IsStreaming reports whether any Foreground (playback) stream is currently
// pulling from the network. Used to defer background prefetch while real
// playback is in flight. Background streams never make this true.
func (m *Manager) IsStreaming() bool { return m.fgActive.Load() > 0 }

// ActiveStreams returns the number of in-flight streams of every class (for metrics).
func (m *Manager) ActiveStreams() int { return int(m.activeStreams.Load()) }

// ForegroundStats returns a snapshot of Foreground stream instrumentation:
//
//   - active:  number of Foreground streams currently running
//   - bytes:   cumulative bytes written by Foreground streams (monotonic)
//   - needBps: sum of the required rates (bytes/s) of the active streams
//
// It deliberately returns raw counters, never a rate: measuring throughput is
// the caller's job (see export's bandwidth controller).
func (m *Manager) ForegroundStats() (active int, bytes int64, needBps int64) {
	return int(m.fgActive.Load()), m.fgBytes.Load(), m.fgNeedBps.Load()
}

// beginStream registers one stream for its whole lifetime and returns the
// writer to run the pipeline into plus a func that must be deferred to
// unregister it (including on error paths).
func (m *Manager) beginStream(ctx context.Context, sess *Session, kind pipeline.StreamKind, dst io.Writer) (io.Writer, func()) {
	m.activeStreams.Add(1)
	if classFrom(ctx) == Background {
		return dst, func() { m.activeStreams.Add(-1) }
	}
	need := int64(defaultAudioNeedBps)
	if kind == pipeline.KindVideo {
		need = defaultVideoNeedBps
	} else if sess != nil && sess.BitRate > 0 {
		need = int64(sess.BitRate) / 8
	}
	m.fgActive.Add(1)
	m.fgNeedBps.Add(need)
	end := func() {
		m.fgNeedBps.Add(-need)
		m.fgActive.Add(-1)
		m.activeStreams.Add(-1)
	}
	cw := countingWriter{w: dst, n: &m.fgBytes}
	if hw, ok := dst.(pipeline.HeaderWriter); ok {
		return countingHeaderWriter{countingWriter: cw, hw: hw}, end
	}
	return cw, end
}

// countingWriter adds every byte written to n.
type countingWriter struct {
	w io.Writer
	n *atomic.Int64
}

func (c countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n.Add(int64(n))
	return n, err
}

// countingHeaderWriter preserves pipeline.HeaderWriter so sources can still
// propagate Content-Length through the counting wrapper.
type countingHeaderWriter struct {
	countingWriter
	hw pipeline.HeaderWriter
}

func (c countingHeaderWriter) SetHeader(k, v string) { c.hw.SetHeader(k, v) }

// NewWithProvider returns a Manager backed by the given provider.
// Use this when the caller needs to configure the provider before wiring it
// (e.g. passing a CBCS socket address to apple.NewProviderWithCBCS).
func NewWithProvider(p media.Provider) *Manager {
	m := &Manager{
		provider:       p,
		sessions:       make(map[string]*Session),
		contexts:       make(map[string]*playContext),
		assetIndex:     make(map[string]string),
		sessionToAsset: make(map[string]string),
		inflight:       make(map[string]*openFlight),
	}
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
	if req.Private {
		return m.openDirect(ctx, req, "")
	}
	key := openKey(req)

	for {
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
			}
			// The leader's own caller went away (e.g. a skipped track's request).
			// That cancellation is not ours: retry, possibly as the new leader.
			if errors.Is(fl.err, context.Canceled) && ctx.Err() == nil {
				continue
			}
			return fl.sess, fl.err
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
		mvFetchedAt:      time.Now(),
	}

	for _, track := range ms.Tracks {
		stream, err := track.Open(ctx)
		if err != nil {
			log.Printf("[openDirect] %s: track.Open kind=%s FAILED: %v", req.AssetID, track.Kind, err)
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
	log.Printf("[playback] Stream START: session=%s kind=%s", sessionID, kind)
	sess, pctx, ok := m.lookup(sessionID)
	if !ok {
		log.Printf("[playback] Stream lookup FAILED: session=%s", sessionID)
		return fmt.Errorf("session %s not found or expired", sessionID)
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		log.Printf("[playback] Stream no stream: session=%s kind=%s", sessionID, kind)
		return fmt.Errorf("session %s has no %s stream", sessionID, kind)
	}
	log.Printf("[playback] Stream found stream: session=%s kind=%s source=%T", sessionID, kind, stream.Source)
	dst, end := m.beginStream(ctx, sess, kind, dst)
	defer end()
	err := pipeline.Run(ctx, stream, dst)
	log.Printf("[playback] Stream END: session=%s err=%v", sessionID, err)
	return err
}

// StreamFrom starts the stream at approximately startSec seconds into the
// track and pipes it to dst through the same stages as Stream().
// Only supported for streams whose Source implements pipeline.SeekableSource
// (AAC); returns an error for other codecs.
// The returned actualStart is the actual presentation start (segment-granular,
// may be slightly earlier than startSec).
func (m *Manager) StreamFrom(ctx context.Context, sessionID string, kind pipeline.StreamKind, startSec float64, dst io.Writer) (float64, error) {
	sess, pctx, ok := m.lookup(sessionID)
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
	dst, end := m.beginStream(ctx, sess, kind, dst)
	defer end()
	return actualStart, pipeline.Run(ctx, seekStream, dst)
}

// PrepareDirectSeek plans a fragment-level seek for the session's stream. It returns
// pipeline.ErrNoDirectSeek-style errors from the source unchanged, so callers can fall
// back to StreamFrom. The returned Source must be run with StreamSource.
func (m *Manager) PrepareDirectSeek(ctx context.Context, sessionID string, kind pipeline.StreamKind, startSec float64) (pipeline.Source, pipeline.DirectInfo, error) {
	_, pctx, ok := m.lookup(sessionID)
	if !ok {
		return nil, pipeline.DirectInfo{}, fmt.Errorf("session %s not found or expired", sessionID)
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return nil, pipeline.DirectInfo{}, fmt.Errorf("session %s has no %s stream", sessionID, kind)
	}
	direct, ok := stream.Source.(pipeline.DirectSeekable)
	if !ok {
		return nil, pipeline.DirectInfo{}, fmt.Errorf("session %s stream has no fragment-level seek", sessionID)
	}
	return direct.DirectSourceFrom(ctx, startSec)
}

// StreamSource runs src — typically from PrepareDirectSeek — through the session
// stream's stages (decrypt) into dst.
func (m *Manager) StreamSource(ctx context.Context, sessionID string, kind pipeline.StreamKind, src pipeline.Source, dst io.Writer) error {
	sess, pctx, ok := m.lookup(sessionID)
	if !ok {
		return fmt.Errorf("session %s not found or expired", sessionID)
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return fmt.Errorf("session %s has no %s stream", sessionID, kind)
	}
	st := &pipeline.Stream{Source: src, Stages: stream.Stages, Kind: stream.Kind, Codec: stream.Codec}
	dst, end := m.beginStream(ctx, sess, kind, dst)
	defer end()
	return pipeline.Run(ctx, st, dst)
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

// GetSegmentTimings returns the cumulative HLS segment start times for the
// given stream if its Source implements pipeline.SegmentTimingSource.
// Entry i is the presentation start time (seconds) of HLS segment i.
// Returns (nil, false) if the session/stream doesn't exist or lacks timing data.
func (m *Manager) GetSegmentTimings(id string, kind pipeline.StreamKind) ([]float64, bool) {
	_, pctx, ok := m.lookup(id)
	if !ok {
		return nil, false
	}
	stream, ok := pctx.streams[kind]
	if !ok {
		return nil, false
	}
	ts, ok := stream.Source.(pipeline.SegmentTimingSource)
	if !ok {
		return nil, false
	}
	return ts.SegmentTimings(), true
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
	// Read under m.mu: UpdateMVProgressiveInfo writes these fields under it.
	m.mu.RLock()
	url, key = pctx.mvProgressiveURL, pctx.mvDownloadKey
	m.mu.RUnlock()
	return url, key, url != ""
}

// MVProgressiveAge returns how long ago the progressive URL/key were fetched.
// Returns (0, false) if the session doesn't exist or has no progressive info.
func (m *Manager) MVProgressiveAge(id string) (time.Duration, bool) {
	_, pctx, ok := m.lookup(id)
	if !ok {
		return 0, false
	}
	m.mu.RLock()
	url, fetchedAt := pctx.mvProgressiveURL, pctx.mvFetchedAt
	m.mu.RUnlock()
	if url == "" {
		return 0, false
	}
	return time.Since(fetchedAt), true
}

// UpdateMVProgressiveInfo replaces the stored progressive CDN URL and
// downloadKey for an existing session. Called by the handler layer when the
// URL/key have expired and a fresh pair has been obtained from the DRM backend.
func (m *Manager) UpdateMVProgressiveInfo(id, url, key string) {
	m.mu.Lock()
	if pctx, ok := m.contexts[id]; ok {
		pctx.mvProgressiveURL = url
		pctx.mvDownloadKey = key
		pctx.mvFetchedAt = time.Now()
	}
	m.mu.Unlock()
}

// Release deletes a session and its private context.
func (m *Manager) Release(id string) {
	m.mu.Lock()
	m.deleteLocked(id)
	m.mu.Unlock()
	m.drainReleased()
}

// SetReleaseHook registers fn to be called, outside the manager's lock, with the ID of
// every session that goes away for any reason. Only one hook is kept.
func (m *Manager) SetReleaseHook(fn func(sessionID string)) {
	m.hookMu.Lock()
	m.releaseHook = fn
	m.hookMu.Unlock()
}

// drainReleased reports sessions removed since the last call to the release hook.
func (m *Manager) drainReleased() {
	m.mu.Lock()
	ids := m.released
	m.released = nil
	m.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	m.hookMu.Lock()
	fn := m.releaseHook
	m.hookMu.Unlock()
	if fn == nil {
		return
	}
	for _, id := range ids {
		fn(id)
	}
}

// deleteLocked removes a session and every index entry pointing at it. All
// removal paths (Release, lookup expiry, reaper) go through here so the
// secondary maps can never outlive their session. Caller holds m.mu.
func (m *Manager) deleteLocked(id string) {
	if _, ok := m.contexts[id]; ok {
		m.released = append(m.released, id)
	}
	// O(1) reverse-map lookup to remove from assetIndex without scanning.
	if assetKey, ok := m.sessionToAsset[id]; ok {
		// Only drop the index entry if it still points at this session: a newer
		// session for the same key may have replaced it.
		if m.assetIndex[assetKey] == id {
			delete(m.assetIndex, assetKey)
		}
		delete(m.sessionToAsset, id)
	}
	delete(m.sessions, id)
	delete(m.contexts, id)
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
		m.sessionToAsset = make(map[string]string)
	}
	if m.sessionToAsset == nil {
		m.sessionToAsset = make(map[string]string)
	}
	m.contexts[sess.ID] = pctx // context first — lookup won't see the session without its context
	m.sessions[sess.ID] = sess
	if assetKey != "" {
		m.assetIndex[assetKey] = sess.ID
		m.sessionToAsset[sess.ID] = assetKey
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
	now := time.Now()
	expired := now.After(pctx.expiry)
	stale := !expired && pctx.expiry.Sub(now) < sessionTTL-touchEvery
	m.mu.RUnlock()
	if expired {
		// Upgrade to write lock and re-check before deleting — the reaper may
		// have already removed the entry between the RUnlock and here.
		m.mu.Lock()
		if pctx, still := m.contexts[id]; still && time.Now().After(pctx.expiry) {
			m.deleteLocked(id)
		}
		m.mu.Unlock()
		m.drainReleased()
		return nil, nil, false
	}
	if stale {
		// Sliding expiry: a session someone keeps using must not die at a fixed deadline
		// in the middle of a long listen. Refreshed at most once per touchEvery.
		m.mu.Lock()
		if p, still := m.contexts[id]; still {
			p.expiry = time.Now().Add(sessionTTL)
		}
		m.mu.Unlock()
	}
	return sess, pctx, true
}

func (m *Manager) reap() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		m.sweepExpired(time.Now())
	}
}

// sweepExpired removes every session expired at now, with its index entries.
func (m *Manager) sweepExpired(now time.Time) {
	m.mu.Lock()
	for id, pctx := range m.contexts {
		if now.After(pctx.expiry) {
			m.deleteLocked(id)
		}
	}
	m.mu.Unlock()
	m.drainReleased()
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}
