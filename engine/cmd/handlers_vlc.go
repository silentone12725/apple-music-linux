package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"engine/core/diskcache"
	"engine/core/pipeline"
	"engine/core/vlc"
	"engine/internal/vlog"
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
	foreground := s.alac.Foreground(req.SessionID, hold)
	src, err := s.openVLCSource(r.Context(), req.SessionID, sess.AssetID, sess.Codec)
	if err != nil {
		s.alac.release(foreground)
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
	if r.Context().Err() != nil {
		src.Abort()
		src.Close()
		s.alac.release(foreground)
		return
	}
	vlog.Printf("[vlc] load in-process session=%s startMs=%d", req.SessionID, req.StartMs)
	err = s.vlcPlayer.LoadSource(src)
	if err != nil {
		s.alac.release(foreground)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.vlcGate.set(req.SessionID)
	// If a specific start position was requested, seek there after VLC reaches
	// playing state. SetTime is async and polls until VLC is ready.
	if req.StartMs > 0 {
		s.vlcPlayer.SetTime(req.StartMs)
		log.Printf("[vlc] SetTime startMs=%d queued after load", req.StartMs)
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
func (s *APIServer) openVLCSource(ctx context.Context, id, assetID, codec string) (vlc.Source, error) {
	if s.diskCache == nil {
		return s.transientVLCSource(id)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// Notifications cover writer publication and completion. Bound churn too:
	// no spinning if other producers repeatedly claim and release this key.
	for range 4 {
		if f, ok := s.diskCache.Get(assetID, codec); ok {
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				return s.transientVLCSource(id)
			}
			return &fileSource{File: f, size: fi.Size()}, nil
		}
		if spw := s.diskCache.GetStreaming(assetID, codec); spw != nil {
			if r := spw.NewReaderIfActive(); r != nil {
				return r, nil
			}
			if err := s.diskCache.WaitForWriter(waitCtx, assetID, codec); err != nil {
				return nil, fmt.Errorf("wait for audio cache: %w", err)
			}
			continue
		}
		spw, f, err := s.diskCache.BeginStreamingPutOrGet(assetID, codec)
		if err != nil {
			return s.transientVLCSource(id)
		}
		if f != nil {
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				return s.transientVLCSource(id)
			}
			return &fileSource{File: f, size: fi.Size()}, nil
		}
		if spw != nil {
			r := spw.NewReader()
			s.startCacheDownload(id, spw)
			return r, nil
		}
		if err := s.diskCache.WaitForWriter(waitCtx, assetID, codec); err != nil {
			return nil, fmt.Errorf("wait for audio cache: %w", err)
		}
	}
	return nil, fmt.Errorf("audio cache writer changed repeatedly; retry loading")
}

func (s *APIServer) transientVLCSource(id string) (vlc.Source, error) {
	return newTransientVLCSource(s.shutdownCtx, func(ctx context.Context, w io.Writer) error {
		defer s.alac.done(id)
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
