package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestCORSGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := corsPreflightHandler(ok)
	cases := []struct {
		name, method, host, origin string
		want                       int
	}{
		{"apple page", "POST", "127.0.0.1:20025", "https://music.apple.com", http.StatusTeapot},
		{"main process, no origin", "POST", "127.0.0.1:20025", "", http.StatusTeapot},
		{"localhost host", "GET", "localhost:20025", "", http.StatusTeapot},
		{"ipv6 loopback", "GET", "[::1]:20025", "", http.StatusTeapot},
		{"local dev origin", "GET", "127.0.0.1:20025", "http://localhost:5173", http.StatusTeapot},
		{"preflight allowed", "OPTIONS", "127.0.0.1:20025", "https://music.apple.com", http.StatusNoContent},
		{"cross-site simple POST", "POST", "127.0.0.1:20025", "https://attacker.example", http.StatusForbidden},
		{"localhost prefix spoof", "POST", "127.0.0.1:20025", "http://localhost.attacker.example", http.StatusForbidden},
		{"127 prefix spoof", "POST", "127.0.0.1:20025", "http://127.0.0.1.attacker.example", http.StatusForbidden},
		{"apple lookalike", "POST", "127.0.0.1:20025", "https://music.apple.com.attacker.example", http.StatusForbidden},
		{"file page (null origin)", "POST", "127.0.0.1:20025", "null", http.StatusForbidden},
		{"dns rebinding host", "GET", "rebind.attacker.example:20025", "", http.StatusForbidden},
		{"foreign preflight", "OPTIONS", "127.0.0.1:20025", "https://attacker.example", http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(c.method, "/api/v1/drm/logout", nil)
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Fatalf("got %d, want %d", w.Code, c.want)
			}
			if c.want != http.StatusForbidden && c.origin != "" {
				if got := w.Header().Get("Access-Control-Allow-Origin"); got != c.origin {
					t.Fatalf("ACAO = %q, want %q", got, c.origin)
				}
			}
		})
	}
}

func TestCatalogParamsValidation(t *testing.T) {
	s := &APIServer{}
	for _, c := range []struct {
		id, sf string
		ok     bool
	}{
		{"1440833098", "us", true}, {"pl.u-abc_1", "gb", true}, {"l.AbC.1", "", true},
		{"..", "us", false}, {"1", "us/../../v1/me", false}, {"a?b", "us", false}, {"", "us", false},
		{"1", "..", false}, {"1", ".", false}, // a dot-segment storefront would climb out of /v1/catalog/
	} {
		r := httptest.NewRequest("GET", "/api/v1/catalog/albums/x", nil)
		r.SetPathValue("id", c.id)
		if c.sf != "" {
			q := r.URL.Query()
			q.Set("sf", c.sf)
			r.URL.RawQuery = q.Encode()
		}
		w := httptest.NewRecorder()
		if _, _, ok := s.catalogParams(w, r); ok != c.ok {
			t.Errorf("id=%q sf=%q ok=%v want %v", c.id, c.sf, ok, c.ok)
		}
	}
}

func TestResponsesAreNosniff(t *testing.T) {
	h := corsPreflightHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	r := httptest.NewRequest("GET", "/api/v1/lyrics/1", nil)
	r.Host = "127.0.0.1:20025"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

func TestLyricsParamsValidation(t *testing.T) {
	s := &APIServer{}
	for _, c := range []struct {
		typ  string
		want int
	}{
		{"lyrics", 0}, {"syllable-lyrics", 0}, {"../../me/library", http.StatusBadRequest}, {"a/b", http.StatusBadRequest},
	} {
		r := httptest.NewRequest("GET", "/api/v1/lyrics/1440833098?sf=us&type="+url.QueryEscape(c.typ), nil)
		r.SetPathValue("id", "1440833098")
		w := httptest.NewRecorder()
		if c.want == 0 {
			if !lyricTypeRe.MatchString(c.typ) {
				t.Errorf("type %q rejected", c.typ)
			}
			continue
		}
		s.handleLyrics(w, r)
		if w.Code != c.want {
			t.Errorf("type %q: code %d, want %d", c.typ, w.Code, c.want)
		}
	}
}

func TestCircuitBreakerStates(t *testing.T) {
	cb := newCircuitBreaker(2, 20*time.Millisecond)
	cb.RecordFailure()
	if cb.State() != "closed" || !cb.Allow() {
		t.Fatal("one failure should not trip")
	}
	cb.RecordFailure()
	if cb.State() != "open" || cb.Allow() {
		t.Fatal("threshold should open the breaker")
	}
	time.Sleep(30 * time.Millisecond)
	if cb.State() != "half-open" || !cb.Allow() {
		t.Fatalf("after cooldown: state=%s", cb.State())
	}
	cb.RecordFailure()
	if cb.State() != "open" {
		t.Fatal("a failed trial must re-open")
	}
	time.Sleep(30 * time.Millisecond)
	cb.RecordSuccess()
	if cb.State() != "closed" {
		t.Fatal("success must close")
	}
}
