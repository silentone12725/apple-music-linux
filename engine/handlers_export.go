package main

import (
	"encoding/json"
	"net/http"

	"engine/core/export"
)

func (s *APIServer) handleExportCreate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10) // 64 KB
	var req export.ExportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	// Prefer request-level tokens (from browser renderer) over cached session.
	if req.Token == "" {
		req.Token = s.token()
	}
	if req.MUT == "" {
		req.MUT = s.mediaUserToken()
	}
	if req.Token == "" || req.MUT == "" {
		http.Error(w, "not authenticated — provide token+mediaUserToken in request body or start playback first", http.StatusUnauthorized)
		return
	}
	s.setToken(req.Token)
	if req.Storefront == "" {
		req.Storefront = s.storefront()
	}
	if req.Language == "" {
		req.Language = s.lang(r)
	}
	job, err := s.em.Enqueue(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *APIServer) handleExportList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.em.List())
}

func (s *APIServer) handleExportGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := s.em.Get(id)
	if !ok {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *APIServer) handleExportCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.em.Cancel(id) {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *APIServer) handleExportRetry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := s.em.Retry(id)
	if !ok {
		// Distinguish not-found from wrong-state.
		if _, exists := s.em.Get(id); !exists {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		http.Error(w, "job is not in a retryable state (must be failed or cancelled)", http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}
