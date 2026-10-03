package main

import (
	"net/http"
)

// handleJobStatus returns a snapshot of a cache-warming job.
// Intended for debugging and progress UI; do not poll in normal operation.
func (s *APIServer) handleJobStatus(w http.ResponseWriter, r *http.Request) {
	job, ok := s.scheduler.Status(r.PathValue("id"))
	if !ok {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, &job) // job is a snapshot copy; pointer avoids copying the zero mutex
}

// handleJobCancel cancels remaining work for a cache-warming job.
// Called by the renderer on navigation away (per-slot cancellation).
func (s *APIServer) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	if !s.scheduler.Cancel(r.PathValue("id")) {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
