package main

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"engine/utils/ampapi"
)

// Personalised feeds. These endpoints are intentionally "dormant": nothing in
// the bundled frontend calls them, they exist so other applications built on
// the engine can show Listen Now / heavy rotation / recently played without
// re-implementing Apple's authentication.
//
//	GET /api/v1/recommendations                 Listen Now feed
//	GET /api/v1/recommendations/heavy-rotation  most-played content
//	GET /api/v1/recommendations/recently-played recently played containers
//
// Query: limit (1-50), offset, types (comma-separated resource types).
// Requires a Music-User-Token (pushed by the frontend or read from the DRM
// session); 401 is returned otherwise.

var typesFilterRe = regexp.MustCompile(`^[a-z-]{1,32}(,[a-z-]{1,32}){0,9}$`)

func (s *APIServer) recommendationsHandler(kind ampapi.RecommendationKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		opt := ampapi.RecommendationsOptions{Language: s.lang(r)}

		q := r.URL.Query()
		if v := q.Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > 50 {
				http.Error(w, "limit must be 1-50", http.StatusBadRequest)
				return
			}
			opt.Limit = n
		}
		if v := q.Get("offset"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 || n > 10000 {
				http.Error(w, "invalid offset", http.StatusBadRequest)
				return
			}
			opt.Offset = n
		}
		if v := q.Get("types"); v != "" {
			if !typesFilterRe.MatchString(v) {
				http.Error(w, "invalid types filter", http.StatusBadRequest)
				return
			}
			opt.Types = v
		}

		mut := s.musicUserToken()
		if mut == "" {
			http.Error(w, "no Music-User-Token available; sign in first", http.StatusUnauthorized)
			return
		}

		body, err := ampapi.GetRecommendations(r.Context(), kind, s.token(), mut, opt)
		if err != nil {
			var se *ampapi.StatusError
			if errors.As(err, &se) {
				switch se.Status {
				case http.StatusUnauthorized, http.StatusForbidden:
					http.Error(w, "apple music rejected the user token", se.Status)
				default:
					http.Error(w, "recommendations fetch failed: "+err.Error(), http.StatusBadGateway)
				}
				return
			}
			http.Error(w, "recommendations fetch failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}
}
