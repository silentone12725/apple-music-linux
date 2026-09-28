package main

import (
	"fmt"
	"io"
	"net/http"
	"regexp"

	"engine/utils/ampapi"
)

func (s *APIServer) handleCatalogAlbum(w http.ResponseWriter, r *http.Request) {
	sf, id, ok := s.catalogParams(w, r)
	if !ok {
		return
	}
	tok := s.token()
	album, err := ampapi.GetAlbumResp(sf, id, s.lang(r), tok)
	if err != nil {
		http.Error(w, "album fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, album)
}

func (s *APIServer) handleCatalogPlaylist(w http.ResponseWriter, r *http.Request) {
	sf, id, ok := s.catalogParams(w, r)
	if !ok {
		return
	}
	tok := s.token()
	playlist, err := ampapi.GetPlaylistResp(sf, id, s.lang(r), tok)
	if err != nil {
		http.Error(w, "playlist fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, playlist)
}

func (s *APIServer) handleCatalogArtist(w http.ResponseWriter, r *http.Request) {
	sf, id, ok := s.catalogParams(w, r)
	if !ok {
		return
	}
	tok := s.token()
	// Apple Music catalog API for artists.
	req, err := http.NewRequestWithContext(r.Context(), "GET",
		fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/artists/%s", sf, id), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	req.Header.Set("Origin", "https://music.apple.com")
	query := req.URL.Query()
	query.Set("include", "albums,songs")
	query.Set("limit[albums]", "20")
	query.Set("limit[songs]", "10")
	query.Set("l", s.lang(r))
	req.URL.RawQuery = query.Encode()
	resp, err := artworkClient.Do(req)
	if err != nil {
		http.Error(w, "artist fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck
}

// catalogIDRe matches Apple catalog/library IDs and storefront codes. These
// values are interpolated into amp-api URL paths, so anything else ("../",
// "?", "#") is rejected rather than forwarded with the user's bearer token.
var catalogIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// catalogParams resolves the storefront (query → session → "us") and validates
// both it and the {id} path value, writing a 400 when either is malformed.
func (s *APIServer) catalogParams(w http.ResponseWriter, r *http.Request) (sf, id string, ok bool) {
	id = r.PathValue("id")
	sf = r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	if sf == "" {
		sf = "us"
	}
	if !catalogIDRe.MatchString(id) || !catalogIDRe.MatchString(sf) || id == "." || id == ".." {
		http.Error(w, "invalid id or storefront", http.StatusBadRequest)
		return "", "", false
	}
	return sf, id, true
}
