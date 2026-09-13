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

	"engine/core/pipeline"
	"engine/core/playback"
	"engine/core/prefetch"
	"engine/utils/aacstream"
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

		// Non-ALAC cache miss (AAC, etc.): download the full track first, then
		// serve with http.ServeContent for byte-range support on replays.
		// AAC files are small enough that the download overhead is not noticeable.
		if pw, _ := s.diskCache.BeginPut(sess.AssetID, qualifier); pw != nil {
			err := s.pm.Stream(r.Context(), id, pipeline.KindAudio, pw)
			if err != nil {
				pw.Discard()
			} else if pw.Commit() == nil {
				if f, ok := s.diskCache.Get(sess.AssetID, qualifier); ok {
					defer f.Close()
					w.Header().Set("Content-Type", "audio/mp4")
					http.ServeContent(w, r, "", time.Time{}, f)
					return
				}
			}
		}
		// Fallback: stream without caching (no byte-range seek support).
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
	if seekSec == 0 && aacstream.MVDecExists(assetID, sess.MVMaxHeight) {
		streamMediaCoalesced(w, r, func(dst io.Writer) error {
			return aacstream.ServeMVDec(assetID, sess.MVMaxHeight, dst)
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
	// Only cache full plays; seek streams produce a partial file and must not be cached.
	streamMediaCoalesced(w, r, func(dst io.Writer) error {
		if seekSec > 0 {
			return transcodeVideoForMSE(r.Context(), videoSrc, dst)
		}
		cw := aacstream.MVDecCacheWriter(assetID, sess.MVMaxHeight, dst)
		err := transcodeVideoForMSE(r.Context(), videoSrc, cw)
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

func (s *APIServer) handleDeletePlayback(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
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
func transcodeVideoForMSE(ctx context.Context, src func(io.Writer) error, dst io.Writer) error {
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
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-loglevel", "warning",
		"-i", "pipe:0",
		"-map", "0:v:0", // first video stream only — drops audio and caption tracks
		"-c:v", "copy", // preserve original codec (avc1.640028); no re-encode
		"-movflags", "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
		"-avoid_negative_ts", "make_zero", // B-frames: shift DTS so minimum is 0
		"-f", "mp4",
		"pipe:1",
	)
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
	writesIn int   // Write() calls received (≈ network/pipe chunks)
	boxesOut int   // downstream flushes emitted (one per whole box)
	bytesOut int64 // total bytes forwarded
}

func (c *boxCoalescer) Write(p []byte) (int, error) {
	c.writesIn++
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
			// size==0 means "extends to EOF"; anything else <8 is malformed.
			// Stop coalescing — Flush() emits whatever remains.
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
