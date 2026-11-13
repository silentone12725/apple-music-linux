package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/core/playback"
	"engine/core/prefetch"
	"engine/internal/vlog"
)

// parseRangeStart extracts the start offset from an HTTP Range header value.
// Handles "bytes=X-" and "bytes=X-Y". Returns 0 for unrecognised formats.
func parseRangeStart(rangeHdr string) int64 {
	s, ok := strings.CutPrefix(rangeHdr, "bytes=")
	if !ok {
		return 0
	}
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		s = s[:idx]
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// Status codes must match as whole numbers: open errors carry catalog IDs
// (e.g. 1502443) that contain "502" or "404" as substrings.
var (
	serverErrStatusRe = regexp.MustCompile(`\b50[0-4]\b`)
	notFoundStatusRe  = regexp.MustCompile(`\b404\b`)
)

// isNotFoundFailure reports whether a session-open error is a per-track content
// failure — the asset does not exist, or is not available in this storefront.
// These are addressed to one track and must not be reported as a server outage.
func isNotFoundFailure(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	// Check transport markers first: "503 Service Unavailable" is an outage, not a
	// missing track, and must not be captured by the content patterns below.
	if serverErrStatusRe.MatchString(s) || strings.Contains(s, "timeout") || strings.Contains(s, "connection") {
		return false
	}
	if notFoundStatusRe.MatchString(s) {
		return true
	}
	// "no such host" is DNS and belongs to isTransportFailure, so it is deliberately
	// absent here.
	for _, needle := range []string{
		"not found", "no playable",
		"no video variant", "no audio alternative",
	} {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

// isTransportFailure reports whether a session-open error indicates that Apple's
// servers (or the network path to them) are actually unreachable, as opposed to a
// per-track content problem. Only these may trip the session-open circuit breaker.
func isTransportFailure(err error) bool {
	if err == nil {
		return false
	}
	if isNotFoundFailure(err) {
		return false
	}
	// context.Canceled means the *client* went away (user skipped) — not an outage.
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	s := strings.ToLower(err.Error())
	for _, needle := range []string{
		"connection refused", "connection reset", "no such host", "network is unreachable",
		"i/o timeout", "timeout", "eof", "tls", "dial tcp", "broken pipe",
	} {
		if strings.Contains(s, needle) {
			return true
		}
	}
	if serverErrStatusRe.MatchString(s) {
		return true
	}
	// Unclassified: treat as content-level so an unknown per-track error can never
	// lock out the whole app. A genuine outage always surfaces one of the above.
	return false
}

func (s *APIServer) handleCreatePlayback(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10) // 64 KB
	var req PlaybackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.AssetID == "" {
		http.Error(w, "assetId is required", http.StatusBadRequest)
		return
	}

	// Prefer request-level tokens (supplied by the browser renderer from MusicKit)
	// over the cached token so that the renderer's live session is always used.
	token := req.Token
	if token == "" {
		token = s.token()
	}
	mut := req.MUT
	if mut == "" {
		// musicUserToken() checks the in-memory MK token pushed at startup via
		// POST /api/v1/library/token before falling back to the MUSIC_TOKEN file.
		// This lets lossless work from the web-player session without any DRM file.
		mut = s.musicUserToken()
	}
	if token == "" || mut == "" {
		http.Error(w, "not authenticated — provide token+mediaUserToken in request body or configure them", http.StatusUnauthorized)
		return
	}
	s.setToken(token)
	// Also update the MK music user token used by library API calls.
	// req.MUT is the media-user-token cookie from the web session — the correct
	// web-auth Music-User-Token paired with the web developer JWT above.
	s.setMusicUserToken(mut)

	sf := req.Storefront
	if sf == "" {
		sf = s.storefront()
	}

	// Use a pre-warmed session if the prefetch scheduler already opened one
	// for this asset at the matching quality tier. This skips the webplayback
	// API round-trip (~1–3 s) and lets playback start immediately. Lossless
	// and AAC sessions are tracked separately — the scheduler now pre-warms
	// at whichever quality the renderer reported via ContextPayload.Lossless.
	var sess *playback.Session
	if !req.Capabilities.Atmos && !req.Capabilities.Video {
		if sessionID, ok := s.scheduler.TakePreWarmed(req.AssetID, req.Capabilities.Lossless); ok {
			if preOpened, found := s.pm.GetSession(sessionID); found {
				sess = preOpened
			}
		}
	}

	if sess == nil {
		// Circuit breaker: fast-fail when Apple servers are repeatedly unreachable.
		if !s.openCB.Allow() {
			http.Error(w, "playback resolution failed: Apple servers appear unreachable (circuit open)", http.StatusServiceUnavailable)
			return
		}
		t0 := time.Now()
		var err error
		sess, err = s.pm.Open(r.Context(), playback.OpenRequest{
			AssetID:     req.AssetID,
			Storefront:  sf,
			Token:       token,
			MUT:         mut,
			Lossless:    req.Capabilities.Lossless,
			HiRes:       req.Capabilities.HiRes,
			Video:       req.Capabilities.Video,
			Atmos:       req.Capabilities.Atmos,
			Language:    s.lang(r),
			MVMaxHeight: req.MVMaxHeight,
		})
		latMs := time.Since(t0).Milliseconds()
		if err != nil {
			// Only transport-level failures may trip the breaker. A per-track
			// content failure (catalog 404, unavailable in this storefront) says
			// nothing about Apple's reachability — counting those let three bad
			// tracks in a row open the breaker and fail every subsequent open,
			// songs included, with a misleading "servers appear unreachable".
			if isTransportFailure(err) {
				s.openCB.RecordFailure()
			} else {
				// A content failure proves the round-trip worked.
				s.openCB.RecordSuccess()
			}
			status := http.StatusInternalServerError
			if isNotFoundFailure(err) {
				status = http.StatusNotFound
			}
			http.Error(w, "playback resolution failed: "+err.Error(), status)
			return
		}
		s.openCB.RecordSuccess()
		s.openLatency.Record(latMs)
	}

	s.events.emit("playback.created", map[string]any{
		"sessionId": sess.ID,
		"assetId":   sess.AssetID,
		"codec":     sess.Codec,
	})
	writeJSON(w, http.StatusCreated, sess)
}

func (s *APIServer) handlePlaybackAudio(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	log.Printf("[audio] GET id=%s t=%q Range=%q", id, r.URL.Query().Get("t"), r.Header.Get("Range"))
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Audio {
		http.Error(w, "no audio stream in this session", http.StatusNotFound)
		return
	}

	// ?t=<seconds> — seek to an approximate time offset.
	// The response header X-Actual-Start reports the real segment start time so
	// the frontend can set audio.currentTime accurately after a seek.
	var seekSec float64
	if tStr := r.URL.Query().Get("t"); tStr != "" {
		if v, err := strconv.ParseFloat(tStr, 64); err == nil && v > 0 {
			seekSec = v
		}
	}

	// Disk cache: serve cached files for non-seek requests so replays skip CDN.
	// Seeks (seekSec > 0) bypass the cache — the cached file may be truncated from a
	// prior partial download, and http.ServeContent ignores the ?t= parameter anyway.
	// For seeks, pm.StreamFrom serves the correct fMP4 fragment directly from the CDN.
	// INTERCEPT: wrap writer for MV sessions to count/log bytes sent to browser.
	if sess.Type == "mv" {
		// Keep the counting wrapper inside streamMedia's firstByteWriter. Writing
		// directly to w would commit a 200 before streamMedia can turn a
		// pre-first-byte pipeline error into a useful 502 response.
		cw := &countingWriter{}
		log.Printf("[INTERCEPT] MV audio stream START id=%s codec=%s", id, sess.Codec)
		streamMedia(w, r, func(dst io.Writer) error {
			cw.w = dst
			return s.pm.Stream(r.Context(), id, pipeline.KindAudio, cw)
		}, "audio/mp4")
		log.Printf("[INTERCEPT] MV audio stream END id=%s totalBytes=%d", id, cw.n)
		return
	}

	// MV sessions stream audio direct to MSE — skip disk cache to avoid
	// colliding with same-AssetID song cache entries.
	if s.diskCache != nil && sess.Type != "mv" && seekSec == 0 {
		qualifier := sess.Codec
		if f, ok := s.diskCache.Get(sess.AssetID, qualifier); ok {
			defer f.Close()
			w.Header().Set("Content-Type", "audio/mp4")
			http.ServeContent(w, r, "", time.Time{}, f)
			return
		}

		// ALAC cache miss: stream to VLC while downloading in the background.
		// This cuts first-play latency from the full lossless download time
		// (~5-15 s) to the initial buffer fill (~0.5 s). The download goroutine
		// uses a detached context so the file is always committed even when VLC
		// disconnects mid-stream (user skips), giving subsequent plays a cache hit.
		// On commit the file is served via http.ServeContent with full byte-range
		// support on every subsequent play, enabling accurate SetTime seeks.
		//
		// During first play, Accept-Ranges: bytes is advertised so VLC knows it
		// can send Range requests for seeking. A concurrent Range request hits
		// GetStreaming and is served by a NewReaderAt on the in-progress writer —
		// it blocks at the byte level (Android RandomAccessFile model) until the
		// requested offset is available, then streams from there.
		if sess.Codec == "alac" {
			// VLC Range seek during an active streaming download: serve the
			// requested byte range from the in-progress writer only if the
			// offset has already been written. Return 416 immediately when the
			// download hasn't reached the offset yet — VLC then uses SeekReload
			// (vlc/load with startMs) as a fallback rather than hanging until
			// its HTTP timeout fires. The 206 status + Content-Range header is
			// required so VLC updates its byte-position counter correctly.
			if rangeHdr := r.Header.Get("Range"); rangeHdr != "" {
				if spw := s.diskCache.GetStreaming(sess.AssetID, qualifier); spw != nil {
					offset := parseRangeStart(rangeHdr)
					written := spw.Written()
					log.Printf("[audio] ALAC Range seek id=%s offset=%d written=%d", id, offset, written)
					if offset > written {
						// Not yet downloaded — tell VLC the range is unsatisfiable so
						// the renderer can fall back to SeekReload immediately.
						w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", written))
						w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
						return
					}
					// Offset is available: serve as 206 so VLC treats this as a
					// ranged response and doesn't reset its position counter to 0.
					// Use a 1 GiB sentinel for the total size (no ALAC file is that
					// large) since the true size is unknown during streaming.
					const sentinel = int64(1 << 30)
					w.Header().Set("Content-Type", "audio/mp4")
					w.Header().Set("Accept-Ranges", "bytes")
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, sentinel-1, sentinel))
					w.WriteHeader(http.StatusPartialContent)
					reader := spw.NewReaderAt(offset)
					defer reader.Close()
					io.Copy(w, reader) //nolint:errcheck
					return
				}
			}

			if spw, _ := s.diskCache.BeginStreamingPut(sess.AssetID, qualifier); spw != nil {
				s.startCacheDownload(id, spw)
				w.Header().Set("Content-Type", "audio/mp4")
				w.Header().Set("Accept-Ranges", "bytes")
				reader := spw.NewReader()
				defer reader.Close()
				io.Copy(w, reader) //nolint:errcheck — client disconnect is normal
				return
			}
		}

		// Non-ALAC cache miss (AAC, etc.): stream to the client WHILE caching in the
		// background, instead of downloading the whole track before the first byte.
		// This drops first-play TTFB from O(whole-track download) to O(first segment)
		// — the same mechanism already proven on the ALAC path. The background
		// download uses a detached context so the cache still commits when the client
		// disconnects mid-stream (skip), giving the next play a byte-range cache hit.
		// MSE reads sequentially, so no Range handling is needed on first play; replays
		// hit the committed file above via http.ServeContent.
		if spw, _ := s.diskCache.BeginStreamingPut(sess.AssetID, qualifier); spw != nil {
			s.startCacheDownload(id, spw)
			w.Header().Set("Content-Type", "audio/mp4")
			reader := spw.NewReader()
			defer reader.Close()
			// The streaming reader surfaces the download error (Discard sets it) as a
			// non-EOF read error. If it fails before any byte reached the client, the
			// 200 headers are not yet committed, so report a clean 502 instead of an
			// empty 200. A mid-stream failure (n>0) can only be logged — headers are out.
			if n, err := io.Copy(w, reader); err != nil {
				if n == 0 && r.Context().Err() == nil {
					writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
				} else if r.Context().Err() == nil {
					slog.Error("AAC stream error (partial)", "id", id, "err", err)
				}
			}
			return
		}
		// Fallback: another goroutine is already caching this key (BeginStreamingPut
		// returned nil) — stream without caching.
		streamMedia(w, r, func(dst io.Writer) error {
			return s.pm.Stream(r.Context(), id, pipeline.KindAudio, dst)
		}, "audio/mp4")
		return
	}

	if seekSec > 0 {
		log.Printf("[engine] seek id=%s codec=%s seekSec=%.3f", id, sess.Codec, seekSec)
		seekCtx := r.Context()
		if actual, ok := s.pm.GetSeekStart(id, pipeline.KindAudio, seekSec); ok {
			w.Header().Set("X-Actual-Start", strconv.FormatFloat(actual, 'f', 3, 64))
			log.Printf("[engine] seek actualStart=%.3f (requested=%.3f)", actual, seekSec)
			seekCtx = pipeline.ContextWithActualStart(seekCtx, actual)
			// Pass the exact requested time so PassthroughStreaming can trim
			// leading fragments within the segment for sub-segment accuracy.
			seekCtx = pipeline.ContextWithSeekTarget(seekCtx, seekSec)
		}
		streamMedia(w, r, func(dst io.Writer) error {
			_, err := s.pm.StreamFrom(seekCtx, id, pipeline.KindAudio, seekSec, dst)
			return err
		}, "audio/mp4")
		return
	}

	streamMedia(w, r, func(dst io.Writer) error {
		return s.pm.Stream(r.Context(), id, pipeline.KindAudio, dst)
	}, "audio/mp4")
}

// startCacheDownload fills spw from the session's audio stream in the
// background. The context is detached from any client so the cache still
// commits when the listener disconnects mid-track (skip).
func (s *APIServer) startCacheDownload(id string, spw *diskcache.StreamingPutWriter) {
	vlog.Printf("[cache] startCacheDownload START: session=%s", id)
	downloadCtx, cancel := context.WithTimeout(s.shutdownCtx, 15*time.Minute) // shutdownCtx: from PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1)
	go func() {
		defer cancel()
		defer s.alac.done(id, spw)
		vlog.Printf("[cache] startCacheDownload calling pm.Stream: session=%s", id)
		if err := s.pm.Stream(downloadCtx, id, pipeline.KindAudio, s.alac.writer(downloadCtx, id, spw)); err != nil {
			log.Printf("[cache] startCacheDownload pm.Stream ERROR: session=%s err=%v", id, err)
			spw.Discard()
		} else {
			vlog.Printf("[cache] startCacheDownload SUCCESS: session=%s", id)
			if err := spw.Commit(); err != nil {
				log.Printf("[cache] commit failed: session=%s err=%v", id, err)
			}
		}
	}()
}

// handlePlaybackPrecache triggers a background disk-cache download for an ALAC
// session so VLC can load it instantly on the next track change. Returns 202
// immediately; the download runs in a detached goroutine.
func (s *APIServer) handlePlaybackPrecache(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if s.diskCache == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	qualifier := sess.Codec
	if _, inCache := s.diskCache.Path(sess.AssetID, qualifier); inCache {
		w.WriteHeader(http.StatusNoContent) // already in cache
		return
	}
	bgCtx, cancel := context.WithTimeout(s.shutdownCtx, 10*time.Minute) // shutdownCtx: from PR #1
	// Publish the streaming writer before acknowledging the pre-warm. Playback
	// can consume its bytes immediately instead of racing a non-streaming put.
	spw, f, err := s.diskCache.BeginStreamingPutOrGet(sess.AssetID, qualifier)
	if err != nil {
		cancel()
		http.Error(w, "cannot start precache", http.StatusInternalServerError)
		return
	}
	if f != nil {
		f.Close()
		cancel()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if spw == nil {
		cancel()
		w.WriteHeader(http.StatusAccepted) // another writer owns this exact key
		return
	}
	go func() {
		defer cancel()
		defer s.alac.done(id, spw)
		if err := s.pm.Stream(bgCtx, id, pipeline.KindAudio, s.alac.writer(bgCtx, id, spw)); err != nil {
			spw.Discard()
			return
		}
		if err := spw.Commit(); err != nil {
			return
		}
		log.Printf("[precache] disk cache populated assetId=%s sessionId=%s", sess.AssetID, id)
	}()
	w.WriteHeader(http.StatusAccepted)
}

func (s *APIServer) handleDeletePlayback(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Cancel any active vseg (segmented video) producer for this session.
	s.stopVsegSession(id)
	// If this session's MV faststart file was written under "caching disabled",
	// delete it now — it existed only to serve this playback.
	if sess, ok := s.pm.GetSession(id); ok {
		if _, ephemeral := s.mvEphemeral.LoadAndDelete(sess.AssetID); ephemeral {
			s.diskCache.Remove(sess.AssetID, "mv-dl")
			log.Printf("%s ephemeral mv-dl removed assetID=%s (caching disabled)", tagInfo("[video-dl]"), sess.AssetID)
		}
	}
	s.pm.Release(id)
	s.events.emit("playback.deleted", map[string]string{"sessionId": id})
	w.WriteHeader(http.StatusNoContent)
}

// handlePlaybackTouch keeps a session alive while the renderer still has it open. A session's expiry only slides
// when something looks it up, so a track paused for hours would otherwise be swept and could not be resumed. A 404
// tells the renderer the session is gone and the track must be reopened at its saved position.
func (s *APIServer) handlePlaybackTouch(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.pm.GetSession(r.PathValue("id")); !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePlaybackContext accepts a PUT /api/v1/playback/context payload and
// submits a cache-warming job to the prefetch scheduler.
// The renderer is telling the engine "the user is looking at this content."
// All scheduling policy (which tracks, order, concurrency) is engine-internal.
func (s *APIServer) handlePlaybackContext(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10) // 512 KB — up to 50 tracks
	var payload prefetch.ContextPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	jobID := s.scheduler.Submit(payload)
	writeJSON(w, http.StatusAccepted, map[string]string{"jobId": jobID})
}

// streamMedia runs fn into a firstByteWriter so that:
//   - If fn produces no bytes and returns an error, the client receives a
//     502 JSON error instead of a silent empty 200 response.
//   - If fn produces at least one byte before failing, headers are already
//     committed; the partial stream is what the client sees (best effort).
func streamMedia(w http.ResponseWriter, r *http.Request, fn func(io.Writer) error, ct string) {
	bw := &firstByteWriter{w: w, ct: ct}
	if err := fn(bw); err != nil {
		if r.Context().Err() != nil {
			return // client disconnected — not an error
		}
		if !bw.started {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		// Headers already committed; log and let the client handle the truncated stream.
		slog.Error("stream error (partial)", "err", err)
	}
}

// firstByteWriter defers writing Content-Type + 200 headers until the first
// byte arrives.  This lets the handler return a proper error if the pipeline
// fails before producing any output.
type firstByteWriter struct {
	w       http.ResponseWriter
	ct      string
	started bool
}

func (b *firstByteWriter) SetHeader(key, value string) {
	if !b.started {
		b.w.Header().Set(key, value)
	}
}

func (b *firstByteWriter) Write(p []byte) (int, error) {
	if !b.started {
		b.started = true
		b.w.Header().Set("Content-Type", b.ct)
		b.w.Header().Set("Accept-Ranges", "none")
		b.w.WriteHeader(http.StatusOK)
	}
	n, err := b.w.Write(p)
	// Flush the ResponseWriter's internal buffer to the network immediately.
	// Without this, Go's HTTP server buffers data in a 4KB internal buffer and
	// the player (mpv, VLC) stalls between fragments waiting for more bytes.
	if err == nil {
		if f, ok := b.w.(http.Flusher); ok {
			f.Flush()
		}
	}
	return n, err
}

// countingWriter wraps an io.Writer and counts total bytes written.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
