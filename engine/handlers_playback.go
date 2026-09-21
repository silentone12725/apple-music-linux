package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/core/playback"
	"engine/core/prefetch"
	"engine/utils/aacstream"
)

// ── MV WebCodecs growing-file seek (ALAC-style) ──────────────────────────────
//
// The direct /video-es path streams the decrypted MV fMP4 once into a growing
// ephemeral cache file while serving the renderer, and builds a live time→byte
// fragment index. Seeks into already-downloaded media are served from the file
// (no Apple CDN re-download); only seeks past the download head fall back to the
// network. The producer is owned by the MV SESSION (not the HTTP request), so it
// keeps filling the file across seek requests and stops on session release.

type mvGrowingState struct {
	spw       *diskcache.StreamingPutWriter
	ix        *aacstream.MVLiveIndex
	cancel    context.CancelFunc
	done      chan struct{} // closed after the producer goroutine exits (Commit/Discard done)
	assetID   string
	qualifier string
}

var (
	mvGrowing   sync.Map   // sessionID → *mvGrowingState (mv-es WebCodecs path)
	mvGrowingMu sync.Mutex // serializes producer creation (one BeginStreamingPut per session)
)

// getOrStartMVGrowing returns the session's growing-file producer, starting it on
// first use with a session-lifetime context. Returns nil if a streaming put can't
// be opened (caller then uses the stateless network fallback).
func (s *APIServer) getOrStartMVGrowing(id, assetID, qualifier string) *mvGrowingState {
	if v, ok := mvGrowing.Load(id); ok {
		return v.(*mvGrowingState)
	}
	mvGrowingMu.Lock()
	defer mvGrowingMu.Unlock()
	if v, ok := mvGrowing.Load(id); ok { // double-check under lock
		return v.(*mvGrowingState)
	}
	spw, err := s.diskCache.BeginStreamingPut(assetID, qualifier)
	if err != nil || spw == nil {
		return nil
	}
	ix := aacstream.NewMVLiveIndex()
	pctx, cancel := context.WithCancel(context.Background()) // detached from any HTTP request
	st := &mvGrowingState{spw: spw, ix: ix, cancel: cancel, done: make(chan struct{}), assetID: assetID, qualifier: qualifier}
	mvGrowing.Store(id, st)
	go func() {
		// Single whole-track stream to the growing file; the live index records
		// fragment (time → byte). Producer outlives individual HTTP requests.
		defer close(st.done) // signal teardown that the writer is fully done
		err := s.pm.Stream(pctx, id, pipeline.KindVideo, io.MultiWriter(spw, ix))
		if err != nil {
			spw.Discard()
		} else {
			spw.Commit()
		}
	}()
	log.Printf("%s producer started id=%s assetID=%s q=%s", tagVideo("[mv-es]"), id, assetID, qualifier)
	return st
}

// stopMVGrowing cancels a session's growing-file producer and removes the scratch
// file. The mv-es file is a per-session seek scratch (persistent MV caching, when
// enabled, is the dec-cache's separate job), so it is always removed on release.
func (s *APIServer) stopMVGrowing(id string) {
	if v, ok := mvGrowing.LoadAndDelete(id); ok {
		st := v.(*mvGrowingState)
		st.cancel()
		// Wait for the producer to fully exit (Discard/Commit done) before removing
		// the scratch file, so Remove() never races an active writer. Bounded so a
		// stuck producer can't hang session teardown.
		select {
		case <-st.done:
		case <-time.After(5 * time.Second):
			log.Printf("%s producer stop timed out id=%s (removing anyway)", tagWarn("[mv-es]"), id)
		}
		s.diskCache.Remove(st.assetID, st.qualifier)
		log.Printf("%s producer stopped + scratch removed id=%s assetID=%s", tagInfo("[mv-es]"), id, st.assetID)
	}
}

// proxyProgressiveVideo forwards the browser's Range request to the Apple CDN
// URL and pipes the response back verbatim. Chrome handles moov discovery and
// all seeking natively — the same pattern Android's ExoPlayer uses for mvod.
func (s *APIServer) proxyProgressiveVideo(w http.ResponseWriter, r *http.Request, mvURL string) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, mvURL, nil)
	if err != nil {
		http.Error(w, "proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if r.Context().Err() != nil {
			return // client disconnected
		}
		http.Error(w, "proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	hdr := w.Header()
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			hdr.Set(h, v)
		}
	}
	if hdr.Get("Content-Type") == "" {
		hdr.Set("Content-Type", "video/mp4")
	}
	hdr.Set("Accept-Ranges", "bytes")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck
}

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
	for _, needle := range []string{"500", "502", "503", "504", "timeout", "connection"} {
		if strings.Contains(s, needle) {
			return false
		}
	}
	// "no such host" is DNS and belongs to isTransportFailure, so it is deliberately
	// absent here.
	for _, needle := range []string{
		"404", "not found", "no playable",
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
		"502", "503", "504", "500 internal",
	} {
		if strings.Contains(s, needle) {
			return true
		}
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
		mut = s.mediaUserToken()
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
		cw := &countingWriter{w: w}
		log.Printf("[INTERCEPT] MV audio stream START id=%s codec=%s", id, sess.Codec)
		streamMedia(w, r, func(dst io.Writer) error {
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
				downloadCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
				go func() {
					defer cancel()
					if err := s.pm.Stream(downloadCtx, id, pipeline.KindAudio, spw); err != nil {
						spw.Discard()
					} else {
						spw.Commit()
					}
				}()
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
			downloadCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			go func() {
				defer cancel()
				if err := s.pm.Stream(downloadCtx, id, pipeline.KindAudio, spw); err != nil {
					spw.Discard()
				} else {
					spw.Commit()
				}
			}()
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
	bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	go func() {
		defer cancel()
		pw, err := s.diskCache.BeginPut(sess.AssetID, qualifier)
		if err != nil || pw == nil {
			return
		}
		if err := s.pm.Stream(bgCtx, id, pipeline.KindAudio, pw); err != nil {
			pw.Discard()
			return
		}
		if err := pw.Commit(); err != nil {
			pw.Discard()
			return
		}
		log.Printf("[precache] disk cache populated assetId=%s sessionId=%s", sess.AssetID, id)
	}()
	w.WriteHeader(http.StatusAccepted)
}

func (s *APIServer) handlePlaybackVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Video {
		http.Error(w, "no video stream in this session", http.StatusNotFound)
		return
	}

	assetID := sess.AssetID
	var seekSec float64
	if v, err := strconv.ParseFloat(r.URL.Query().Get("t"), 64); err == nil && v > 0 {
		seekSec = v
	}
	log.Printf("[video] GET id=%s assetID=%q seekSec=%.2f maxHeight=%d decExists=%v", id, assetID, seekSec, sess.MVMaxHeight, aacstream.MVDecExists(assetID, sess.MVMaxHeight))

	// Serve from decrypted-track cache for full plays (seekSec==0).
	// Cache is keyed by assetID + maxHeight so quality changes always re-transcode.
	// Seeks fall through to the normal pipeline so the segment cache handles them.
	//
	if seekSec == 0 && aacstream.MVDecExists(assetID, sess.MVMaxHeight) {
		streamMediaCoalesced(w, r, func(dst io.Writer) error {
			return aacstream.ServeMVDec(assetID, sess.MVMaxHeight, dst)
		}, "video/mp4")
		return
	}

	// Seek within the cached remuxed track (#6): when the fragment index exists,
	// serve the init segment + fragments from the moof covering seekSec directly
	// from the dec-cache — no FFmpeg re-run. The index must be confirmed present
	// BEFORE streaming so a missing/unusable one falls through to the FFmpeg path
	// below instead of erroring mid-stream. Matches the existing seek contract:
	// the client seeks to seekSec and the emitted range (starting at/before it)
	// covers it, so no X-Actual-Start is needed.
	if seekSec > 0 && aacstream.MVDecExists(assetID, sess.MVMaxHeight) &&
		aacstream.MVDecIndexExists(assetID, sess.MVMaxHeight) {
		log.Printf("[video] seek from dec-cache index seekSec=%.2f id=%s", seekSec, id)
		streamMediaCoalesced(w, r, func(dst io.Writer) error {
			return aacstream.ServeMVDecFrom(assetID, sess.MVMaxHeight, seekSec, dst)
		}, "video/mp4")
		return
	}

	// videoSrc streams the raw decrypted multi-track fMP4 from the pipeline.
	// FFmpeg receives it directly — its -map 0:v:0 flag selects only the first
	// video stream and drops audio/caption tracks during remux. Stripping audio
	// trafs from the moof while leaving audio bytes in the mdat causes the moof
	// declared size to diverge from the DataOffset, making FFmpeg's mov demuxer
	// avio_skip past the correct sample position ("partial file" error).
	videoSrc := func(w io.Writer) error {
		if seekSec > 0 {
			_, err := s.pm.StreamFrom(r.Context(), id, pipeline.KindVideo, seekSec, w)
			return err
		}
		return s.pm.Stream(r.Context(), id, pipeline.KindVideo, w)
	}
	// Real timeline anchor for seeks: the nearest segment start <= seekSec. Without
	// it, make_zero would emit 0-based fragments and the client's currentTime=seekSec
	// would fall outside the buffered range (stall). Full plays use 0.
	var tsOffset float64
	if seekSec > 0 {
		if actual, ok := s.pm.GetSeekStart(id, pipeline.KindVideo, seekSec); ok {
			tsOffset = actual
		} else {
			tsOffset = seekSec
		}
	}
	// Only cache full plays; seek streams produce a partial file and must not be cached.
	streamMediaCoalesced(w, r, func(dst io.Writer) error {
		if seekSec > 0 {
			return transcodeVideoForMSE(r.Context(), videoSrc, dst, tsOffset)
		}
		cw := aacstream.MVDecCacheWriter(assetID, sess.MVMaxHeight, dst)
		err := transcodeVideoForMSE(r.Context(), videoSrc, cw, 0)
		if err == nil {
			log.Printf("[video] transcode OK — committing dec cache assetID=%s height=%d", assetID, sess.MVMaxHeight)
			cw.Commit()
		} else {
			log.Printf("[video] transcode ERR — aborting dec cache assetID=%s err=%v", assetID, err)
			cw.Abort()
		}
		return err
	}, "video/mp4")
}

// handlePlaybackVideoNativeInfo reports whether a session's video is committed to
// the mv-dl cache and, if so, its absolute on-disk path and size. The Electron
// aml-video:// handler uses this to serve a cached file DIRECTLY via
// createReadStream (proper 206 byte-range seeking) instead of proxying byte
// ranges through electronNet.fetch, which mangles Range semantics for <video>
// and yields MEDIA_ERR_SRC_NOT_SUPPORTED. Uncached sessions fall back to the
// streaming proxy.
func (s *APIServer) handlePlaybackVideoNativeInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	const qualifier = "mv-dl"
	if path, ok := s.diskCache.Path(sess.AssetID, qualifier); ok {
		size := int64(0)
		if fi, err := os.Stat(path); err == nil {
			size = fi.Size()
		}
		writeJSON(w, http.StatusOK, map[string]any{"cached": true, "path": path, "size": size})
		return
	}
	// Not cached — start the faststart build (idempotent) so the client can poll
	// this endpoint and show a loading state until "cached" flips true.
	go s.prepareMVFaststart(id, sess.AssetID, float64(sess.DurationMs)/1000.0)
	_, preparing := mvPreparing.Load(sess.AssetID)
	writeJSON(w, http.StatusOK, map[string]any{"cached": false, "preparing": preparing})
}

// handlePlaybackVideoNative serves a video session for use with a plain
// <video src> element. Chrome handles moov discovery and all seeking natively
// via Range requests — the same pattern Android's ExoPlayer uses for mvod.
//
// Fast path (committed faststart cache): http.ServeContent with full
// Accept-Ranges / 206 — instant random-access seeking from disk.
//
// Slow path (no cache): transparent Range proxy to the Apple CDN URL.
// The browser's Range header is forwarded to mvod.itunes.apple.com;
// the CDN 206 is piped back. No FFmpeg, no growing file needed.
// prepareMVFaststart runs in the background (when MV caching is enabled)
// so subsequent plays hit the fast path.
func (s *APIServer) handlePlaybackVideoNative(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Video {
		http.Error(w, "no video stream in this session", http.StatusNotFound)
		return
	}

	assetID := sess.AssetID
	durationSec := float64(sess.DurationMs) / 1000.0

	// ── Fast path: committed faststart cache ──────────────────────────────────
	// Serve the pre-built non-fragmented MP4 with a full moov sample table.
	// http.ServeContent provides proper Accept-Ranges / 206 so Chrome can seek
	// anywhere instantly without any CDN round-trips.
	const qualDL = "mv-dl"
	if path, ok2 := s.diskCache.Path(assetID, qualDL); ok2 {
		log.Printf("%s cache hit id=%s assetID=%s", tagOK("[video-dl]"), id, assetID)
		f, err := os.Open(path)
		if err != nil {
			http.Error(w, "cache open: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		fi, _ := f.Stat()
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "video.mp4", fi.ModTime(), f)
		return
	}

	// ── Slow path: Range proxy to Apple CDN ───────────────────────────────────
	// Forward the browser's Range header directly to mvod.itunes.apple.com.
	// Chrome handles moov discovery, byte-range seeking, and buffering natively.
	// Start building the faststart cache in the background so future plays are instant.
	log.Printf("%s cache miss id=%s assetID=%s → CDN proxy", tagVideo("[video-dl]"), id, assetID)
	if aacstream.MVCacheEnabled() {
		// Guard with mvPreparing so multiple concurrent Range requests
		// from the same play (moov + data) don't each spawn a goroutine.
		if _, already := mvPreparing.Load(assetID); !already {
			go s.prepareMVFaststart(id, assetID, durationSec)
		}
	}

	mvURL, hasURL := s.pm.GetProgressiveURL(id, pipeline.KindVideo)
	if !hasURL {
		http.Error(w, "no progressive URL for this video session", http.StatusNotFound)
		return
	}
	s.proxyProgressiveVideo(w, r, mvURL)
}

// handlePlaybackVideoRaw streams the raw decrypted multi-track fMP4 for a
// video session — before FFmpeg remux. Useful for pipeline debugging with
// ffprobe to check that the decrypt stage is producing valid output.
func (s *APIServer) handlePlaybackVideoRaw(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Video {
		http.Error(w, "no video stream in this session", http.StatusNotFound)
		return
	}
	log.Printf("[video-raw] GET id=%s assetID=%q maxHeight=%d", id, sess.AssetID, sess.MVMaxHeight)
	streamMediaCoalesced(w, r, func(dst io.Writer) error {
		return s.pm.Stream(r.Context(), id, pipeline.KindVideo, dst)
	}, "video/mp4")
}

// handlePlaybackVideoES streams the MV video as a demuxed H.264 elementary
// stream (access units + avcC) for the renderer's WebCodecs VideoDecoder — the
// path that bypasses Chromium's MSE ChunkDemuxer (source of code=3). It reuses
// the same FFmpeg single-track remux as /video, then demuxes it here with mp4ff
// instead of handing fMP4 to the browser. Spike endpoint, gated by a renderer
// feature flag; /video (MSE) remains the default.
func (s *APIServer) handlePlaybackVideoES(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Video {
		http.Error(w, "no video stream in this session", http.StatusNotFound)
		return
	}
	var seekSec float64
	if v, err := strconv.ParseFloat(r.URL.Query().Get("t"), 64); err == nil && v > 0 {
		seekSec = v
	}
	assetID := sess.AssetID
	log.Printf("[video-es] GET id=%s assetID=%q seekSec=%.2f decExists=%v", id, assetID, seekSec, aacstream.MVDecExists(assetID, sess.MVMaxHeight))

	// esw wraps the ResponseWriter so every DemuxFMP4ToES write is immediately
	// flushed to the network. Without this, Go's HTTP layer buffers small writes
	// (e.g. the tiny first video fragment, ~4 KB) and holds them until the buffer
	// fills — causing a multi-second stall before the renderer sees the first byte.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	esw := &firstByteWriter{w: w, ct: "application/octet-stream"}

	// Full play from dec-cache: no FFmpeg, real-timeline PTS already in the fMP4.
	if seekSec == 0 && aacstream.MVDecExists(assetID, sess.MVMaxHeight) {
		log.Printf("[video-es] full play from dec-cache id=%s", id)
		pr, pw := io.Pipe()
		go func() { pw.CloseWithError(aacstream.ServeMVDec(assetID, sess.MVMaxHeight, pw)) }()
		if err := aacstream.DemuxFMP4ToES(r.Context(), pr, esw); err != nil && r.Context().Err() == nil {
			log.Printf("[video-es] dec-cache demux error id=%s: %v", id, err)
		}
		return
	}

	// Seek from indexed dec-cache: accurate real-timeline seek, no FFmpeg re-run.
	if seekSec > 0 && aacstream.MVDecExists(assetID, sess.MVMaxHeight) &&
		aacstream.MVDecIndexExists(assetID, sess.MVMaxHeight) {
		log.Printf("[video-es] seek from dec-cache index seekSec=%.2f id=%s", seekSec, id)
		pr, pw := io.Pipe()
		go func() {
			pw.CloseWithError(aacstream.ServeMVDecFrom(assetID, sess.MVMaxHeight, seekSec, pw))
		}()
		if err := aacstream.DemuxFMP4ToES(r.Context(), pr, esw); err != nil && r.Context().Err() == nil {
			log.Printf("[video-es] indexed seek demux error id=%s: %v", id, err)
		}
		return
	}

	// Direct path (uncached): stream once into a growing ephemeral file while
	// serving, so seeks into downloaded media are served from the file with no
	// Apple CDN re-download. Falls back to a stateless network stream if a
	// streaming put can't be opened.
	qualifier := fmt.Sprintf("mv-es-%d", sess.MVMaxHeight)
	st := s.getOrStartMVGrowing(id, assetID, qualifier)
	if st == nil {
		// Fallback: stateless direct stream (no growing file available).
		pr, pw := io.Pipe()
		go func() {
			var err error
			if seekSec > 0 {
				_, err = s.pm.StreamFrom(r.Context(), id, pipeline.KindVideo, seekSec, pw)
			} else {
				err = s.pm.Stream(r.Context(), id, pipeline.KindVideo, pw)
			}
			pw.CloseWithError(err)
		}()
		if err := aacstream.DemuxFMP4ToES(r.Context(), pr, esw); err != nil && r.Context().Err() == nil {
			log.Printf("[video-es] direct demux error id=%s: %v", id, err)
		}
		return
	}

	// Seek: serve from the growing file when we can find a complete fragment at or
	// before seekSec (End > 0 && End <= Written). LookupComplete falls back to an
	// earlier complete fragment when the exact one isn't downloaded yet — this
	// guarantees the first chunk arrives immediately (data is on disk), preventing
	// the 8 s hang timeout from firing. The growing reader delivers the rest as the
	// producer catches up; the renderer discards stale frames and resumes audio once
	// PTS reaches seekSec.
	if seekSec > 0 {
		initSize, iok := st.ix.InitSize()
		frag, ok := st.ix.LookupComplete(seekSec, st.spw.Written())
		if !ok && iok {
			// No complete fragment yet — try the exact lookup as a fallback in case
			// the producer just finished and the committed path applies.
			frag, ok = st.ix.Lookup(seekSec)
		}
		// log.Printf("%s lookup seek=%.3f ok=%v fragT=%.3f off=%d end=%d initOK=%v initSize=%d written=%d",
		// 	tagInfo("[mv-es-seek]"), seekSec, ok, frag.T, frag.Off, frag.End, iok, initSize, st.spw.Written())
		if ok && iok {
			// Check whether the producer has finished (spw.Commit() called). After
			// commit the .tmp file is renamed away, so spw.NewReaderAt() would fail
			// with "file already closed". In that case open the committed file from
			// the disk cache directly — the full fMP4 is on disk and any seek is valid.
			producerDone := false
			select {
			case <-st.done:
				producerDone = true
			default:
			}
			if producerDone {
				if f, ok2 := s.diskCache.Get(st.assetID, st.qualifier); ok2 {
					defer f.Close()
					totalWritten := st.spw.Written()
					combined := io.MultiReader(
						io.NewSectionReader(f, 0, initSize),
						io.NewSectionReader(f, frag.Off, totalWritten-frag.Off),
					)
					if err := aacstream.DemuxFMP4ToES(r.Context(), combined, esw); err != nil && r.Context().Err() == nil {
						log.Printf("[video-es] committed seek demux error id=%s: %v", id, err)
					}
					return
				}
				// Committed file not readable (evicted?); fall through to network.
			} else if frag.End > 0 && frag.End <= st.spw.Written() {
				// Only serve from the growing file if the fragment starts within
				// 8 seconds of the seek target. A fragment much earlier means the
				// renderer would decode+discard many seconds before reaching seekSec,
				// causing a long visible stall. Fall through to network seek instead.
				const maxFragLag = 8.0
				if seekSec-frag.T <= maxFragLag {
					initRaw := st.spw.NewReaderAt(0)
					defer initRaw.Close()
					fragR := st.spw.NewReaderAt(frag.Off)
					defer fragR.Close()
					combined := io.MultiReader(io.LimitReader(initRaw, initSize), fragR)
					if err := aacstream.DemuxFMP4ToES(r.Context(), combined, esw); err != nil && r.Context().Err() == nil {
						log.Printf("[video-es] growing-file seek demux error id=%s: %v", id, err)
					}
					return
				}
				log.Printf("[video-es] growing-file frag too early (%.1fs before target) → network id=%s", seekSec-frag.T, id)
			}
		}
		// Beyond the download head (or index not ready): network fallback. The
		// renderer's seek-hold shows a clean buffer for this case.
		// log.Printf("%s seek=%.3f source=network written=%d (beyond head/index not ready)",
		// 	tagWarn("[mv-es-seek]"), seekSec, st.spw.Written())
		pr, pw := io.Pipe()
		go func() {
			_, err := s.pm.StreamFrom(r.Context(), id, pipeline.KindVideo, seekSec, pw)
			pw.CloseWithError(err)
		}()
		if err := aacstream.DemuxFMP4ToES(r.Context(), pr, esw); err != nil && r.Context().Err() == nil {
			log.Printf("[video-es] network seek demux error id=%s: %v", id, err)
		}
		return
	}

	// First play: stream ES from the growing file (byte 0), which fills as the
	// session-owned producer downloads. tsOffset stays 0 — fragments carry real
	// PTS and the renderer's audio clock is the real timeline.
	log.Printf("%s cache=streaming id=%s written=%d", tagVideo("[mv-es]"), id, st.spw.Written())
	rd := st.spw.NewReader()
	defer rd.Close()
	if err := aacstream.DemuxFMP4ToES(r.Context(), rd, esw); err != nil && r.Context().Err() == nil {
		log.Printf("[video-es] growing-file demux error id=%s: %v", id, err)
	}
}

func (s *APIServer) handleDeletePlayback(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Stop the mv-es WebCodecs growing-file producer and remove its scratch file.
	s.stopMVGrowing(id)
	// If this session's MV faststart file was written under "caching disabled",
	// delete it now — it existed only to serve this playback.
	if sess, ok := s.pm.GetSession(id); ok {
		if _, ephemeral := mvEphemeral.LoadAndDelete(sess.AssetID); ephemeral {
			s.diskCache.Remove(sess.AssetID, "mv-dl")
			log.Printf("%s ephemeral mv-dl removed assetID=%s (caching disabled)", tagInfo("[video-dl]"), sess.AssetID)
		}
	}
	s.pm.Release(id)
	s.events.emit("playback.deleted", map[string]string{"sessionId": id})
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

var (
	ffmpegOnce sync.Once
	ffmpegPath string
)

// transcodeVideoForMSE remuxes the decrypted fMP4 through FFmpeg with -c:v copy:
// selects only the first video stream (drops audio and caption tracks), re-fragments
// for MSE (frag_keyframe+empty_moov+default_base_moof), and normalises the container
// without re-encoding so the original codec string (e.g. avc1.640028) is preserved
// and matches the SourceBuffer declaration in the renderer. Near-zero CPU overhead.
// Falls back to direct pass-through if FFmpeg is not in PATH.
// transcodeVideoForMSE remuxes decrypted fMP4 to a fragmented MSE-friendly form.
// tsOffsetSec re-anchors the output onto the real timeline: make_zero shifts the
// first output timestamp to 0, then -output_ts_offset adds tsOffsetSec back, so a
// seek stream starting at segment time T outputs fragments at real time T instead
// of 0. Pass the actual segment start for seeks (so the client's currentTime lands
// inside the buffered range, matching ServeMVDecFrom) and 0 for full plays (whose
// cached output must start at 0 to stay consistent with the fragment index).
func transcodeVideoForMSE(ctx context.Context, src func(io.Writer) error, dst io.Writer, tsOffsetSec float64, durationSec ...float64) error {
	ffmpegOnce.Do(func() {
		ffmpegPath, _ = exec.LookPath("ffmpeg")
		if ffmpegPath == "" {
			log.Printf("[video] ffmpeg not found, streaming raw fMP4 (CHUNK_DEMUXER errors possible)")
		}
	})
	if ffmpegPath == "" {
		return src(dst)
	}
	pr, pw := io.Pipe()
	args := []string{
		"-loglevel", "warning",
		"-i", "pipe:0",
		"-map", "0:v:0", // first video stream only — drops audio and caption tracks
		"-c:v", "copy", // preserve original codec (avc1.640028); no re-encode
		"-movflags", "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
		"-avoid_negative_ts", "make_zero", // B-frames: shift DTS so minimum is 0
	}
	if tsOffsetSec > 0 {
		// Re-anchor make_zero's 0-based output back onto the real timeline so a
		// seek's fragments carry their true presentation times.
		args = append(args, "-output_ts_offset", strconv.FormatFloat(tsOffsetSec, 'f', 6, 64))
	}
	if len(durationSec) > 0 && durationSec[0] > 0 {
		// Tell FFmpeg the total duration so it writes a valid mvhd duration into the
		// moov box. Without this, empty_moov produces duration=0 and the browser's
		// <video> element shows an indeterminate seek bar.
		args = append(args, "-t", strconv.FormatFloat(durationSec[0], 'f', 3, 64))
	}
	args = append(args, "-f", "mp4", "pipe:1")
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	cmd.Stdin = pr
	cmd.Stdout = dst

	// Capture stderr line-by-line so FFmpeg warnings appear immediately in logs
	// rather than only after the process exits (useful for mid-GOP kill diagnosis).
	stderrR, stderrW, _ := os.Pipe()
	cmd.Stderr = stderrW

	srcErrCh := make(chan error, 1)
	go func() {
		err := src(pw)
		pw.CloseWithError(err)
		srcErrCh <- err
	}()

	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		sc := bufio.NewScanner(stderrR)
		for sc.Scan() {
			log.Printf("[ffmpeg-video] %s", sc.Text())
		}
	}()

	t0ff := time.Now()
	runErr := cmd.Run()
	stderrW.Close()
	<-stderrDone

	ctxErr := ctx.Err()
	if runErr != nil {
		if ctxErr != nil {
			log.Printf("[ffmpeg-video] killed by context after %.2fs: %v", time.Since(t0ff).Seconds(), ctxErr)
			return ctxErr
		}
		return fmt.Errorf("ffmpeg video remux: %w", runErr)
	}
	if ctxErr != nil {
		// FFmpeg exited cleanly but context was already cancelled — treat as cancel.
		log.Printf("[ffmpeg-video] exited OK but ctx cancelled after %.2fs", time.Since(t0ff).Seconds())
		return ctxErr
	}
	srcErr := <-srcErrCh
	if srcErr != nil && ctx.Err() == nil {
		return fmt.Errorf("video source: %w", srcErr)
	}
	return nil
}

// transcodeVideoFaststart remuxes the decrypted fMP4 into a NON-fragmented,
// faststart MP4 written to outPath (a real seekable file — faststart's moov
// relocation needs a seekable output, so this cannot stream to a pipe). Unlike
// transcodeVideoForMSE's empty_moov fragmented output, this produces a complete
// moov with a full sample table, which is what Chrome's <video src> file demuxer
// requires — an empty_moov fragmented file fails with MEDIA_ERR_SRC_NOT_SUPPORTED.
func transcodeVideoFaststart(ctx context.Context, src func(io.Writer) error, outPath string, durationSec float64) error {
	ffmpegOnce.Do(func() {
		ffmpegPath, _ = exec.LookPath("ffmpeg")
	})
	if ffmpegPath == "" {
		return fmt.Errorf("ffmpeg not found")
	}
	pr, pw := io.Pipe()
	args := []string{
		"-loglevel", "warning",
		"-i", "pipe:0",
		"-map", "0:v:0", // first video stream only
		"-c:v", "copy", // preserve avc1.640028; no re-encode
		"-movflags", "+faststart", // moov at front, full sample table (seekable file)
	}
	if durationSec > 0 {
		args = append(args, "-t", strconv.FormatFloat(durationSec, 'f', 3, 64))
	}
	args = append(args, "-y", "-f", "mp4", outPath)
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	cmd.Stdin = pr

	stderrR, stderrW, _ := os.Pipe()
	cmd.Stderr = stderrW

	srcErrCh := make(chan error, 1)
	go func() {
		err := src(pw)
		pw.CloseWithError(err)
		srcErrCh <- err
	}()
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		sc := bufio.NewScanner(stderrR)
		for sc.Scan() {
			log.Printf("[ffmpeg-video-fs] %s", sc.Text())
		}
	}()

	runErr := cmd.Run()
	stderrW.Close()
	<-stderrDone
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if runErr != nil {
		return fmt.Errorf("ffmpeg faststart remux: %w", runErr)
	}
	if srcErr := <-srcErrCh; srcErr != nil {
		return fmt.Errorf("video source: %w", srcErr)
	}
	return nil
}

// mvPreparing tracks assetIDs whose faststart cache is being built, so the
// info endpoint can report "preparing" and the handler avoids duplicate jobs.
var mvPreparing sync.Map // assetID → struct{}

// prepareMVFaststart builds the faststart MP4 cache for a video session in the
// background (download → decrypt → faststart remux → commit). Guarded by
// diskCache.BeginPut's in-flight lock so only one job per asset runs.
func (s *APIServer) prepareMVFaststart(id, assetID string, durationSec float64) {
	const qualifier = "mv-dl"
	pw, _ := s.diskCache.BeginPut(assetID, qualifier)
	if pw == nil {
		return // another goroutine is already preparing this asset
	}
	mvPreparing.Store(assetID, struct{}{})
	tmpPath := pw.File.Name()
	pw.File.Close() // ffmpeg writes the path itself; keep the in-flight lock via pw

	log.Printf("%s prepare faststart start assetID=%s dur=%.1fs", tagVideo("[video-dl]"), assetID, durationSec)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	err := transcodeVideoFaststart(ctx, func(dst io.Writer) error {
		return s.pm.Stream(ctx, id, pipeline.KindVideo, dst)
	}, tmpPath, durationSec)
	mvPreparing.Delete(assetID)
	if err != nil {
		log.Printf("%s prepare faststart FAILED assetID=%s: %v", tagErr("[video-dl]"), assetID, err)
		pw.Discard()
		return
	}
	if err := pw.Commit(); err != nil {
		log.Printf("%s prepare faststart commit FAILED assetID=%s: %v", tagErr("[video-dl]"), assetID, err)
		return
	}
	// When MV caching is disabled in settings, the file must still exist on disk
	// (native <video src> plays FROM it), but it must not persist. Mark it
	// ephemeral so it's deleted when the session is released (track change / exit).
	if !aacstream.MVCacheEnabled() {
		mvEphemeral.Store(assetID, struct{}{})
	}
	if fi, e := os.Stat(func() string { p, _ := s.diskCache.Path(assetID, qualifier); return p }()); e == nil {
		log.Printf("%s prepare faststart DONE assetID=%s size=%d ephemeral=%v", tagOK("[video-dl]"), assetID, fi.Size(), !aacstream.MVCacheEnabled())
	}
}

// mvEphemeral holds assetIDs whose mv-dl faststart file was written under
// "caching disabled" — deleted on session release so nothing persists.
var mvEphemeral sync.Map // assetID → struct{}

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

// boxCoalescer buffers incoming bytes and forwards only COMPLETE top-level MP4
// boxes to the wrapped writer. Layered over firstByteWriter (which flushes every
// Write), this collapses one-flush-per-network-chunk down to one-flush-per-box,
// so FFmpeg's heavily fragmented output no longer triggers thousands of tiny
// flush syscalls — while the player still receives each moof/mdat whole (never a
// partial fragment, so no stall). Call Flush() after the stream ends to emit any
// trailing bytes (a final partial box, or a size==0 "to EOF" box).
//
// MSE-only: used solely by the MV video path. The audio path keeps per-write
// flushing because it can carry ALAC→VLC, which must not be touched.
type boxCoalescer struct {
	w        io.Writer
	buf      []byte
	pass     bool  // once set, stop framing and stream directly (never buffer)
	writesIn int   // Write() calls received (≈ network/pipe chunks)
	boxesOut int   // downstream flushes emitted (one per whole box)
	bytesOut int64 // total bytes forwarded
}

func (c *boxCoalescer) Write(p []byte) (int, error) {
	c.writesIn++
	if c.pass {
		n, err := c.w.Write(p)
		c.bytesOut += int64(n)
		return len(p), err
	}
	c.buf = append(c.buf, p...)
	for len(c.buf) >= 8 {
		size := int(binary.BigEndian.Uint32(c.buf[:4]))
		if size == 1 { // 64-bit largesize lives in bytes[8:16]
			if len(c.buf) < 16 {
				break // need the largesize field before we can measure the box
			}
			size = int(binary.BigEndian.Uint64(c.buf[8:16]))
		}
		if size < 8 {
			// size==0 ("extends to EOF") or malformed: we can't frame further.
			// Flush what we have and switch to direct passthrough so the rest of
			// the stream is never buffered unboundedly in memory.
			if err := c.enterPassthrough(); err != nil {
				return 0, err
			}
			return len(p), nil
		}
		if len(c.buf) < size {
			break // box not fully buffered yet
		}
		if _, err := c.w.Write(c.buf[:size]); err != nil {
			return 0, err
		}
		c.boxesOut++
		c.bytesOut += int64(size)
		c.buf = c.buf[size:]
	}
	return len(p), nil
}

// enterPassthrough flushes the current buffer and disables framing, so any
// remaining (unframeable) bytes stream directly instead of accumulating.
func (c *boxCoalescer) enterPassthrough() error {
	c.pass = true
	if len(c.buf) == 0 {
		return nil
	}
	n, err := c.w.Write(c.buf)
	c.boxesOut++
	c.bytesOut += int64(n)
	c.buf = nil
	return err
}

// Flush emits any bytes buffered past the last complete box.
func (c *boxCoalescer) Flush() error {
	if len(c.buf) == 0 {
		return nil
	}
	n, err := c.w.Write(c.buf)
	c.boxesOut++
	c.bytesOut += int64(n)
	c.buf = nil
	return err
}

// streamMediaCoalesced is streamMedia with fragment-aligned flushing for the MV
// video path. fn writes an fMP4 byte stream into a boxCoalescer that forwards
// whole boxes to a firstByteWriter (header-defer + flush). It must NOT be used
// for audio — that path can serve ALAC to VLC and relies on per-write flushing.
func streamMediaCoalesced(w http.ResponseWriter, r *http.Request, fn func(io.Writer) error, ct string) {
	bw := &firstByteWriter{w: w, ct: ct}
	bc := &boxCoalescer{w: bw}
	err := fn(bc)
	if err != nil {
		if r.Context().Err() != nil {
			return // client disconnected — not an error
		}
		if !bw.started {
			// No complete box was ever emitted — report a clean error instead of
			// committing 200 headers over a sub-fragment of garbage.
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		bc.Flush() //nolint:errcheck — emit the trailing partial fragment of an already-started stream
		slog.Error("stream error (partial)", "err", err)
		return
	}
	if ferr := bc.Flush(); ferr != nil && r.Context().Err() == nil {
		slog.Error("stream flush error", "err", ferr)
	}
	// Proof line: flushes collapsed to one-per-box. boxesOut ≪ writesIn confirms
	// coalescing is active; boxesOut == the fragment count for the track.
	log.Printf("[video] coalesced flushes: %d boxes from %d writes (%d bytes)",
		bc.boxesOut, bc.writesIn, bc.bytesOut)
}
