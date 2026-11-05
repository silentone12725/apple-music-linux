package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"engine/core/drm"
)

// drmStatusResponse embeds the DRM snapshot and adds backend-selection info
// and session age metadata for proactive refresh coordination.
type drmStatusResponse struct {
	drm.DRMSnapshot
	// Available is false when this build has no DRM layer (built without adamplay_backend): the session can
	// never become ready, which the other fields cannot tell apart from "not ready yet".
	Available    bool          `json:"available"`
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
	var snap drm.DRMSnapshot
	if s.dm != nil {
		snap = s.dm.Status()
	}
	resp := drmStatusResponse{
		DRMSnapshot: snap,
		Available:   s.dm != nil,
		Backend:     backendStatus{Selected: s.backendName},
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
	if s.dm.SignInRunning() {
		http.Error(w, drm.ErrSignInRunning.Error(), http.StatusConflict)
		return
	}
	go func() {
		// Not r.Context(): that is cancelled the moment the 202 response is written,
		// which would abort the login mid-flight. The server's shutdown context still
		// ends it on exit. Progress arrives via SSE.
		if err := s.dm.Authenticate(s.shutdownCtx, drm.Credentials{
			Email:    req.Email,
			Password: req.Password,
		}); err != nil {
			slog.Error("drm login error", "err", err)
		}
	}()
	// Return immediately; authentication completion arrives via SSE.
	var snap drm.DRMSnapshot
	if s.dm != nil {
		snap = s.dm.Status()
	}
	writeJSON(w, http.StatusAccepted, snap)
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
	if s.dm == nil {
		http.Error(w, "DRM backend not available", http.StatusServiceUnavailable)
		return
	}
	if err := s.dm.SubmitChallenge(r.Context(), req.Reply); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}

func (s *APIServer) handleDRMLogout(w http.ResponseWriter, r *http.Request) {
	if s.dm == nil {
		http.Error(w, "DRM backend not available", http.StatusServiceUnavailable)
		return
	}
	s.writeSignOut(w, s.dm.Logout)
}

func (s *APIServer) handleDRMClearSession(w http.ResponseWriter, r *http.Request) {
	if s.dm == nil {
		http.Error(w, "DRM backend not available", http.StatusServiceUnavailable)
		return
	}
	// The same full sign-out as POST /drm/logout: clearing the files while the
	// backend runs would leave the account signed in inside the Android libraries.
	s.writeSignOut(w, s.dm.Logout)
}

type signOutResponse struct {
	drm.DRMSnapshot
	ServerSignOut string `json:"serverSignOut"`
}

// writeSignOut runs a sign-out and answers. When the sign-out must finish in the
// next process, the answer is flushed first and then the engine exits; the Electron
// lifecycle restarts it and the new process completes the recorded sign-out.
func (s *APIServer) writeSignOut(w http.ResponseWriter, run func(context.Context) (drm.SignOutResult, error)) {
	res, err := run(s.shutdownCtx)
	status := http.StatusOK
	if err != nil {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, signOutResponse{DRMSnapshot: s.dm.Status(), ServerSignOut: res.ServerSignOut})
	if res.Restart {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go func() { time.Sleep(200 * time.Millisecond); os.Exit(3) }()
	}
}

func (s *APIServer) handleDRMForgetDevice(w http.ResponseWriter, r *http.Request) {
	if s.dm == nil {
		http.Error(w, "DRM backend not available", http.StatusServiceUnavailable)
		return
	}
	s.writeSignOut(w, s.dm.ForgetDevice)
}

// handleDRMResend is the resend-code probe: it answers the pending code challenge
// with no code. What Apple does next is reported over SSE.
func (s *APIServer) handleDRMResend(w http.ResponseWriter, r *http.Request) {
	if s.dm == nil {
		http.Error(w, "DRM backend not available", http.StatusServiceUnavailable)
		return
	}
	if err := s.dm.ResendCode(); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}
