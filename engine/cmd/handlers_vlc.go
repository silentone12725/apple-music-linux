package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"engine/core/vlc"
)

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
	s.alac.Foreground(req.SessionID, hold)
	src, err := s.openVLCSource(req.SessionID, sess.AssetID, sess.Codec)
	if err != nil {
		s.alac.done(req.SessionID)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if src == nil {
		s.alac.done(req.SessionID) // served over HTTP (no cache); nothing of ours to wait for
	}
	if src != nil {
		log.Printf("[vlc] load in-process session=%s startMs=%d", req.SessionID, req.StartMs)
		err = s.vlcPlayer.LoadSource(src)
	} else {
		url := fmt.Sprintf("http://127.0.0.1:%d/api/v1/playback/%s/audio", s.port, req.SessionID)
		log.Printf("[vlc] load url=%s startMs=%d (no disk cache)", url, req.StartMs)
		err = s.vlcPlayer.Load(url)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
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
		"volume":   volume,
		"muted":    muted,
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
// freshly started download. Returns (nil, nil) when no cache reader can be
// had, in which case the caller falls back to the loopback HTTP endpoint.
func (s *APIServer) openVLCSource(id, assetID, codec string) (vlc.Source, error) {
	if s.diskCache == nil {
		return nil, nil
	}
	// A download can commit between the checks below; retry once to pick up
	// the committed file.
	for range 2 {
		if f, ok := s.diskCache.Get(assetID, codec); ok {
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				return nil, err
			}
			return &fileSource{File: f, size: fi.Size()}, nil
		}
		if spw := s.diskCache.GetStreaming(assetID, codec); spw != nil {
			if r := spw.NewReaderIfActive(); r != nil {
				return r, nil
			}
			continue
		}
		spw, err := s.diskCache.BeginStreamingPut(assetID, codec)
		if err != nil {
			return nil, err
		}
		if spw != nil {
			r := spw.NewReader()
			s.startCacheDownload(id, spw)
			return r, nil
		}
	}
	// A non-streaming precache holds the key; the HTTP endpoint streams uncached.
	return nil, nil
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
