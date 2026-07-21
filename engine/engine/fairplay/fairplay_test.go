package fairplay

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"testing"

	"apple-music-cli/engine/pipeline"
)

// Compile-time assertions: the exported constructors satisfy the intended
// engine interfaces. These do not hit the network.
var (
	_ pipeline.Source = HLSSource(nil)
	_ LicenseProvider = New()
)

func TestNew_ReturnsProvider(t *testing.T) {
	t.Parallel()
	if New() == nil {
		t.Fatal("New() returned nil")
	}
}

func TestHLSSource_ImplementsSource(t *testing.T) {
	t.Parallel()
	var s pipeline.Source = HLSSource([]string{"a", "b"})
	if s == nil {
		t.Fatal("HLSSource returned nil")
	}
}

func TestLicenseRequest_Fields(t *testing.T) {
	t.Parallel()
	// Field names + types are part of the frozen contract with the apple layer.
	req := LicenseRequest{
		AssetID:        "123",
		KIDBase64:      "kid==",
		URIPrefix:      "skd://k",
		Token:          "tok",
		MediaUserToken: "mut",
	}
	rt := reflect.TypeOf(req)
	want := map[string]reflect.Kind{
		"AssetID":        reflect.String,
		"KIDBase64":      reflect.String,
		"URIPrefix":      reflect.String,
		"Token":          reflect.String,
		"MediaUserToken": reflect.String,
	}
	for name, kind := range want {
		f, ok := rt.FieldByName(name)
		if !ok {
			t.Errorf("LicenseRequest missing field %s", name)
			continue
		}
		if f.Type.Kind() != kind {
			t.Errorf("field %s kind = %v want %v", name, f.Type.Kind(), kind)
		}
	}
	if rt.NumField() != len(want) {
		t.Errorf("LicenseRequest has %d fields, want %d", rt.NumField(), len(want))
	}
}

// fakeDecryptor implements pipeline.Decryptor without any key material.
type fakeDecryptor struct {
	called bool
	gotR   io.Reader
	gotW   io.Writer
}

func (d *fakeDecryptor) Decrypt(ctx context.Context, r io.Reader, w io.Writer) error {
	d.called = true
	d.gotR = r
	d.gotW = w
	_, err := io.Copy(w, r)
	return err
}

func TestDecryptStage_Integration(t *testing.T) {
	t.Parallel()
	// The apple layer wraps a Decryptor with pipeline.DecryptStage. Verify that
	// path calls Decrypt with the provided reader and writer.
	dec := &fakeDecryptor{}
	stage := pipeline.DecryptStage(dec)
	src := bytes.NewReader([]byte("cipher"))
	var dst bytes.Buffer
	if err := stage.Process(context.Background(), src, &dst); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !dec.called {
		t.Fatal("Decrypt was not called")
	}
	if dst.String() != "cipher" {
		t.Errorf("output = %q want passthrough", dst.String())
	}
}
