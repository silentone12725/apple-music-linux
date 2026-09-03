package main

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"engine/utils/ampapi"
	"engine/utils/lyrics"
)

func (s *APIServer) handleMetadata(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	tok := s.token()

	type Meta struct {
		ID               string       `json:"id"`
		Type             string       `json:"type"`
		Title            string       `json:"title"`
		ArtistName       string       `json:"artistName"`
		AlbumName        string       `json:"albumName,omitempty"`
		DurationMs       int          `json:"durationMs"`
		ArtworkURL       string       `json:"artworkUrl"`
		HasLyrics        bool         `json:"hasLyrics,omitempty"`
		Has4K            bool         `json:"has4k,omitempty"`
		HasHDR           bool         `json:"hasHdr,omitempty"`
		AvailableStreams []StreamInfo `json:"availableStreams"`
	}

	if song, err := ampapi.GetSongRespContext(r.Context(), sf, id, s.lang(r), tok); err == nil && len(song.Data) > 0 {
		a := song.Data[0].Attributes
		writeJSON(w, http.StatusOK, Meta{
			ID:               id,
			Type:             "song",
			Title:            a.Name,
			ArtistName:       a.ArtistName,
			AlbumName:        a.AlbumName,
			DurationMs:       a.DurationInMillis,
			ArtworkURL:       fmtArtworkURL(a.Artwork.URL, 500),
			HasLyrics:        a.HasLyrics,
			AvailableStreams: streamsFromTraits(a.AudioTraits),
		})
		return
	}

	if mv, err := ampapi.GetMusicVideoRespContext(r.Context(), sf, id, s.lang(r), tok); err == nil && len(mv.Data) > 0 {
		a := mv.Data[0].Attributes
		writeJSON(w, http.StatusOK, Meta{
			ID:         id,
			Type:       "mv",
			Title:      a.Name,
			ArtistName: a.ArtistName,
			AlbumName:  a.AlbumName,
			DurationMs: a.DurationInMillis,
			ArtworkURL: fmtArtworkURL(a.Artwork.URL, 500),
			Has4K:      a.Has4K,
			HasHDR:     a.HasHDR,
			AvailableStreams: []StreamInfo{
				{Codec: "H.264"},
				{Codec: "AAC"},
			},
		})
		return
	}

	if album, err := ampapi.GetAlbumRespContext(r.Context(), sf, id, s.lang(r), tok); err == nil && len(album.Data) > 0 {
		a := album.Data[0].Attributes
		writeJSON(w, http.StatusOK, Meta{
			ID:         id,
			Type:       "album",
			Title:      a.Name,
			ArtistName: a.ArtistName,
			ArtworkURL: fmtArtworkURL(a.Artwork.URL, 500),
		})
		return
	}

	http.Error(w, "asset not found", http.StatusNotFound)
}

func (s *APIServer) handleArtwork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	size := 500
	fmt.Sscanf(r.URL.Query().Get("size"), "%d", &size)
	if size < 50 {
		size = 50
	} else if size > 3000 {
		size = 3000
	}
	tok := s.token()

	var rawURL string
	if song, err := ampapi.GetSongRespContext(r.Context(), sf, id, s.lang(r), tok); err == nil && len(song.Data) > 0 {
		rawURL = song.Data[0].Attributes.Artwork.URL
	} else if mv, err := ampapi.GetMusicVideoRespContext(r.Context(), sf, id, s.lang(r), tok); err == nil && len(mv.Data) > 0 {
		rawURL = mv.Data[0].Attributes.Artwork.URL
	} else {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	imgResp, err := artworkClient.Get(fmtArtworkURL(rawURL, size))
	if err != nil {
		http.Error(w, "artwork fetch failed", http.StatusBadGateway)
		return
	}
	defer imgResp.Body.Close()
	w.Header().Set("Content-Type", imgResp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.Copy(w, imgResp.Body) //nolint:errcheck
}

func (s *APIServer) handleLyrics(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "lrc"
	}
	lrcType := r.URL.Query().Get("type")
	if lrcType == "" {
		lrcType = "lyrics"
	}

	tok := s.token()
	mut := s.mediaUserToken()

	lrc, err := lyrics.GetContext(r.Context(), sf, id, lrcType, s.lang(r), format, tok, mut)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	switch format {
	case "ttml":
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	case "vtt":
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	fmt.Fprint(w, lrc)
}

func fmtArtworkURL(template string, size int) string {
	s := strconv.Itoa(size)
	return strings.NewReplacer("{w}", s, "{h}", s).Replace(template)
}

func streamsFromTraits(traits []string) []StreamInfo {
	set := make(map[string]bool, len(traits))
	for _, t := range traits {
		set[t] = true
	}
	var out []StreamInfo
	if set["hi-res-lossless"] {
		sr, bd := 96000, 24
		for _, t := range traits {
			parts := strings.Split(t, "-")
			if len(parts) >= 2 {
				fmt.Sscanf(parts[len(parts)-2], "%d", &sr)
				fmt.Sscanf(parts[len(parts)-1], "%d", &bd)
				if sr > 0 && bd > 0 {
					break
				}
			}
		}
		out = append(out, StreamInfo{Codec: "ALAC", SampleRate: sr, BitDepth: bd})
	} else if set["lossless"] {
		out = append(out, StreamInfo{Codec: "ALAC", SampleRate: 44100, BitDepth: 16})
	}
	if set["atmos"] {
		out = append(out, StreamInfo{Codec: "E-AC-3"})
	}
	out = append(out, StreamInfo{Codec: "AAC", Bitrate: 256000})
	return out
}
