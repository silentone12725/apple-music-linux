package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"engine/core/pipeline"
	"engine/core/playback"
	"engine/core/prefetch"
	"engine/utils/aacstream"
)

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
	// for this asset. This skips the webplayback API round-trip (~1–2 s) and
	// lets playback start immediately. Only applicable for AAC (non-lossless,
	// non-atmos) since prefetch workers open default-quality sessions.
	var sess *playback.Session
	if !req.Capabilities.Lossless && !req.Capabilities.Atmos && !req.Capabilities.Video {
		if sessionID, ok := s.scheduler.TakePreWarmed(req.AssetID); ok {
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
			s.openCB.RecordFailure()
			http.Error(w, "playback resolution failed: "+err.Error(), http.StatusInternalServerError)
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
		// Cache miss: download the entire track to disk first, then serve with
		// http.ServeContent so VLC gets a byte-range-capable response. This
		// one-time download enables accurate SetTime seeks on every subsequent
		// play (VLC builds an mp4 fragment index from the complete file).
		// For ALAC, the full track must be downloaded anyway before VLC can
		// seek — byte-range seeking on a streaming endpoint is not possible.
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
	log.Printf("[video] GET id=%s assetID=%q seekSec=%.2f decExists=%v", id, assetID, seekSec, aacstream.MVDecExists(assetID))

	// Serve from decrypted-track cache for full plays (seekSec==0).
	// Seeks fall through to the normal pipeline so the segment cache handles them.
	if seekSec == 0 && aacstream.MVDecExists(assetID) {
		streamMedia(w, r, func(dst io.Writer) error {
			return aacstream.ServeMVDec(assetID, dst)
		}, "video/mp4")
		return
	}

	srcFn := func(w io.Writer) error {
		if seekSec > 0 {
			_, err := s.pm.StreamFrom(r.Context(), id, pipeline.KindVideo, seekSec, w)
			return err
		}
		return s.pm.Stream(r.Context(), id, pipeline.KindVideo, w)
	}
	// Only cache full plays; seek streams produce a partial file and must not be cached.
	streamMedia(w, r, func(dst io.Writer) error {
		if seekSec > 0 {
			return transcodeVideoForMSE(r.Context(), srcFn, dst)
		}
		cw := aacstream.MVDecCacheWriter(assetID, dst)
		err := transcodeVideoForMSE(r.Context(), srcFn, cw)
		if err == nil {
			log.Printf("[video] transcode OK — committing dec cache assetID=%s", assetID)
			cw.Commit()
		} else {
			log.Printf("[video] transcode ERR — aborting dec cache assetID=%s err=%v", assetID, err)
			cw.Abort()
		}
		return err
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

// transcodeVideoForMSE remuxes the Apple CDN fMP4 through FFmpeg with -c:v copy:
// strips the audio track, re-fragments for MSE (frag_keyframe+empty_moov+default_base_moof),
// and normalises the container without re-encoding. Near-zero CPU overhead.
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
		"-loglevel", "error",
		"-i", "pipe:0",
		"-c:v", "libx264",
		"-profile:v", "main",
		"-level:v", "4.0",
		"-x264-params", "bframes=0:keyint=24:min-keyint=24:scenecut=0",
		"-pix_fmt", "yuv420p",
		"-an",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)
	cmd.Stdin = pr
	cmd.Stdout = dst

	srcErrCh := make(chan error, 1)
	go func() {
		err := src(pw)
		pw.CloseWithError(err)
		srcErrCh <- err
	}()

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("ffmpeg video remux: %w", err)
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
		fmt.Printf("stream error (partial): %v\n", err)
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
