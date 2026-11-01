package aacstream

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	cdm "engine/utils/aacstream/cdm"

	"github.com/go-resty/resty/v2"
	"google.golang.org/protobuf/proto"
)

func TestGetPSSHPreservesPaddedAndUnpaddedKID(t *testing.T) {
	kid := []byte("0123456789abcdef")
	padded := base64.StdEncoding.EncodeToString(kid)
	unpadded := base64.RawStdEncoding.EncodeToString(kid)

	for _, tc := range []struct {
		name string
		kid  string
	}{
		{name: "padded", kid: padded},
		{name: "unpadded", kid: unpadded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pssh, err := getPSSH("", tc.kid)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := base64.StdEncoding.DecodeString(pssh)
			if err != nil {
				t.Fatal(err)
			}
			if len(raw) < 32 {
				t.Fatalf("generated init data is %d bytes, want at least 32", len(raw))
			}

			var header cdm.WidevineCencHeader
			if err := proto.Unmarshal(raw[32:], &header); err != nil {
				t.Fatal(err)
			}
			if len(header.KeyId) != 1 || string(header.KeyId[0]) != string(kid) {
				t.Fatalf("generated KID = %x, want %x", header.KeyId, kid)
			}
		})
	}
}

func TestGetPSSHRejectsInvalidKIDLength(t *testing.T) {
	short := base64.StdEncoding.EncodeToString([]byte("short"))
	if _, err := getPSSH("", short); err == nil {
		t.Fatal("getPSSH accepted a KID that is not 16 bytes")
	}
}

// A refused licence is reported with a sentinel so callers can tell a refusal from a request that failed in transit,
// and the message keeps its familiar form.
func TestAfterRequestMarksARefusedLicence(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":-42604,"status":-1021}`))
	}))
	defer ts.Close()
	resp, err := resty.New().R().Get(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = AfterRequest(resp)
	if !errors.Is(err, ErrLicenceRefused) {
		t.Fatalf("err = %v, want ErrLicenceRefused", err)
	}
	if want := "error in license response, code: -42604, status: -1021"; err.Error() != want {
		t.Errorf("message = %q, want %q", err.Error(), want)
	}
}
