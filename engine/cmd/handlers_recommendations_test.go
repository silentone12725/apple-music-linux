package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"engine/utils/ampapi"
)

func fakeApple(t *testing.T, status int, body string, gotHeaders *http.Header, gotPath *string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotHeaders != nil {
			*gotHeaders = r.Header.Clone()
		}
		if gotPath != nil {
			*gotPath = r.URL.RequestURI()
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	old := ampapi.AMPBaseURL
	ampapi.AMPBaseURL = srv.URL
	t.Cleanup(func() { ampapi.AMPBaseURL = old; srv.Close() })
}

func newRecServer() *APIServer {
	s := &APIServer{}
	s.setToken("dev-token")
	s.setMusicUserToken("user-token")
	return s
}

func TestRecommendationsProxiesAndSendsTokens(t *testing.T) {
	var hdr http.Header
	var path string
	fakeApple(t, 200, `{"data":[{"id":"x"}]}`, &hdr, &path)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/recommendations?limit=5&offset=2&types=playlists,albums", nil)
	newRecServer().recommendationsHandler(ampapi.KindRecommendations)(rec, req)

	if rec.Code != 200 || rec.Body.String() != `{"data":[{"id":"x"}]}` {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	if hdr.Get("Authorization") != "Bearer dev-token" || hdr.Get("Music-User-Token") != "user-token" {
		t.Fatalf("missing auth headers: %v", hdr)
	}
	if path != "/v1/me/recommendations?l=en-US&limit=5&offset=2&types=playlists%2Calbums" {
		t.Fatalf("unexpected upstream request %q", path)
	}
}

func TestRecommendationsRoutesToKindPaths(t *testing.T) {
	cases := map[ampapi.RecommendationKind]string{
		ampapi.KindHeavyRotation:  "/v1/me/history/heavy-rotation?l=en-US",
		ampapi.KindRecentlyPlayed: "/v1/me/recent/played?l=en-US",
	}
	for kind, want := range cases {
		var path string
		fakeApple(t, 200, `{}`, nil, &path)
		rec := httptest.NewRecorder()
		newRecServer().recommendationsHandler(kind)(rec, httptest.NewRequest("GET", "/x", nil))
		if rec.Code != 200 || path != want {
			t.Errorf("%s: code=%d path=%q want %q", kind, rec.Code, path, want)
		}
	}
}

func TestRecommendationsValidationAndAuth(t *testing.T) {
	for _, q := range []string{"limit=0", "limit=51", "limit=abc", "offset=-1", "types=../x", "types=a,b,c,d,e,f,g,h,i,j,k"} {
		rec := httptest.NewRecorder()
		newRecServer().recommendationsHandler(ampapi.KindRecommendations)(rec, httptest.NewRequest("GET", "/x?"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: got %d want 400", q, rec.Code)
		}
	}

	s := &APIServer{}
	s.setToken("dev-token")
	rec := httptest.NewRecorder()
	s.recommendationsHandler(ampapi.KindRecommendations)(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no user token: got %d want 401", rec.Code)
	}
}

func TestRecommendationsMapsUpstreamErrors(t *testing.T) {
	for upstream, want := range map[int]int{401: 401, 403: 403, 500: 502, 429: 502} {
		fakeApple(t, upstream, `{"errors":[]}`, nil, nil)
		rec := httptest.NewRecorder()
		newRecServer().recommendationsHandler(ampapi.KindRecommendations)(rec, httptest.NewRequest("GET", "/x", nil))
		if rec.Code != want {
			t.Errorf("upstream %d: got %d want %d", upstream, rec.Code, want)
		}
	}
}
