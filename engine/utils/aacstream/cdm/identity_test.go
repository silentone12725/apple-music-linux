package wv

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitConstantsPrefersConfiguredIdentity(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AML_WIDEVINE_DIR", dir)
	InitConstants()
	if len(DefaultPrivateKey) < 100 {
		t.Fatal("expected built-in fallback when dir is empty")
	}
	os.WriteFile(filepath.Join(dir, "device_private_key"), []byte("KEY"), 0o600)
	os.WriteFile(filepath.Join(dir, "device_client_id_blob"), []byte{1, 2}, 0o600)
	InitConstants()
	if DefaultPrivateKey != "KEY" || len(DefaultClientID) != 2 {
		t.Fatal("configured identity not used")
	}
}
