package main

import (
	"encoding/json"
	"net/http"

	"engine/core/prefetch"
)

func (s *APIServer) handleCacheConfig(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10) // 4 KB
	var cfg prefetch.CacheConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	s.scheduler.SetCacheConfig(cfg)
	if s.diskCache != nil {
		s.diskCache.SetConfig(cfg.PersistLimitMB, cfg.PersistTTLDays)
	}
	writeJSON(w, http.StatusOK, s.scheduler.GetCacheConfig())
}

func (s *APIServer) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	cfg := s.scheduler.GetCacheConfig()
	prewarmLimitBytes := cfg.PrewarmLimitMB * 1024 * 1024
	if prewarmLimitBytes == 0 {
		prewarmLimitBytes = 1024 * 1024 * 1024 // 1 GB default shown in UI
	}

	persistSection := map[string]any{"available": false}
	if s.diskCache != nil {
		sizeBytes, count := s.diskCache.Stats()
		limitBytes := cfg.PersistLimitMB * 1024 * 1024
		if limitBytes == 0 {
			limitBytes = 500 * 1024 * 1024 // 500 MB default shown in UI
		}
		persistSection = map[string]any{
			"available":  true,
			"sizeBytes":  sizeBytes,
			"limitBytes": limitBytes,
			"ttlDays":    cfg.PersistTTLDays,
			"count":      count,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"persistent": persistSection,
		"prewarm": map[string]any{
			"entries":    s.scheduler.PrewarmCount(),
			"sizeBytes":  0,
			"limitBytes": prewarmLimitBytes,
		},
	})
}

func (s *APIServer) handleMVCacheGet(w http.ResponseWriter, r *http.Request) {
	enabled, maxBytes, sizeBytes, quality := MVCacheGetInfo()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":   enabled,
		"maxBytes":  maxBytes,
		"sizeBytes": sizeBytes,
		"quality":   quality,
	})
}

func (s *APIServer) handleMVCacheClear(w http.ResponseWriter, r *http.Request) {
	if err := ClearMVCache(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *APIServer) handleMVCachePut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10) // 4 KB
	var body struct {
		Enabled  *bool  `json:"enabled"`
		MaxBytes *int64 `json:"maxBytes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.MaxBytes != nil {
		MVCacheSetMaxBytes(*body.MaxBytes)
	}
	if body.Enabled != nil {
		MVCacheSetEnabled(*body.Enabled)
	}
	enabled, maxBytes, sizeBytes, quality := MVCacheGetInfo()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":   enabled,
		"maxBytes":  maxBytes,
		"sizeBytes": sizeBytes,
		"quality":   quality,
	})
}

func (s *APIServer) handleCachePlaybackDelete(w http.ResponseWriter, r *http.Request) {
	what := r.URL.Query().Get("what") // "prewarm", "persistent", or "" (both)
	if what == "" || what == "prewarm" {
		s.scheduler.ClearPreWarmed()
	}
	if what == "" || what == "persistent" {
		if s.diskCache != nil {
			s.diskCache.Clear()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
