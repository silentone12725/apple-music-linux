package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"engine/core/library"
	"engine/utils/ampapi"
)

// resolveToken returns the bearer JWT, falling back to ampapi.GetToken() if the
// browser hasn't sent one yet (e.g. sync called before first playback request).
func (s *APIServer) resolveToken() (string, error) {
	if t := s.token(); t != "" {
		return t, nil
	}
	t, err := ampapi.GetToken()
	if err != nil {
		return "", fmt.Errorf("could not resolve bearer token: %w", err)
	}
	if t == "" {
		return "", fmt.Errorf("developer token not available — open Apple Music first so MusicKit can push credentials")
	}
	s.setToken(t)
	return t, nil
}

// handleLibrarySync is deprecated — sync is now JS-driven via POST /api/v1/library/ingest.
func (s *APIServer) handleLibrarySync(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "use Settings → Library → Sync Now (JS-driven sync via /api/v1/library/ingest)", http.StatusGone)
}

// handleLibraryStatus returns the current cache stats.
func (s *APIServer) handleLibraryStatus(w http.ResponseWriter, r *http.Request) {
	if s.libStore == nil {
		http.Error(w, "library store not initialised", http.StatusServiceUnavailable)
		return
	}
	songs, albums, playlists, syncedAt := s.libStore.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"songs":     songs,
		"albums":    albums,
		"playlists": playlists,
		"syncedAt":  syncedAt,
		"needsSync": s.libStore.NeedsSync(),
	})
}

// handleLibraryPlaylists returns the cached playlist list.
func (s *APIServer) handleLibraryPlaylists(w http.ResponseWriter, r *http.Request) {
	if s.libStore == nil {
		http.Error(w, "library store not initialised", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlists": s.libStore.Playlists()})
}

// handleLibraryPlaylistTracks returns the ordered track list for a playlist.
// Response: {"tracks": [{lid, cid}, ...]} — lid = library song ID, cid = catalog ID.
// The JS setQueue wrapper calls this to build {songs:[...catalogIds]} instantly.
func (s *APIServer) handleLibraryPlaylistTracks(w http.ResponseWriter, r *http.Request) {
	if s.libStore == nil {
		http.Error(w, "library store not initialised", http.StatusServiceUnavailable)
		return
	}
	playlistID := r.PathValue("id")
	tracks := s.libStore.PlaylistTracks(playlistID)
	if tracks == nil {
		// Not in cache — attempt a live fetch if authenticated.
		tok, tokErr := s.resolveToken()
		mut := s.musicUserToken()
		if tokErr != nil || mut == "" {
			writeJSON(w, http.StatusOK, map[string]any{"tracks": []any{}, "cached": false})
			return
		}
		fetched, err := library.FetchPlaylistTracksOnce(r.Context(), tok, mut, playlistID)
		if err != nil {
			log.Printf("[library] live fetch %s: %v", playlistID, err)
			writeJSON(w, http.StatusOK, map[string]any{"tracks": []any{}, "cached": false, "error": err.Error()})
			return
		}
		// Cache the result for next time.
		if s.libStore != nil {
			s.libStore.SetPlaylistTracks(playlistID, fetched)
		}
		writeJSON(w, http.StatusOK, map[string]any{"tracks": fetched, "cached": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tracks": tracks, "cached": true})
}

// handleLibraryAlbumTracks returns the ordered track list for a library album.
// Response: {"tracks": [{lid, cid}, ...]} — served from local DB (instantaneous).
func (s *APIServer) handleLibraryAlbumTracks(w http.ResponseWriter, r *http.Request) {
	if s.libStore == nil {
		http.Error(w, "library store not initialised", http.StatusServiceUnavailable)
		return
	}
	albumID := r.PathValue("id")
	if !strings.HasPrefix(albumID, "l.") {
		albumID = "l." + albumID
	}
	tracks := s.libStore.SongsByAlbum(albumID)
	if tracks == nil {
		tracks = []library.PlaylistTrack{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tracks": tracks, "cached": true})
}

// handleLibraryToken stores the MusicKit JS tokens sent by the renderer.
// The JS side pushes mk.musicUserToken + the developer token at startup so
// library sync can use the web-auth credentials instead of the Android DRM ones.
func (s *APIServer) handleLibraryToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MusicUserToken string `json:"musicUserToken"`
		DeveloperToken string `json:"developerToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	s.setMusicUserToken(body.MusicUserToken)
	if body.DeveloperToken != "" {
		s.setToken(body.DeveloperToken)
	}
	log.Printf("[library] received MK web tokens (mut len=%d, dev len=%d)", len(body.MusicUserToken), len(body.DeveloperToken))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleLibraryIngest accepts pre-fetched library data from the JS sync function.
// MusicKit JS owns authentication; the engine just parses and stores the payload.
func (s *APIServer) handleLibraryIngest(w http.ResponseWriter, r *http.Request) {
	if s.libStore == nil {
		http.Error(w, "library store not initialised", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20) // 100 MB cap
	var payload library.IngestPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.libStore.Ingest(payload)
	songs, albs, pls, at := s.libStore.Stats()
	writeJSON(w, http.StatusOK, map[string]any{"songs": songs, "albums": albs, "playlists": pls, "syncedAt": at})
}
