package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"engine/utils/ampapi"
)

// audioAnalysisClient is used only for the audio-analysis catalog request.
var audioAnalysisClient = &http.Client{Timeout: 10 * time.Second}

// AudioAnalysisFade is the timing of a fade-in or fade-out in a track.
type AudioAnalysisFade struct {
	StartMs int `json:"startMs"`
	EndMs   int `json:"endMs"`
}

// AudioAnalysisResponse is the payload returned by GET /api/v1/audioanalysis/:id.
// All timing fields are in milliseconds relative to track start.
// Missing fields (e.g. Apple returned no analysis) are omitted from JSON.
type AudioAnalysisResponse struct {
	AssetID  string             `json:"assetId"`
	FadeIn   *AudioAnalysisFade `json:"fadeIn,omitempty"`
	FadeOut  *AudioAnalysisFade `json:"fadeOut,omitempty"`
	BPM      float64            `json:"bpm,omitempty"`
	Key      string             `json:"key,omitempty"`
	Loudness *struct {
		Beginning float64 `json:"beginning,omitempty"`
		Main      float64 `json:"main,omitempty"`
		Ending    float64 `json:"ending,omitempty"`
	} `json:"loudness,omitempty"`
}

// handleAudioAnalysis serves GET /api/v1/audioanalysis/{id}.
// Query params: sf (storefront), token (optional bearer JWT).
// Returns cross-fade timing data from Apple Music's audio-analysis relationship.
// A 204 is returned when Apple returns no analysis for the track (not an error).
func (s *APIServer) handleAudioAnalysis(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = "us"
	}
	token := strings.TrimPrefix(r.URL.Query().Get("token"), "Bearer ")
	if token == "" {
		var err error
		token, err = ampapi.GetToken()
		if err != nil {
			http.Error(w, "token: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}

	resp, err := fetchAudioAnalysis(r.Context(), sf, id, token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if resp == nil {
		w.WriteHeader(http.StatusNoContent) // analysis not available for this track
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=86400") // analysis is stable per track
	json.NewEncoder(w).Encode(resp)
}

// appleAnalysisResponse mirrors the Apple Music API JSON shape for
// audio-analysis relationship data. Only the fields AML cares about are decoded.
type appleAnalysisResponse struct {
	Data []struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Attributes struct {
			FadeIn *struct {
				StartInMilliseconds int `json:"startInMilliseconds"`
				EndInMilliseconds   int `json:"endInMilliseconds"`
			} `json:"fadeIn"`
			FadeOut *struct {
				StartInMilliseconds int `json:"startInMilliseconds"`
				EndInMilliseconds   int `json:"endInMilliseconds"`
			} `json:"fadeOut"`
			BPM      float64 `json:"bpm"`
			Key      string  `json:"key"`
			Loudness *struct {
				Beginning float64 `json:"beginning"`
				Main      float64 `json:"main"`
				Ending    float64 `json:"ending"`
			} `json:"loudness"`
		} `json:"attributes"`
	} `json:"data"`
}

func fetchAudioAnalysis(ctx context.Context, sf, id, token string) (*AudioAnalysisResponse, error) {
	u := fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/songs/%s",
		url.PathEscape(sf), url.PathEscape(id))

	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("include", "audio-analysis")
	q.Set("extend", "extendedAssetUrls")
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")

	do, err := audioAnalysisClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("audio-analysis fetch: %w", err)
	}
	defer do.Body.Close()
	if do.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("audio-analysis: HTTP %d", do.StatusCode)
	}

	// Decode the outer songs response, then extract audio-analysis relationship.
	var outer struct {
		Data []struct {
			Relationships struct {
				AudioAnalysis *appleAnalysisResponse `json:"audio-analysis"`
			} `json:"relationships"`
		} `json:"data"`
	}
	if err := json.NewDecoder(do.Body).Decode(&outer); err != nil {
		return nil, fmt.Errorf("audio-analysis decode: %w", err)
	}
	if len(outer.Data) == 0 {
		return nil, nil
	}
	ar := outer.Data[0].Relationships.AudioAnalysis
	if ar == nil || len(ar.Data) == 0 {
		return nil, nil
	}
	attrs := ar.Data[0].Attributes

	out := &AudioAnalysisResponse{AssetID: id}
	if attrs.FadeIn != nil {
		out.FadeIn = &AudioAnalysisFade{
			StartMs: attrs.FadeIn.StartInMilliseconds,
			EndMs:   attrs.FadeIn.EndInMilliseconds,
		}
	}
	if attrs.FadeOut != nil {
		out.FadeOut = &AudioAnalysisFade{
			StartMs: attrs.FadeOut.StartInMilliseconds,
			EndMs:   attrs.FadeOut.EndInMilliseconds,
		}
	}
	if attrs.BPM != 0 {
		out.BPM = attrs.BPM
	}
	if attrs.Key != "" {
		out.Key = attrs.Key
	}
	if attrs.Loudness != nil {
		out.Loudness = &struct {
			Beginning float64 `json:"beginning,omitempty"`
			Main      float64 `json:"main,omitempty"`
			Ending    float64 `json:"ending,omitempty"`
		}{
			Beginning: attrs.Loudness.Beginning,
			Main:      attrs.Loudness.Main,
			Ending:    attrs.Loudness.Ending,
		}
	}
	return out, nil
}
