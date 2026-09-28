package ampapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchTrackPagesFollowsNextAndSendsMUT(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Media-User-Token") != "mut" {
			t.Errorf("page %s missing Media-User-Token", r.URL.Path)
		}
		switch r.URL.Path {
		case "/p2":
			fmt.Fprint(w, `{"next":"/p3","data":[{"id":"2"}]}`)
		case "/p3":
			fmt.Fprint(w, `{"data":[{"id":"3"}]}`)
		}
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	got, err := fetchTrackPages(context.Background(), "/p2", "tok", "mut")
	if err != nil || len(got) != 2 || got[0].ID != "2" || got[1].ID != "3" {
		t.Fatalf("got %+v err=%v", got, err)
	}
}

func TestFetchTrackPagesCapsRunawayPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"next":"/again","data":[]}`) // never ends
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	if _, err := fetchTrackPages(context.Background(), "/again", "tok", ""); err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("err = %v, want page-cap error", err)
	}
}
