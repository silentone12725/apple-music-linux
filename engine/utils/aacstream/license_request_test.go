package aacstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-resty/resty/v2"
)

func TestBeforeRequestSendsTrackParams(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
	}))
	defer srv.Close()

	ctx := withLicenseParams(context.Background(), licenseParams{pssh: "KID", adamID: "1440833098", uriPrefix: "skd://itunes"})
	if _, err := BeforeRequest(resty.New(), ctx, srv.URL, []byte("challenge")); err != nil {
		t.Fatal(err)
	}
	if got["uri"] != "skd://itunes,KID" || got["adamId"] != "1440833098" || got["key-system"] != "com.widevine.alpha" {
		t.Fatalf("license request body = %v", got)
	}
}

func TestBeforeRequestWithoutParamsErrors(t *testing.T) {
	if _, err := BeforeRequest(resty.New(), context.Background(), "http://127.0.0.1:1", nil); err == nil {
		t.Fatal("want an error (previously a nil-interface panic)")
	}
}
