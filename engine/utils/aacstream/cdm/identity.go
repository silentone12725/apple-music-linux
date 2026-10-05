package wv

import (
	"log/slog"
	"os"
	"path/filepath"
)

// IdentityDir is where an operator-supplied Widevine device identity is read
// from: $AML_WIDEVINE_DIR, else <user config dir>/apple-music-linux/widevine.
// It holds device_private_key (PEM) and device_client_id_blob (raw bytes).
func IdentityDir() string {
	if d := os.Getenv("AML_WIDEVINE_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "apple-music-linux", "widevine")
}

// InitConstants loads the device identity from IdentityDir when both files are
// present and falls back to the built-in default otherwise, so existing
// installs keep working.
func InitConstants() {
	if dir := IdentityDir(); dir != "" {
		key, kerr := os.ReadFile(filepath.Join(dir, "device_private_key"))
		cid, cerr := os.ReadFile(filepath.Join(dir, "device_client_id_blob"))
		if kerr == nil && cerr == nil {
			DefaultPrivateKey, DefaultClientID = string(key), cid
			return
		}
	}
	slog.Debug("widevine: no identity in config dir, using built-in default", slog.String("dir", IdentityDir()))
	loadEmbedded()
}
