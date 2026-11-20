package drm

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The wrapper's default 9-field device string. Only the last field, the Android
// ID, identifies the device to Apple; it used to be the same for every install.
const (
	// The locale and language (en-US twice) are part of this string and are what Apple's library answers in:
	// its dialogs ("Retry", "Cancel", "Sign In") and its error text are English whatever language the page is in.
	// ClassifySignInError and the account sheet's wrong-password dialog match that English text, so changing the
	// locale here means changing them too; TestDeviceInfoPinsTheEnglishLocale fails until you do.
	deviceInfoPrefix = "Music/4.9/Android/10/Samsung S9/7663313/en-US/en-US/"
	legacyAndroidID  = "dc28071e981c439e"
	deviceIDFile     = "device-id"
)

var androidIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// DeviceInfo returns this install's device string for the FairPlay session.
//
// The Android ID is generated once (64 random bits, like a real Android ID) and
// kept in baseDir/device-id. Apple ties a saved login to the ID it was created
// with, so an install that already has a working session keeps the old shared
// ID until its next logout (ClearSession removes the file), instead of being
// signed out by the upgrade.
func DeviceInfo(baseDir string) (string, error) {
	id, err := androidID(baseDir)
	if err != nil {
		return "", err
	}
	return deviceInfoPrefix + id, nil
}

func androidID(baseDir string) (string, error) {
	path := filepath.Join(baseDir, deviceIDFile)
	if b, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(b)); androidIDRe.MatchString(id) {
			return id, nil
		}
	}
	id := legacyAndroidID
	if _, err := os.Stat(filepath.Join(baseDir, "session-ready")); err != nil {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		id = hex.EncodeToString(b[:])
	}
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return "", err
	}
	// Publish with a hard link, which fails when another caller got there first; then both use that caller's ID
	// instead of the later rename silently replacing it and leaving this session on an ID the file no longer holds.
	f, err := os.CreateTemp(baseDir, deviceIDFile+".tmp-*")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.WriteString(id + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if err := os.Link(tmp, path); err != nil {
		if b, rerr := os.ReadFile(path); rerr == nil {
			if existing := strings.TrimSpace(string(b)); androidIDRe.MatchString(existing) {
				return existing, nil
			}
		}
		// No hard links here (or the file is unusable): fall back to replacing it.
		if err := os.Rename(tmp, path); err != nil {
			return "", err
		}
	}
	return id, nil
}
