package main

// MV segmented video endpoint (feat/mv-vseg).
//
// Exposes the HLS CBCS-decrypted video stream as individual fMP4 fragments,
// re-fragmented by FFmpeg for B-frame safety. Three endpoints:
//
//   GET /api/v1/playback/{id}/vseg/init       — ftyp+moov init segment (blocks until ready)
//   GET /api/v1/playback/{id}/vseg/seg/{n}    — fragment N (blocks until fully written)
//   GET /api/v1/playback/{id}/vseg/manifest   — JSON snapshot {codecs, timescale, frags, done}
//   GET /api/v1/playback/{id}/vseg/seek?t=T   — start seek producer; returns {n, t}
//   DELETE /api/v1/playback/{id}/vseg         — stop all vseg producers for the session
//
// Two-producer design: a "base" producer always runs from t=0 and builds the full
// cache. Seeks within the already-indexed range of base are instant (no new producer).
// Seeks beyond base's current position start a parallel "seek producer" without
// cancelling base. The fetch loop always reads from the "active" producer.
//
// Toggle: set _vsegVideo = true in engine-playback.js (default false).

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/utils/aacstream"
)

// vsegSession holds the per-producer state for one segmented video producer.
type vsegSession struct {
	spw    *diskcache.StreamingPutWriter
	idx    *aacstream.MVLiveIndex
	cancel context.CancelFunc

	mu   sync.RWMutex
	done bool
	err  error // nil = clean EOF; non-nil = producer failed
}

// vsegState holds the per-playback-session state:
//   - base: the from-0 producer, always running; builds the full index on disk.
//     Seek requests that land within already-indexed territory are served instantly
//     from base without starting a new producer.
//   - active: the producer the JS fetch loop is currently reading from.
//     Initially base; replaced by a seek producer when the JS seeks beyond what base
//     has indexed so far.
//
// base always runs until the stream ends or the session is deleted.
// Seek producers run from an HLS segment boundary to end-of-stream and are discarded.
type vsegState struct {
	mu     sync.Mutex
	base   *vsegSession // from-0, permanent
	active *vsegSession // currently serving: base or most recent seek producer
}

// mvVsegStates stores active vseg states keyed by session ID.
var mvVsegStates sync.Map // sessionID → *vsegState

// ensureVsegSession returns an existing active session or creates a new vsegState
// with a base (from-0) producer and returns it. Idempotent — concurrent callers
// on the same session ID get the same active session.
func (s *APIServer) ensureVsegSession(id, assetID string) (*vsegSession, error) {
	if v, ok := mvVsegStates.Load(id); ok {
		state := v.(*vsegState)
		state.mu.Lock()
		active := state.active
		state.mu.Unlock()
		return active, nil
	}

	spw, err := s.diskCache.BeginStreamingPut(assetID, "mv-vseg")
	if err != nil {
		return nil, fmt.Errorf("begin streaming put: %w", err)
	}
	if spw == nil {
		// Another goroutine is already writing this asset; wait for their state to appear.
		if v, ok := mvVsegStates.Load(id); ok {
			state := v.(*vsegState)
			state.mu.Lock()
			active := state.active
			state.mu.Unlock()
			return active, nil
		}
		return nil, fmt.Errorf("vseg streaming put already in-flight for assetID=%s but session not found", assetID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	base := &vsegSession{
		spw:    spw,
		idx:    aacstream.NewMVLiveIndex(),
		cancel: cancel,
	}
	state := &vsegState{base: base, active: base}

	actual, loaded := mvVsegStates.LoadOrStore(id, state)
	if loaded {
		// Another goroutine stored a state first; discard ours.
		cancel()
		spw.Discard()
		existing := actual.(*vsegState)
		existing.mu.Lock()
		active := existing.active
		existing.mu.Unlock()
		return active, nil
	}

	go s.runVsegProducer(ctx, id, assetID, 0, base)
	log.Printf("[vseg] base producer started id=%s assetID=%s", id, assetID)
	return base, nil
}

// runVsegProducer streams decrypted video through FFmpeg and indexes fragments.
// startSec==0 streams from the beginning (committed to disk cache on success).
// startSec>0 streams from the nearest HLS segment boundary (ephemeral; always discarded).
func (s *APIServer) runVsegProducer(ctx context.Context, id, assetID string, startSec float64, vs *vsegSession) {
	// Launch FFmpeg: re-encode to H.264 baseline with -bf 0 to eliminate B-frames
	// (ChunkDemuxer rejects B-frame H.264 in MSE). CRF 18 is visually lossless.
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", "pipe:0",
		"-map", "0:v:0",
		"-c:v", "libx264", "-preset", "medium", "-crf", "18", "-bf", "0",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)

	ffIn, err := cmd.StdinPipe()
	if err != nil {
		s.vsegFinishWithErr(id, vs, fmt.Errorf("ffmpeg stdin: %w", err))
		return
	}
	ffOut, err := cmd.StdoutPipe()
	if err != nil {
		s.vsegFinishWithErr(id, vs, fmt.Errorf("ffmpeg stdout: %w", err))
		return
	}

	if err := cmd.Start(); err != nil {
		s.vsegFinishWithErr(id, vs, fmt.Errorf("ffmpeg start: %w", err))
		return
	}

	// Close FFmpeg stdin when ctx is cancelled so the pm.Stream goroutine can exit.
	go func() {
		<-ctx.Done()
		_ = ffIn.Close()
	}()

	// Feed video stream → FFmpeg stdin in a separate goroutine.
	// For seek producers (startSec > 0) use StreamFrom so the HLS pipeline starts
	// from the segment nearest startSec instead of downloading from segment 0.
	streamErr := make(chan error, 1)
	go func() {
		var err error
		if startSec > 0 {
			_, err = s.pm.StreamFrom(ctx, id, pipeline.KindVideo, startSec, ffIn)
		} else {
			err = s.pm.Stream(ctx, id, pipeline.KindVideo, ffIn)
		}
		_ = ffIn.Close()
		streamErr <- err
	}()

	// Copy FFmpeg stdout → indexer + growing file simultaneously.
	mw := io.MultiWriter(vs.spw, vs.idx)
	_, copyErr := io.Copy(mw, ffOut)
	_ = ffOut.Close()

	waitErr := cmd.Wait()
	<-streamErr

	totalWritten := vs.spw.Written()

	// Finalize last fragment before marking done (Finalize → done → Commit/Discard order).
	vs.idx.Finalize(totalWritten)

	var producerErr error
	if copyErr != nil && ctx.Err() == nil {
		producerErr = fmt.Errorf("copy ffmpeg output: %w", copyErr)
	} else if waitErr != nil && ctx.Err() == nil {
		producerErr = fmt.Errorf("ffmpeg: %w", waitErr)
	}

	vs.mu.Lock()
	vs.done = true
	vs.err = producerErr
	vs.mu.Unlock()

	if producerErr != nil {
		log.Printf("[vseg] producer error id=%s: %v", id, producerErr)
		vs.spw.Discard()
	} else if startSec > 0 {
		// Seek producers are ephemeral: always discard rather than caching a partial stream.
		log.Printf("[vseg] seek producer done id=%s startSec=%.3f written=%d frags=%d", id, startSec, totalWritten, vs.idx.FragCount())
		vs.spw.Discard()
	} else {
		log.Printf("[vseg] base producer done id=%s written=%d frags=%d", id, totalWritten, vs.idx.FragCount())
		_ = vs.spw.Commit()
	}
}

func (s *APIServer) vsegFinishWithErr(id string, vs *vsegSession, err error) {
	log.Printf("[vseg] producer setup error id=%s: %v", id, err)
	vs.mu.Lock()
	vs.done = true
	vs.err = err
	vs.mu.Unlock()
	vs.spw.Discard()
}

// stopVsegSession cancels all vseg producers (base and active) for the session.
func stopVsegSession(id string) {
	if v, ok := mvVsegStates.LoadAndDelete(id); ok {
		state := v.(*vsegState)
		state.mu.Lock()
		base := state.base
		active := state.active
		state.mu.Unlock()
		if base != nil {
			base.cancel()
		}
		if active != nil && active != base {
			active.cancel()
		}
		log.Printf("[vseg] cancelled producers id=%s", id)
	}
}

// handlePlaybackVsegStop cancels all vseg producers for the session without
// releasing the playback session itself. Called by the JS MV cleanup path
// when the UI exits before the full-session DELETE fires.
func (s *APIServer) handlePlaybackVsegStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	stopVsegSession(id)
	w.WriteHeader(http.StatusNoContent)
}

// startVsegSessionFrom starts a new seek producer for id without cancelling base.
// Returns the actual HLS-segment-aligned start time. Base continues running.
func (s *APIServer) startVsegSessionFrom(id, assetID string, startSec float64) (float64, error) {
	// Resolve the actual segment-granular start time without I/O.
	actual, ok := s.pm.GetSeekStart(id, pipeline.KindVideo, startSec)
	if !ok {
		return 0, fmt.Errorf("session %s has no seekable video stream", id)
	}

	// Use a time-unique qualifier so rapid seeks don't collide in the inFlight map.
	qualifier := fmt.Sprintf("mv-vseg-seek-%d", time.Now().UnixNano())
	spw, err := s.diskCache.BeginStreamingPut(assetID, qualifier)
	if err != nil {
		return 0, fmt.Errorf("begin streaming put: %w", err)
	}
	if spw == nil {
		return 0, fmt.Errorf("vseg seek put collision assetID=%s qualifier=%s", assetID, qualifier)
	}

	ctx, cancel := context.WithCancel(context.Background())
	seek := &vsegSession{spw: spw, idx: aacstream.NewMVLiveIndex(), cancel: cancel}

	// Update active in the existing state (base keeps running).
	var state *vsegState
	if v, loaded := mvVsegStates.Load(id); loaded {
		state = v.(*vsegState)
	} else {
		state = &vsegState{active: seek}
		actual2, _ := mvVsegStates.LoadOrStore(id, state)
		state = actual2.(*vsegState)
	}

	state.mu.Lock()
	old := state.active
	state.active = seek
	state.mu.Unlock()

	// Cancel any previous seek producer but NOT the base.
	if old != nil && old != state.base {
		old.cancel()
	}

	// Pass the original startSec, not actual: StreamFrom calls URLsFrom internally
	// (which steps back one segment for overlap). Passing actual would step back twice.
	go s.runVsegProducer(ctx, id, assetID, startSec, seek)
	log.Printf("[vseg] seek producer started id=%s startSec=%.3f actual=%.3f", id, startSec, actual)
	return actual, nil
}

// handlePlaybackVsegInit serves the ftyp+moov init segment.
// Blocks until the first moof has been parsed (initSize > 0) or the stream ends.
func (s *APIServer) handlePlaybackVsegInit(w http.ResponseWriter, r *http.Request) {
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

	vs, err := s.ensureVsegSession(id, sess.AssetID)
	if err != nil {
		log.Printf("[vseg/init] ensureVsegSession error id=%s: %v", id, err)
		http.Error(w, "could not start vseg producer", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	log.Printf("[vseg/init] id=%s", id)

	for {
		initSize, ready := vs.idx.InitSize()
		if ready && initSize > 0 {
			rd := vs.spw.NewReaderAt(0)
			defer rd.Close()
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Length", strconv.FormatInt(initSize, 10))
			_, _ = io.Copy(w, io.LimitReader(rd, initSize))
			return
		}
		vs.mu.RLock()
		done, vsErr := vs.done, vs.err
		vs.mu.RUnlock()
		if done {
			if vsErr != nil {
				http.Error(w, "vseg producer failed", http.StatusInternalServerError)
			} else {
				http.Error(w, "vseg stream ended without init segment", http.StatusNotFound)
			}
			return
		}
		// Block until the writer advances.
		wake := vs.spw.NewReaderAt(vs.spw.Written())
		buf := make([]byte, 1)
		_, readErr := wake.Read(buf)
		wake.Close()
		if readErr != nil && readErr != io.EOF {
			http.Error(w, "read error waiting for init segment", http.StatusInternalServerError)
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// handlePlaybackVsegSeg serves fragment N.
// Blocks until the fragment is fully written or the stream ends.
func (s *APIServer) handlePlaybackVsegSeg(w http.ResponseWriter, r *http.Request) {
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

	nStr := r.PathValue("n")
	n, err := strconv.Atoi(nStr)
	if err != nil || n < 0 {
		http.Error(w, "invalid segment index", http.StatusBadRequest)
		return
	}

	vs, ensureErr := s.ensureVsegSession(id, sess.AssetID)
	if ensureErr != nil {
		log.Printf("[vseg/seg] ensureVsegSession error id=%s: %v", id, ensureErr)
		http.Error(w, "could not start vseg producer", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	log.Printf("[vseg/seg] id=%s n=%d", id, n)

	for {
		written := vs.spw.Written()
		if frag, ready := vs.idx.FragByIndex(n, written); ready {
			size := frag.End - frag.Off
			rd := vs.spw.NewReaderAt(frag.Off)
			defer rd.Close()
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
			_, _ = io.Copy(w, io.LimitReader(rd, size))
			return
		}
		vs.mu.RLock()
		done, vsErr := vs.done, vs.err
		vs.mu.RUnlock()
		if done {
			if vsErr != nil {
				http.Error(w, "vseg producer failed", http.StatusInternalServerError)
				return
			}
			if n >= vs.idx.FragCount() {
				http.NotFound(w, r)
				return
			}
		}
		// Block until more bytes arrive.
		wake := vs.spw.NewReaderAt(written)
		buf := make([]byte, 1)
		_, readErr := wake.Read(buf)
		wake.Close()
		if readErr != nil && readErr != io.EOF {
			http.Error(w, "read error waiting for segment", http.StatusInternalServerError)
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// handlePlaybackVsegManifest returns a non-blocking JSON snapshot of the current
// fragment index. frags:[] is valid while the producer is starting — the frontend
// must not treat it as EOF; use "done":true for that.
func (s *APIServer) handlePlaybackVsegManifest(w http.ResponseWriter, r *http.Request) {
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

	raw, loaded := mvVsegStates.Load(id)
	if !loaded {
		// Producer not yet started — return an empty-but-valid manifest.
		writeJSON(w, http.StatusOK, map[string]any{
			"codecs":    extractVideoCodec(sess.Capabilities.VideoCodec),
			"timescale": uint64(0),
			"frags":     []aacstream.VsegFragTiming{},
			"done":      false,
			"err":       false,
		})
		return
	}
	state := raw.(*vsegState)
	state.mu.Lock()
	vs := state.active
	state.mu.Unlock()

	vs.mu.RLock()
	done, vsErr := vs.done, vs.err
	vs.mu.RUnlock()

	frags := vs.idx.AllFragTimings()
	if frags == nil {
		frags = []aacstream.VsegFragTiming{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"codecs":    extractVideoCodec(sess.Capabilities.VideoCodec),
		"timescale": vs.idx.Timescale(),
		"frags":     frags,
		"done":      done,
		"err":       vsErr != nil,
	})
}

// handlePlaybackVsegSeek handles a seek request.
//
// If the base producer has already indexed the target position, the active producer
// is switched to base immediately (O(1), no new FFmpeg process). Otherwise a new
// seek producer is started from the nearest HLS segment boundary without cancelling
// base.
//
// Returns {"n": fragIndex, "t": actualStart} immediately. The frontend drains its
// SourceBuffer and restarts the fetch loop from seg/n.
func (s *APIServer) handlePlaybackVsegSeek(w http.ResponseWriter, r *http.Request) {
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

	tStr := r.URL.Query().Get("t")
	tSec, err := strconv.ParseFloat(tStr, 64)
	if err != nil || tSec < 0 {
		http.Error(w, "invalid t parameter", http.StatusBadRequest)
		return
	}

	log.Printf("[vseg/seek] id=%s t=%.3f", id, tSec)

	// Fast path: check if base has encoded past tSec so a fragment covering tSec is on disk.
	// "Covering tSec" requires that a later fragment also exists in the index (confirming base
	// went past tSec), or that the base producer is done. Without this, FragIndexForTime
	// returns the last available fragment (e.g. T=25s) even when tSec=164s, causing the
	// frontend to jump to the wrong position.
	if v, ok := mvVsegStates.Load(id); ok {
		state := v.(*vsegState)
		state.mu.Lock()
		base := state.base
		state.mu.Unlock()
		if base != nil {
			fragN, frag, hasIt := base.idx.FragIndexForTime(tSec, base.spw.Written())
			if hasIt {
				// fragN is the last complete fragment with T<=tSec. Base has genuinely
				// encoded past tSec only when there's an indexed fragment with T > tSec,
				// or the base producer finished. Without this check, FragCount()>fragN+1
				// fires incorrectly when the next indexed fragment is still before tSec
				// (e.g. base has T=0.0,0.96,1.33 and tSec=147 — frag#2 not yet finalized
				// makes FragCount()=3 > fragN+1=2 true, wrongly returning fragN=1/T=0.96).
				base.mu.RLock()
				baseDone := base.done
				base.mu.RUnlock()
				basePast := baseDone
				if !basePast {
					for _, ft := range base.idx.AllFragTimings() {
						if ft.T > tSec {
							basePast = true
							break
						}
					}
				}
				if basePast {
					// Switch active to base; cancel any running seek producer.
					state.mu.Lock()
					old := state.active
					state.active = base
					state.mu.Unlock()
					if old != nil && old != base {
						old.cancel()
					}
					log.Printf("[vseg/seek] instant from base id=%s tSec=%.3f fragN=%d fragT=%.3f", id, tSec, fragN, frag.T)
					writeJSON(w, http.StatusOK, map[string]any{"n": fragN, "t": frag.T})
					return
				}
			}
		}
	}

	// Slow path: base hasn't reached tSec yet — start a parallel seek producer.
	actual, startErr := s.startVsegSessionFrom(id, sess.AssetID, tSec)
	if startErr != nil {
		log.Printf("[vseg/seek] startVsegSessionFrom error id=%s: %v", id, startErr)
		http.Error(w, "could not start vseg seek producer", http.StatusInternalServerError)
		return
	}

	// Return immediately — the producer runs in the background.
	// The frontend drains its SourceBuffer and restarts the fetch loop from seg/0.
	writeJSON(w, http.StatusOK, map[string]any{"n": 0, "t": actual})
}

// extractVideoCodec returns the first codec from a comma-separated HLS CODECS string.
// e.g. "avc1.64001f,mp4a.40.2" → "avc1.64001f"
func extractVideoCodec(codecs string) string {
	if i := strings.IndexByte(codecs, ','); i >= 0 {
		codecs = codecs[:i]
	}
	return strings.TrimSpace(codecs)
}
