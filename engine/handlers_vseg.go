package main

// MV segmented video endpoint (feat/mv-vseg).
//
// Exposes the HLS CBCS-decrypted video stream as individual fMP4 fragments,
// re-fragmented by FFmpeg for B-frame safety. Three endpoints:
//
//   GET /api/v1/playback/{id}/vseg/init       — ftyp+moov init segment (blocks until ready)
//   GET /api/v1/playback/{id}/vseg/seg/{n}    — fragment N (blocks until fully written)
//   GET /api/v1/playback/{id}/vseg/manifest   — JSON snapshot {codecs, timescale, frags, done}
//
// The frontend MSE feeder fetches init then seg/0, seg/1, … to feed a SourceBuffer.
// On seek it re-fetches manifest to find the target segment index and restarts the loop.
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

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/utils/aacstream"
)

// vsegSession holds the per-session state for the segmented video producer.
type vsegSession struct {
	spw    *diskcache.StreamingPutWriter
	idx    *aacstream.MVLiveIndex
	cancel context.CancelFunc

	mu   sync.RWMutex
	done bool
	err  error // nil = clean EOF; non-nil = producer failed
}

// mvVsegSessions stores active vseg sessions keyed by session ID.
var mvVsegSessions sync.Map // sessionID → *vsegSession

// ensureVsegSession returns an existing session or creates a new one and starts
// the FFmpeg producer goroutine. Idempotent — concurrent callers on the same
// session ID get the same session.
func (s *APIServer) ensureVsegSession(id, assetID string) (*vsegSession, error) {
	if v, ok := mvVsegSessions.Load(id); ok {
		return v.(*vsegSession), nil
	}

	spw, err := s.diskCache.BeginStreamingPut(assetID, "mv-vseg")
	if err != nil {
		return nil, fmt.Errorf("begin streaming put: %w", err)
	}
	if spw == nil {
		// Another goroutine is already writing this asset; wait for their session to appear.
		if v, ok := mvVsegSessions.Load(id); ok {
			return v.(*vsegSession), nil
		}
		return nil, fmt.Errorf("vseg streaming put already in-flight for assetID=%s but session not found", assetID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	vs := &vsegSession{
		spw:    spw,
		idx:    aacstream.NewMVLiveIndex(),
		cancel: cancel,
	}

	actual, loaded := mvVsegSessions.LoadOrStore(id, vs)
	if loaded {
		// Another goroutine stored a session first; discard ours.
		cancel()
		spw.Discard()
		return actual.(*vsegSession), nil
	}

	go s.runVsegProducer(ctx, id, assetID, vs)
	log.Printf("[vseg] producer started id=%s assetID=%s", id, assetID)
	return vs, nil
}

// runVsegProducer streams decrypted video through FFmpeg and indexes fragments.
func (s *APIServer) runVsegProducer(ctx context.Context, id, assetID string, vs *vsegSession) {
	// Launch FFmpeg: remux only (-c:v copy), add keyframe-aligned fragment boundaries.
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", "pipe:0",
		"-map", "0:v:0",
		"-c:v", "copy",
		"-movflags", "frag_keyframe+empty_moov",
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

	// Feed pm.Stream(KindVideo) → FFmpeg stdin in a separate goroutine.
	streamErr := make(chan error, 1)
	go func() {
		err := s.pm.Stream(ctx, id, pipeline.KindVideo, ffIn)
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
	} else {
		log.Printf("[vseg] producer done id=%s written=%d frags=%d", id, totalWritten, vs.idx.FragCount())
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

// stopVsegSession cancels any active vseg producer for the given session ID.
func stopVsegSession(id string) {
	if v, ok := mvVsegSessions.LoadAndDelete(id); ok {
		v.(*vsegSession).cancel()
		log.Printf("[vseg] cancelled producer id=%s", id)
	}
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

	raw, loaded := mvVsegSessions.Load(id)
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
	vs := raw.(*vsegSession)
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

// extractVideoCodec returns the first codec from a comma-separated HLS CODECS string.
// e.g. "avc1.64001f,mp4a.40.2" → "avc1.64001f"
func extractVideoCodec(codecs string) string {
	if i := strings.IndexByte(codecs, ','); i >= 0 {
		codecs = codecs[:i]
	}
	return strings.TrimSpace(codecs)
}
