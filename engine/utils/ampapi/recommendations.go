package ampapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// AMPBaseURL is the Apple Music API root. It is a variable so tests can point
// it at an httptest server.
var AMPBaseURL = "https://amp-api.music.apple.com"

// RecommendationKind selects one of the personalised "me" feeds.
type RecommendationKind string

const (
	// KindRecommendations is the "Listen Now" feed (/v1/me/recommendations).
	KindRecommendations RecommendationKind = "recommendations"
	// KindHeavyRotation is the user's most-played content (/v1/me/history/heavy-rotation).
	KindHeavyRotation RecommendationKind = "heavy-rotation"
	// KindRecentlyPlayed is recently played containers (/v1/me/recent/played).
	KindRecentlyPlayed RecommendationKind = "recently-played"
)

func (k RecommendationKind) path() (string, bool) {
	switch k {
	case KindRecommendations:
		return "/v1/me/recommendations", true
	case KindHeavyRotation:
		return "/v1/me/history/heavy-rotation", true
	case KindRecentlyPlayed:
		return "/v1/me/recent/played", true
	}
	return "", false
}

// RecommendationsOptions tunes a personalised feed request. Zero values are
// omitted so Apple's defaults apply.
type RecommendationsOptions struct {
	Language string // BCP-47 tag, e.g. "en-US"
	Limit    int    // 1..50; 0 = Apple default
	Offset   int
	Types    string // optional comma-separated resource types filter
}

// StatusError carries Apple's HTTP status so callers can map it (401 → token
// expired, 403 → no subscription, ...) instead of reporting a generic failure.
type StatusError struct {
	Status int
	Body   []byte
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("apple music api: HTTP %d", e.Status)
}

// GetRecommendations fetches a personalised feed. Both tokens are required:
// the developer token authorises the app, the Music-User-Token identifies the
// listener. The response is returned verbatim so callers see every field Apple
// adds without this package needing to follow the schema.
func GetRecommendations(ctx context.Context, kind RecommendationKind, token, userToken string, opt RecommendationsOptions) (json.RawMessage, error) {
	path, ok := kind.path()
	if !ok {
		return nil, fmt.Errorf("unknown recommendation kind %q", kind)
	}
	if token == "" {
		var err error
		if token, err = GetToken(); err != nil {
			return nil, err
		}
	}
	if userToken == "" {
		return nil, fmt.Errorf("a Music-User-Token is required for personalised feeds")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, AMPBaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Music-User-Token", userToken)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://music.apple.com")

	q := url.Values{}
	if opt.Language != "" {
		q.Set("l", opt.Language)
	}
	if opt.Limit > 0 {
		q.Set("limit", strconv.Itoa(opt.Limit))
	}
	if opt.Offset > 0 {
		q.Set("offset", strconv.Itoa(opt.Offset))
	}
	if opt.Types != "" {
		q.Set("types", opt.Types)
	}
	req.URL.RawQuery = q.Encode()

	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &StatusError{Status: resp.StatusCode, Body: body}
	}
	return json.RawMessage(body), nil
}
