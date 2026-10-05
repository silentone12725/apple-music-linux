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
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
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

	// ephemeral producers are never committed to the disk cache (seek producers,
	// and a base producer started while another session still writes the key).
	ephemeral bool

	// direct marks a fragment-level seek session: its output is the decrypted raw
	// stream (no FFmpeg remux), so it has its own init segment and a raw timeline.
	direct bool

	mu   sync.RWMutex
	done bool
	err  error // nil = clean EOF; non-nil = producer failed
}

// pinnedCancel returns a cancel func that, besides cancelling the producer, releases
// a reader reference taken on spw right now. Commit/Discard drop the writer's own
// reference, and the cache file is closed when the last one goes — so without the pin,
// a fragment request arriving after the producer finished reads from a closed file and
// gets an empty body, which the player appends as nothing and then races through the
// remaining fragment numbers.
func pinnedCancel(spw *diskcache.StreamingPutWriter, cancel context.CancelFunc) context.CancelFunc {
	pin := spw.NewReader()
	var once sync.Once
	return func() {
		cancel()
		once.Do(pin.Close)
	}
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

	// sbDirect records which init segment the player's SourceBuffer was last told
	// to use: false = the FFmpeg-produced one (base and FFmpeg seek producers),
	// true = a direct session's raw one. The player re-appends the init when it flips.
	sbDirect bool
}

// markInitKind records the init kind handed to the player with a seek response and
// reports whether it differs from the previous one (the player must then re-append
// the init segment before any fragments).
func (st *vsegState) markInitKind(direct bool) (changed bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	changed = st.sbDirect != direct
	st.sbDirect = direct
	return changed
}

// vsegStateFor returns the state for id, or nil.
func vsegStateFor(id string) *vsegState {
	if v, ok := mvVsegStates.Load(id); ok {
		return v.(*vsegState)
	}
	return nil
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
	ephemeral := false
	if spw == nil {
		// Another goroutine is already writing this asset; wait for their state to appear.
		if v, ok := mvVsegStates.Load(id); ok {
			state := v.(*vsegState)
			state.mu.Lock()
			active := state.active
			state.mu.Unlock()
			return active, nil
		}
		// A different session (e.g. an earlier play of the same MV) still owns
		// the cache key. Produce into a private, uncached file instead of failing.
		spw, err = s.diskCache.BeginStreamingPut(assetID, fmt.Sprintf("mv-vseg-dup-%d", time.Now().UnixNano()))
		if err != nil || spw == nil {
			return nil, fmt.Errorf("vseg streaming put for assetID=%s: %v", assetID, err)
		}
		ephemeral = true
	}

	ctx, cancel := context.WithCancel(s.shutdownCtx)
	base := &vsegSession{
		spw:       spw,
		idx:       aacstream.NewMVLiveIndex(),
		cancel:    pinnedCancel(spw, cancel),
		ephemeral: ephemeral,
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
	// Select codec args based on the stream's codec string.
	// H.264 (avc1/avc3): stream-copy — no encode latency, first fragment out in ~50ms.
	// HEVC/unknown: transcode to H.264 baseline with -bf 0 (Chrome Linux has no HEVC MSE
	// decoder without a patched Electron build).
	var vArgs []string
	if sess, ok := s.pm.GetSession(id); ok {
		c := extractVideoCodec(sess.Capabilities.VideoCodec)
		if strings.HasPrefix(c, "avc1") || strings.HasPrefix(c, "avc3") {
			vArgs = []string{"-c:v", "copy"}
		}
	}
	if vArgs == nil {
		vArgs = []string{"-c:v", "libx264", "-preset", "fast", "-crf", "23", "-bf", "0"}
	}

	ffArgs := []string{"-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:v:0"}
	ffArgs = append(ffArgs, vArgs...)
	ffArgs = append(ffArgs, "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1")
	cmd := exec.CommandContext(ctx, "ffmpeg", ffArgs...)

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
	} else if vs.ephemeral || ctx.Err() != nil {
		// Ephemeral (collision fallback) or cancelled mid-stream: discard incomplete data.
		log.Printf("[vseg] seek producer discarded id=%s startSec=%.3f written=%d (ephemeral=%v cancelled=%v)",
			id, startSec, totalWritten, vs.ephemeral, ctx.Err() != nil)
		vs.spw.Discard()
	} else if startSec > 0 {
		// Non-ephemeral seek producer ran to completion: commit for backward-seek reuse.
		log.Printf("[vseg] seek producer done id=%s startSec=%.3f written=%d frags=%d (cached)", id, startSec, totalWritten, vs.idx.FragCount())
		_ = vs.spw.Commit()
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

// setActiveVsegSession replaces the active producer in the session state.
// It cancels the previous active producer if it was a seek producer (not base).
// Base always keeps running.
func setActiveVsegSession(id string, seek *vsegSession) {
	var state *vsegState
	if v, loaded := mvVsegStates.Load(id); loaded {
		state = v.(*vsegState)
	} else {
		// Leave active unset: seeding it with `seek` made the swap below cancel the
		// session it was installing.
		state = &vsegState{}
		actual, _ := mvVsegStates.LoadOrStore(id, state)
		state = actual.(*vsegState)
	}

	state.mu.Lock()
	old := state.active
	state.active = seek
	state.mu.Unlock()

	if old != nil && old != state.base {
		old.cancel()
	}
}

// loadCachedSeek loads a committed seek-cache entry and reconstructs its fragment
// index by replaying the fMP4 bytes. Returns a vsegSession in done=true state,
// ready to serve segments without starting an FFmpeg process.
func (s *APIServer) loadCachedSeek(assetID, qualifier string) (*vsegSession, error) {
	spw, err := s.diskCache.NewFromCommitted(assetID, qualifier)
	if err != nil {
		return nil, fmt.Errorf("open committed seek: %w", err)
	}
	fileSize := spw.Written()

	f, ok := s.diskCache.Get(assetID, qualifier)
	if !ok {
		spw.Release()
		return nil, fmt.Errorf("cache miss after path check")
	}
	defer f.Close()

	idx := aacstream.NewMVLiveIndex()
	if _, err := io.Copy(idx, f); err != nil {
		spw.Release()
		return nil, fmt.Errorf("index rebuild: %w", err)
	}
	idx.Finalize(fileSize)
	if idx.FragCount() == 0 {
		spw.Release()
		return nil, fmt.Errorf("no fragments in cached seek file")
	}

	return &vsegSession{
		spw:    spw,
		idx:    idx,
		cancel: spw.Release, // Release file descriptor when session is stopped
		done:   true,
	}, nil
}

// startVsegSessionFrom starts a new seek producer for id without cancelling base.
// Returns the actual HLS-segment-aligned start time. Base continues running.
func (s *APIServer) startVsegSessionFrom(id, assetID string, startSec float64) (float64, error) {
	// Resolve the actual segment-granular start time without I/O.
	actual, ok := s.pm.GetSeekStart(id, pipeline.KindVideo, startSec)
	if !ok {
		return 0, fmt.Errorf("session %s has no seekable video stream", id)
	}

	// Deterministic qualifier: same HLS-boundary position always maps to the same
	// cache file so completed seek producers can be reused for backward seeks.
	qualifier := fmt.Sprintf("mv-vseg-seek-%.3f", actual)

	// Fast path: a previous seek to this exact HLS boundary is already on disk.
	if _, hit := s.diskCache.Path(assetID, qualifier); hit {
		if seek, err := s.loadCachedSeek(assetID, qualifier); err == nil {
			setActiveVsegSession(id, seek)
			log.Printf("[vseg] seek cache hit id=%s actual=%.3f frags=%d", id, actual, seek.idx.FragCount())
			return actual, nil
		}
	}

	spw, err := s.diskCache.BeginStreamingPut(assetID, qualifier)
	if err != nil {
		return 0, fmt.Errorf("begin streaming put: %w", err)
	}
	ephemeral := false
	if spw == nil {
		// Another goroutine is already writing this key; fall back to a unique
		// ephemeral qualifier so this seek still works without colliding.
		ephemeral = true
		qualifier = fmt.Sprintf("mv-vseg-seek-eph-%d", time.Now().UnixNano())
		spw, err = s.diskCache.BeginStreamingPut(assetID, qualifier)
		if err != nil || spw == nil {
			return 0, fmt.Errorf("vseg seek put fallback assetID=%s: %v", assetID, err)
		}
	}

	ctx, cancel := context.WithCancel(s.shutdownCtx)
	ctx = aacstream.WithSeekPriority(ctx)
	seek := &vsegSession{spw: spw, idx: aacstream.NewMVLiveIndex(), cancel: pinnedCancel(spw, cancel), ephemeral: ephemeral}

	setActiveVsegSession(id, seek)
	holdBackgroundUntilPlayable(ctx, seek)

	// Pass the original startSec, not actual: StreamFrom calls URLsFrom internally
	// (which steps back one segment for overlap). Passing actual would step back twice.
	go s.runVsegProducer(ctx, id, assetID, startSec, seek)
	log.Printf("[vseg] seek producer started id=%s startSec=%.3f actual=%.3f ephemeral=%v", id, startSec, actual, ephemeral)
	return actual, nil
}

// directSeekEnabled reports whether fragment-level seeks may be used for this request.
// AML_MV_DIRECT_SEEK=0 disables them globally; ?direct=0 disables one request (the
// player sets it after its own validation of the direct output failed).
func directSeekEnabled(r *http.Request) bool {
	return os.Getenv("AML_MV_DIRECT_SEEK") != "0" && r.URL.Query().Get("direct") != "0"
}

// vsegCodecIsCopyable reports whether the stream's video can be handed to the browser
// as is. The FFmpeg path stream-copies H.264 and transcodes anything else (Chrome on
// Linux has no HEVC MSE decoder), and the direct path never transcodes.
func vsegCodecIsCopyable(codecs string) bool {
	c := extractVideoCodec(codecs)
	return strings.HasPrefix(c, "avc1") || strings.HasPrefix(c, "avc3")
}

const (
	directPlanTimeout  = 6 * time.Second // mapping the segment: a few small range reads
	directFirstTimeout = 8 * time.Second // from plan to the first complete fragment
)

// startVsegSessionDirect starts a fragment-level seek session and returns once its
// first fragment is indexed, so the caller can still fall back to the FFmpeg producer
// if anything fails before that.
func (s *APIServer) startVsegSessionDirect(id, assetID string, startSec float64) (pipeline.DirectInfo, error) {
	planCtx, planCancel := context.WithTimeout(aacstream.WithSeekPriority(s.shutdownCtx), directPlanTimeout)
	defer planCancel()
	src, info, err := s.pm.PrepareDirectSeek(planCtx, id, pipeline.KindVideo, startSec)
	if err != nil {
		return pipeline.DirectInfo{}, err
	}

	spw, err := s.diskCache.BeginStreamingPut(assetID, fmt.Sprintf("mv-vseg-direct-%d", time.Now().UnixNano()))
	if err != nil || spw == nil {
		return pipeline.DirectInfo{}, fmt.Errorf("direct streaming put: %v", err)
	}
	ctx, cancel := context.WithCancel(aacstream.WithSeekPriority(s.shutdownCtx))
	vs := &vsegSession{
		spw: spw, idx: aacstream.NewMVLiveIndex(), cancel: pinnedCancel(spw, cancel),
		ephemeral: true, direct: true,
	}
	setActiveVsegSession(id, vs)
	holdBackgroundUntilPlayable(ctx, vs)
	go s.runVsegDirectProducer(ctx, id, src, vs)

	deadline := time.NewTimer(directFirstTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, started := vs.idx.FragOffByIndex(0); started {
			if size, ok := vs.idx.InitSize(); ok && size > 0 {
				return info, nil
			}
		}
		vs.mu.RLock()
		done, perr := vs.done, vs.err
		vs.mu.RUnlock()
		if done {
			vs.cancel()
			if perr == nil {
				perr = errors.New("direct stream ended before its first fragment")
			}
			return pipeline.DirectInfo{}, perr
		}
		select {
		case <-deadline.C:
			vs.cancel()
			return pipeline.DirectInfo{}, errors.New("timed out waiting for the first direct fragment")
		case <-ctx.Done():
			return pipeline.DirectInfo{}, ctx.Err()
		case <-tick.C:
		}
	}
}

// runVsegDirectProducer feeds src through the session's decrypt stage straight into
// the session's file and index — the same sink the FFmpeg producer writes to, so the
// init, segment and manifest handlers serve it unchanged.
func (s *APIServer) runVsegDirectProducer(ctx context.Context, id string, src pipeline.Source, vs *vsegSession) {
	err := s.pm.StreamSource(ctx, id, pipeline.KindVideo, src, io.MultiWriter(vs.spw, vs.idx))
	vs.idx.Finalize(vs.spw.Written())

	var producerErr error
	if err != nil && ctx.Err() == nil {
		producerErr = fmt.Errorf("direct stream: %w", err)
	}
	vs.mu.Lock()
	vs.done = true
	vs.err = producerErr
	vs.mu.Unlock()

	if producerErr != nil {
		log.Printf("[vseg] direct producer error id=%s: %v", id, producerErr)
	} else {
		log.Printf("[vseg] direct producer done id=%s written=%d frags=%d cancelled=%v", id, vs.spw.Written(), vs.idx.FragCount(), ctx.Err() != nil)
	}
	vs.spw.Discard() // direct sessions are never cached
}

// Background (from-0) downloads wait for the seek producer to get playable, bounded so
// a stuck seek can never park them for good.
const (
	seekHoldMax       = 12 * time.Second
	seekHoldFragments = 4 // fragments produced before the from-0 download may resume
)

// holdBackgroundUntilPlayable parks the from-0 producer's downloads until the seek
// producer has produced enough fragments to start playing, finished, or been cancelled.
func holdBackgroundUntilPlayable(ctx context.Context, seek *vsegSession) {
	release := aacstream.HoldBackground(seekHoldMax)
	go func() {
		defer release()
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				seek.mu.RLock()
				done := seek.done
				seek.mu.RUnlock()
				if done || seek.idx.FragCount() >= seekHoldFragments {
					return
				}
			}
		}
	}()
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
		if err := waitForGrowth(ctx, vs.spw, vs.spw.Written()); err != nil {
			if ctx.Err() == nil {
				http.Error(w, "read error waiting for init segment", http.StatusInternalServerError)
			}
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

	// Phase 1: wait until fragment n is indexed (Off known). This happens as soon as FFmpeg
	// writes the moof header for fragment n — well before the mdat payload is written.
	var fragOff int64
	for {
		off, started := vs.idx.FragOffByIndex(n)
		if started {
			fragOff = off
			break
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
		if err := waitForGrowth(ctx, vs.spw, vs.spw.Written()); err != nil {
			if ctx.Err() == nil {
				http.Error(w, "read error waiting for segment", http.StatusInternalServerError)
			}
			return
		}
	}

	// Phase 2: stream response. Fragment n is indexed; start sending bytes immediately
	// without waiting for fragment n+1's moof (which would set End).
	//
	// The fragment's end is taken, in order of preference, from End (next moof seen),
	// then from the end of its own mdat (known as soon as that header is parsed). If
	// neither is known yet we stream only bytes the indexer has already examined, minus
	// a safety margin: the index is fed after the bytes are written, so trusting the
	// raw write frontier lets us run across the boundary into the next moof when the
	// producer bursts ahead of the indexer (the browser then fails with "Failed to
	// prepare video sample for decode").
	//
	// safeStreamMargin must exceed the largest moof header; long GOPs produce moofs of
	// several KiB, so 64 KiB leaves ample room.
	const safeStreamMargin = 64 << 10

	fl, hasFlusher := w.(http.Flusher)
	w.Header().Set("Content-Type", "video/mp4")
	// Omit Content-Length — chunked transfer encoding lets the browser start decoding
	// fragment bytes as they arrive rather than buffering the full fragment first.

	rd := vs.spw.NewReaderAt(fragOff)
	defer rd.Close()

	var sent int64
	buf := make([]byte, 32<<10)

	for {
		// Order matters: read the frontier BEFORE the limit. If the limit is unknown at
		// this point, any moof inside the bytes we are about to send would already have
		// been indexed (the frontier is capped at what the indexer has parsed).
		frontier := vs.spw.Written()
		indexerBehind := false
		if parsed := vs.idx.ParsedBytes(); parsed < frontier {
			frontier = parsed
			indexerBehind = true
		}

		// Exact end known: flush the remainder and return.
		if limit, known := vs.idx.FragLimitByIndex(n); known {
			remaining := (limit - fragOff) - sent
			if remaining > 0 {
				if copied, err := io.CopyN(w, rd, remaining); err != nil {
					// A short body would be appended as a truncated fragment; abort the
					// response so the client sees a failed fetch instead.
					if ctx.Err() == nil {
						log.Printf("[vseg/seg] id=%s n=%d short read: %d/%d bytes: %v", id, n, copied, remaining, err)
					}
					panic(http.ErrAbortHandler)
				}
			}
			if hasFlusher {
				fl.Flush()
			}
			return
		}

		// End not yet known. Send bytes up to (frontier - safeMargin).
		safeBytes := (frontier - fragOff) - sent - safeStreamMargin
		if safeBytes > 0 {
			toRead := safeBytes
			if toRead > int64(len(buf)) {
				toRead = int64(len(buf))
			}
			n2, _ := rd.Read(buf[:toRead])
			if n2 > 0 {
				_, _ = w.Write(buf[:n2])
				sent += int64(n2)
				if hasFlusher {
					fl.Flush()
				}
			}
			continue // re-check the limit before blocking
		}

		// Nothing safe to send yet — block until more bytes arrive or producer finishes.
		vs.mu.RLock()
		done, vsErr := vs.done, vs.err
		vs.mu.RUnlock()
		if done {
			if vsErr != nil {
				return
			}
			// Finalize has been called; End should now be set.
			if end, known := vs.idx.FragEndByIndex(n); known {
				remaining := (end - fragOff) - sent
				if remaining > 0 {
					_, _ = io.CopyN(w, rd, remaining)
				}
				if hasFlusher {
					fl.Flush()
				}
			}
			return
		}

		// The indexer is still catching up with bytes that are already written. Parsing
		// them can reveal this fragment's end without any new write, and waiting for
		// growth would then stall until the producer's next burst — so poll briefly.
		if indexerBehind {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Millisecond):
			}
			continue
		}

		// Other wait errors are re-checked via vs.done on the next iteration.
		if waitForGrowth(ctx, vs.spw, vs.spw.Written()); ctx.Err() != nil {
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
					writeJSON(w, http.StatusOK, map[string]any{"n": fragN, "t": frag.T, "reinit": state.markInitKind(false)})
					return
				}
			}
		}
	}

	// Active-seek fast path: if there is already a seek producer whose indexed
	// range covers tSec, reuse it directly without starting a new FFmpeg process.
	// This handles forward seeks within the current producer's range and backward
	// seeks to positions it has already encoded past.
	if v, ok := mvVsegStates.Load(id); ok {
		state := v.(*vsegState)
		state.mu.Lock()
		active := state.active
		base := state.base
		state.mu.Unlock()
		// Direct sessions are never reused: their timeline is raw and their init differs,
		// and starting a new one is cheap.
		if active != nil && active != base && !active.direct {
			fragN, frag, hasIt := active.idx.FragIndexForTime(tSec, active.spw.Written())
			if hasIt {
				active.mu.RLock()
				activeDone := active.done
				active.mu.RUnlock()
				activePast := activeDone
				if !activePast {
					for _, ft := range active.idx.AllFragTimings() {
						if ft.T > tSec {
							activePast = true
							break
						}
					}
				}
				if activePast {
					log.Printf("[vseg/seek] instant from active seek id=%s tSec=%.3f fragN=%d fragT=%.3f", id, tSec, fragN, frag.T)
					writeJSON(w, http.StatusOK, map[string]any{"n": fragN, "t": frag.T, "reinit": state.markInitKind(false)})
					return
				}
			}
		}
	}

	// Fragment-level path: fetch and decrypt only the fragment holding tSec and what
	// follows, with no FFmpeg. Any failure before the first fragment is ready falls
	// through to the FFmpeg seek producer below.
	if directSeekEnabled(r) && vsegCodecIsCopyable(sess.Capabilities.VideoCodec) {
		info, dErr := s.startVsegSessionDirect(id, sess.AssetID, tSec)
		if dErr == nil {
			reinit := false
			if st := vsegStateFor(id); st != nil {
				reinit = st.markInitKind(true)
			}
			log.Printf("[vseg/seek] direct id=%s t=%.3f startSec=%.3f tsOffset=%.3f reinit=%v", id, tSec, info.StartSec, info.TsOffset, reinit)
			writeJSON(w, http.StatusOK, map[string]any{
				"n": 0, "t": info.StartSec, "direct": true, "tsOffset": info.TsOffset, "reinit": reinit,
			})
			return
		}
		log.Printf("[vseg/seek] direct seek unavailable id=%s t=%.3f: %v — falling back to FFmpeg", id, tSec, dErr)
	}

	// Slow path: base hasn't reached tSec yet — start a parallel seek producer.
	// Use the HLS segment timing table (available immediately from the parsed playlist)
	// to compute actualStart for any position in the video without waiting for the
	// base producer. startVsegSessionFrom calls SourceFrom(tSec) → URLsFromExact
	// which uses the same table, so actual will match what we log here.
	if timings, ok := s.pm.GetSegmentTimings(id, pipeline.KindVideo); ok && len(timings) > 0 {
		best := timings[0]
		for _, t := range timings {
			if t <= tSec {
				best = t
			} else {
				break
			}
		}
		log.Printf("[vseg/seek] table lookup id=%s tSec=%.3f → actualStart=%.3f", id, tSec, best)
	}

	actual, startErr := s.startVsegSessionFrom(id, sess.AssetID, tSec)
	if startErr != nil {
		log.Printf("[vseg/seek] startVsegSessionFrom error id=%s: %v", id, startErr)
		http.Error(w, "could not start vseg seek producer", http.StatusInternalServerError)
		return
	}

	// Return immediately — the producer runs in the background.
	// The frontend drains its SourceBuffer and restarts the fetch loop from seg/0.
	reinit := false
	if st := vsegStateFor(id); st != nil {
		reinit = st.markInitKind(false)
	}
	writeJSON(w, http.StatusOK, map[string]any{"n": 0, "t": actual, "reinit": reinit})
}

// extractVideoCodec returns the first codec from a comma-separated HLS CODECS string.
// e.g. "avc1.64001f,mp4a.40.2" → "avc1.64001f"
func extractVideoCodec(codecs string) string {
	if i := strings.IndexByte(codecs, ','); i >= 0 {
		codecs = codecs[:i]
	}
	return strings.TrimSpace(codecs)
}

// waitForGrowth blocks until the writer has passed offset from or finished, or
// until ctx ends (client disconnect) — whichever comes first. Returns ctx's
// error when cancelled, or a writer failure other than a clean end.
func waitForGrowth(ctx context.Context, spw *diskcache.StreamingPutWriter, from int64) error {
	wake := spw.NewReaderAt(from)
	defer wake.Close()
	stop := context.AfterFunc(ctx, wake.Abort)
	defer stop()
	var b [1]byte
	_, err := wake.Read(b[:])
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err != nil && err != io.EOF {
		return err
	}
	return nil
}
