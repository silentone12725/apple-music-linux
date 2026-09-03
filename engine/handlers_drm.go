package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"engine/core/drm"
)

// drmStatusResponse embeds the DRM snapshot and adds backend-selection info
// and session age metadata for proactive refresh coordination.
type drmStatusResponse struct {
	drm.DRMSnapshot
	Backend      backendStatus `json:"backend"`
	ReadySinceMs int64         `json:"readySinceMs,omitempty"`
	SessionAgeMs int64         `json:"sessionAgeMs,omitempty"`
	SessionTTLMs int64         `json:"sessionTTLMs,omitempty"`
}

type backendStatus struct {
	Selected       string `json:"selected"`
	FallbackReason string `json:"fallbackReason,omitempty"`
}

func (s *APIServer) handleDRMStatus(w http.ResponseWriter, r *http.Request) {
	selected := s.backendName
	reason := ""
	if s.backendSel != nil {
		if n := s.backendSel.ActiveName(); n != "" {
			selected = n
		}
		reason = s.backendSel.FallbackReason()
	}
	resp := drmStatusResponse{
		DRMSnapshot: s.dm.Status(),
		Backend:     backendStatus{Selected: selected, FallbackReason: reason},
	}
	if since := s.lifecycle.DRMReadySince(); !since.IsZero() {
		resp.ReadySinceMs = since.UnixMilli()
		resp.SessionAgeMs = time.Since(since).Milliseconds()
		resp.SessionTTLMs = drmSessionTTL.Milliseconds()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *APIServer) handleDRMAuthenticate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10) // 4 KB
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Email == "" || req.Password == "" {
		http.Error(w, "email and password required", http.StatusBadRequest)
		return
	}
	if !s.drmReady {
		http.Error(w, "DRM backend not available — drm binary not found at startup", http.StatusServiceUnavailable)
		return
	}
	go func() {
		// Use context.Background: r.Context() is cancelled the moment the 202
		// response is written, which would abort the login mid-flight.
		// Authentication is long-running; progress arrives via SSE instead.
		if err := s.dm.Authenticate(context.Background(), drm.Credentials{
			Email:    req.Email,
			Password: req.Password,
		}); err != nil {
			fmt.Printf("drm login error: %v\n", err)
		}
	}()
	// Return immediately; authentication completion arrives via SSE.
	writeJSON(w, http.StatusAccepted, s.dm.Status())
}

func (s *APIServer) handleDRMChallenge(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10) // 4 KB
	var req struct {
		Reply string `json:"reply"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Reply == "" {
		http.Error(w, "reply required", http.StatusBadRequest)
		return
	}
	if err := s.dm.SubmitChallenge(r.Context(), req.Reply); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}

func (s *APIServer) handleDRMLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.dm.Logout(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}

func (s *APIServer) handleDRMClearSession(w http.ResponseWriter, r *http.Request) {
	if err := s.dm.ClearSession(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
