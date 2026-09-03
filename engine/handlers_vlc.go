package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "sessionId required", http.StatusBadRequest)
		return
	}
	// Always load via HTTP so VLC gets a byte-range-capable response (http.ServeContent).
	// The audio endpoint downloads the full track to disk on first access and then
	// serves it with Accept-Ranges support — enabling accurate SetTime seeks.
	url := fmt.Sprintf("http://127.0.0.1:%d/api/v1/playback/%s/audio", s.port, req.SessionID)
	log.Printf("[vlc] load url=%s startMs=%d", url, req.StartMs)

	if err := s.vlcPlayer.Load(url); err != nil {
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
	writeJSON(w, http.StatusOK, map[string]any{
		"posMs":    posMs,
		"lengthMs": lengthMs,
		"state":    state,
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

func (s *APIServer) handleVLCVolume(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Volume int `json:"volume"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.vlcPlayer.SetVolume(req.Volume)
	w.WriteHeader(http.StatusOK)
}
