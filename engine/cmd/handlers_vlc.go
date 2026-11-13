package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/core/vlc"
)

// alacCacheVersion is bumped whenever a bug fix changes which bytes are written
// to the ALAC disk cache. On mismatch, all *-alac.m4a files are deleted so VLC
// never replays a fragment-0 that was written by the old, broken key path.
const alacCacheVersion = "cbcs-fairplay-upstream-v9"

// invalidateALACCacheIfStale deletes every committed ALAC cache file when the
// on-disk version marker does not match alacCacheVersion. This is a one-time
// migration on first startup after a decryption fix.
func invalidateALACCacheIfStale(cacheDir string) {
	verFile := filepath.Join(cacheDir, ".alac_ver")
	if data, err := os.ReadFile(verFile); err == nil && strings.TrimSpace(string(data)) == alacCacheVersion {
		return
	}
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	deleted := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), "-alac.m4a") {
			if removeErr := os.Remove(filepath.Join(cacheDir, e.Name())); removeErr == nil {
				deleted++
			}
		}
	}
	if deleted > 0 {
		log.Printf("[vlc] invalidated %d stale ALAC cache file(s) (FairPlay key fix)", deleted)
	}
	_ = os.WriteFile(verFile, []byte(alacCacheVersion), 0o644)
}

var errLoadAbandoned = errors.New("vlc load abandoned")

func (s *APIServer) handleVLCLoad(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		AssetID   string `json:"assetId"`
		StartMs   int64  `json:"startMs"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "sessionId required", http.StatusBadRequest)
		return
	}
	sess, ok := s.pm.GetSession(req.SessionID)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	loadSeq := s.vlcLoads.begin()
	// The player is about to wait on this session's bytes: let its download go first.
	// Nothing to protect when the file is cached or the download is already well ahead.
	hold := true
	if s.diskCache != nil {
		if _, cached := s.diskCache.Path(sess.AssetID, sess.Codec); cached {
			hold = false
		} else if spw := s.diskCache.GetStreaming(sess.AssetID, sess.Codec); spw != nil && spw.Written() >= alacStartBytes {
			hold = false
		}
	}
	var foreground uint64
	selected, selectionErr := s.vlcLoads.runIfCurrent(loadSeq, func() error {
		if err := s.vlcSourceContextErr(r.Context()); err != nil {
			return errLoadAbandoned
		}
		foreground = s.alac.Foreground(req.SessionID, hold)
		return nil
	})
	if !selected {
		http.Error(w, "superseded by a newer load", http.StatusConflict)
		return
	}
	if selectionErr != nil {
		respondLoadAbandoned(w, r)
		return
	}
	src, err := s.openVLCSource(r.Context(), req.SessionID, sess.AssetID, sess.Codec, foreground)
	if err != nil {
		s.alac.release(foreground)
		current, _ := s.vlcLoads.runIfCurrent(loadSeq, func() error { return nil })
		if !current {
			http.Error(w, "superseded by a newer load", http.StatusConflict)
		} else if s.vlcSourceContextErr(r.Context()) != nil {
			respondLoadAbandoned(w, r)
		} else {
			logVLCLoadFailure("open", err)
			http.Error(w, openFailureMessage(err), http.StatusInternalServerError)
		}
		return
	}
	if reader, ok := src.(*diskcache.StreamingReader); ok {
		writer := reader.Writer()
		s.alac.bindWriter(foreground, writer, hold)
		// Check after binding: completion either releases this selection through
		// done(), or is already visible here. Never hold both mutexes together.
		if writer.Written() >= alacStartBytes || writer.Finished() {
			s.alac.release(foreground)
		}
	} else if _, cached := src.(*fileSource); cached {
		s.alac.release(foreground)
	}
	// Source opening/waiting is outside the ordering lock. Ownership transfers
	// at the LoadSource invocation, including all of its failure returns.
	handedOff := false
	loaded, err := s.vlcLoads.runIfCurrent(loadSeq, func() error {
		if s.vlcSourceContextErr(r.Context()) != nil {
			return errLoadAbandoned
		}
		handedOff = true
		if err := s.vlcPlayer.LoadSource(src); err != nil {
			return err
		}
		s.vlcGate.set(req.SessionID)
		if req.StartMs > 0 {
			s.vlcPlayer.SetTime(req.StartMs)
		}
		return nil
	})
	if !handedOff {
		src.Abort()
		src.Close()
	}
	if !loaded || err != nil {
		s.alac.release(foreground)
		if !loaded {
			http.Error(w, "superseded by a newer load", http.StatusConflict)
		} else if errors.Is(err, errLoadAbandoned) {
			respondLoadAbandoned(w, r)
		} else {
			logVLCLoadFailure("player", err)
			http.Error(w, "playback load failed", http.StatusInternalServerError)
		}
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCPause(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	s.vlcPlayer.Pause()
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCResume(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	s.vlcPlayer.Resume()
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCTime(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	posMs, lengthMs, state := s.vlcPlayer.Time()
	volume, muted := s.vlcPlayer.Volume()
	writeJSON(w, http.StatusOK, map[string]any{
		"posMs":    posMs,
		"lengthMs": lengthMs,
		"state":    state,
		"volume":   volume, // live mixer state, from PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1)
		"muted":    muted,
		// eof: the source ended cleanly, so an "ended" state is the real end of the data, not a failed read.
		"eof":    s.vlcPlayer.SourceEnded(),
		"failed": s.vlcPlayer.SourceFailed(),
	})
}

func (s *APIServer) handleVLCSeek(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		PosMs     int64  `json:"posMs"`
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	log.Printf("[vlc seek] API recv posMs=%d sessionId=%s", req.PosMs, req.SessionID)
	if !s.vlcGate.owns(req.SessionID) {
		http.Error(w, "session does not own the player", http.StatusConflict)
		return
	}

	// SetTime seeks within the currently loaded HTTP media. The audio endpoint
	// serves the full cached ALAC file with Accept-Ranges, so libvlc can issue a
	// byte-range request for the target fragment directly — no full reload needed.
	// This avoids the ~1s pause that SeekReload causes by stopping and restarting
	// VLC from scratch.
	s.vlcPlayer.SetTime(req.PosMs)
	log.Printf("[vlc seek] SetTime posMs=%d dispatched", req.PosMs)
	writeJSON(w, http.StatusOK, map[string]any{"actualStartMs": req.PosMs})
}

func (s *APIServer) handleVLCStop(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	s.vlcGate.clear()
	s.vlcPlayer.Stop()
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCVolume(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Volume int `json:"volume"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.vlcPlayer.SetVolume(req.Volume)
	w.WriteHeader(http.StatusOK)
}

// openVLCSource returns a libvlc callback source for the session's audio:
// the committed cache file, a reader on the in-progress download, or a
// freshly started download. Without a usable persistent cache, a private
// temporary spool supplies the same read/seek callbacks and is removed on close.
func (s *APIServer) openVLCSource(ctx context.Context, id, assetID, codec string, foreground uint64) (vlc.Source, error) {
	if err := s.vlcSourceContextErr(ctx); err != nil {
		return nil, err
	}
	if s.diskCache == nil {
		return s.transientVLCSourceForRequest(ctx, id, nil, foreground)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	stopShutdown := context.AfterFunc(s.shutdownCtx, cancel)
	defer stopShutdown()
	var waitErr error
	// Notifications cover writer publication and completion. Bound churn too:
	// no spinning if other producers repeatedly claim and release this key.
	for range 4 {
		if err := s.vlcSourceContextErr(ctx); err != nil {
			return nil, err
		}
		if seriousVLCCacheError(waitErr) {
			return nil, fmt.Errorf("wait for audio cache: %w", waitErr)
		}
		if err := waitCtx.Err(); err != nil {
			return s.transientVLCSourceForRequest(ctx, id, errors.Join(waitErr, err), foreground)
		}
		if f, ok := s.diskCache.Get(assetID, codec); ok {
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				return s.transientVLCSourceForRequest(ctx, id, err, foreground)
			}
			return &fileSource{File: f, size: fi.Size()}, nil
		}
		if spw := s.diskCache.GetStreaming(assetID, codec); spw != nil {
			if r := spw.NewReaderIfActive(); r != nil {
				return r, nil
			}
			waitErr = s.diskCache.WaitForWriter(waitCtx, assetID, codec)
			// Failed owners release the key before notifying; recheck/claim on
			// the next bounded iteration. Request/shutdown cancellation wins.
			if waitErr != nil && waitCtx.Err() == nil && !seriousVLCCacheError(waitErr) {
				logVLCCacheRecovery(waitErr)
			}
			continue
		}
		spw, f, err := s.diskCache.BeginStreamingPutOrGet(assetID, codec)
		if err != nil {
			return s.transientVLCSourceForRequest(ctx, id, err, foreground)
		}
		if f != nil {
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				return s.transientVLCSourceForRequest(ctx, id, err, foreground)
			}
			return &fileSource{File: f, size: fi.Size()}, nil
		}
		if spw != nil {
			if err := s.vlcSourceContextErr(ctx); err != nil {
				spw.Discard()
				return nil, err
			}
			r := spw.NewReader()
			s.startCacheDownload(id, spw)
			return r, nil
		}
		waitErr = s.diskCache.WaitForWriter(waitCtx, assetID, codec)
		if waitErr != nil && waitCtx.Err() == nil && !seriousVLCCacheError(waitErr) {
			logVLCCacheRecovery(waitErr)
		}
	}
	return s.transientVLCSourceForRequest(ctx, id, errors.Join(waitErr, errors.New("audio cache writer changed repeatedly")), foreground)
}

// A source may outlive the load HTTP request, but creation must respect both
// that request and shutdown. Producer ownership stays with the cache or VLC.
func (s *APIServer) vlcSourceContextErr(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.shutdownCtx.Err()
}

// respondLoadAbandoned ends a load that was cut short. A caller that went away is not
// waiting for an answer, so nothing is written. When the engine itself is shutting
// down the caller is still connected, and an empty reply would read as a 200.
func respondLoadAbandoned(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
	http.Error(w, "engine is shutting down", http.StatusServiceUnavailable)
}

// openFailureMessage is what the caller is told when no audio source could be opened.
// The underlying error can wrap CDN URLs and file paths, and the renderer shows the
// reply text in its console and logs, so only a fixed message goes out.
func openFailureMessage(err error) string {
	if seriousVLCCacheError(err) {
		return "audio cache unavailable"
	}
	return "audio source unavailable"
}

// logVLCLoadFailure records why a load failed without the text of errors that can
// carry signed URLs or paths: the errno or the error type is kept. Errors raised by the
// player itself are fixed strings and are logged as they are.
func logVLCLoadFailure(stage string, err error) {
	var errno syscall.Errno
	switch {
	case stage == "player":
		log.Printf("[vlc] load failed: stage=%s: %v", stage, err)
	case errors.As(err, &errno):
		log.Printf("[vlc] load failed: stage=%s cause=%v", stage, errno)
	default:
		log.Printf("[vlc] load failed: stage=%s (error type %T)", stage, err)
	}
}

func seriousVLCCacheError(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EIO) || errors.Is(err, os.ErrPermission)
}

func logVLCCacheRecovery(err error) {
	// Do not print arbitrary producer errors (which can contain signed URLs).
	// Filesystem errno retains useful diagnostics without paths or URLs.
	var errno syscall.Errno
	if errors.As(err, &errno) {
		log.Printf("[vlc] audio cache recovery: cause=%v", errno)
	} else if errors.Is(err, context.DeadlineExceeded) {
		log.Printf("[vlc] audio cache wait timed out; using private source")
	} else {
		log.Printf("[vlc] audio cache owner failed; rechecking source (error type %T)", err)
	}
}

func (s *APIServer) transientVLCSourceForRequest(ctx context.Context, id string, cacheErr error, foreground uint64) (vlc.Source, error) {
	if err := s.vlcSourceContextErr(ctx); err != nil {
		return nil, err
	}
	// These indicate a real storage failure, rather than an unavailable cache
	// directory or writer contention. Do not mask them with another download.
	if seriousVLCCacheError(cacheErr) {
		return nil, fmt.Errorf("audio cache: %w", cacheErr)
	}
	if cacheErr != nil {
		logVLCCacheRecovery(cacheErr)
	}
	src, err := s.transientVLCSource(id, foreground)
	if err != nil {
		return nil, fmt.Errorf("private audio source: %w", errors.Join(cacheErr, err))
	}
	if err := s.vlcSourceContextErr(ctx); err != nil {
		src.Abort()
		src.Close()
		return nil, err
	}
	return src, nil
}

func (s *APIServer) transientVLCSource(id string, foreground uint64) (vlc.Source, error) {
	return newTransientVLCSource(s.shutdownCtx, func(ctx context.Context, w io.Writer) error {
		defer func() {
			if foreground != 0 {
				s.alac.release(foreground)
			} else {
				s.alac.done(id)
			}
		}()
		return s.pm.Stream(ctx, id, pipeline.KindAudio, s.alac.writer(ctx, id, w))
	})
}

// fileSource adapts a committed cache file to vlc.Source. Reads never block,
// so Abort is a no-op.
type fileSource struct {
	*os.File
	size int64
}

func (f *fileSource) Size() int64 { return f.size }
func (f *fileSource) Abort()      {}
func (f *fileSource) Close()      { f.File.Close() }

var _ vlc.Source = (*fileSource)(nil)
