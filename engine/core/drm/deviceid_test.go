package drm

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func androidIDOf(t *testing.T, dir string) string {
	t.Helper()
	info, err := DeviceInfo(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(info, deviceInfoPrefix) || strings.Count(info, "/") != 8 {
		t.Fatalf("device string %q is not the 9-field wrapper format", info)
	}
	return strings.TrimPrefix(info, deviceInfoPrefix)
}

func TestNewInstallGetsItsOwnStableDeviceID(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	idA, idB := androidIDOf(t, a), androidIDOf(t, b)
	if !androidIDRe.MatchString(idA) || idA == legacyAndroidID {
		t.Fatalf("new install got %q, want a fresh 16-hex Android ID", idA)
	}
	if idA == idB {
		t.Fatal("two installs got the same device ID")
	}
	if again := androidIDOf(t, a); again != idA {
		t.Fatalf("device ID changed between starts: %q then %q", idA, again)
	}
	if fi, err := os.Stat(filepath.Join(a, deviceIDFile)); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600) {
		t.Fatalf("device-id must be stored with mode 0600: %v %v", fi, err)
	}
}

// Apple ties a saved login to its device ID: an existing session keeps the
// shared ID it was created with instead of being signed out by the upgrade.
func TestExistingSessionKeepsTheSharedID(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	if id := androidIDOf(t, dir); id != legacyAndroidID {
		t.Fatalf("existing session got %q, want the shared ID it logged in with", id)
	}
}

func TestCorruptDeviceIDIsReplaced(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, deviceIDFile), []byte("not-an-id\n"), 0o600)
	if id := androidIDOf(t, dir); !androidIDRe.MatchString(id) {
		t.Fatalf("corrupt file produced %q", id)
	}
}

// Sign-out keeps the device ID, as Apple's own apps do (a legacy install keeps the
// legacy ID Apple already trusts); only Forget This Device gives a fresh one.
func TestLogoutKeepsTheIDAndForgetDeviceRenewsIt(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "session-ready"), []byte("1"), 0o600)
	if androidIDOf(t, dir) != legacyAndroidID {
		t.Fatal("setup: expected the legacy ID")
	}
	if err := NewSessionManager(dir).ClearSession(); err != nil {
		t.Fatal(err)
	}
	if id := androidIDOf(t, dir); id != legacyAndroidID {
		t.Fatalf("sign-out changed the device ID to %q", id)
	}
	s := NewSessionManager(dir)
	if err := s.MarkLogoutPending(scopeDevice); err != nil {
		t.Fatal(err)
	}
	if err := s.CompletePendingLogout(); err != nil {
		t.Fatal(err)
	}
	if id := androidIDOf(t, dir); id == legacyAndroidID || !androidIDRe.MatchString(id) {
		t.Fatalf("after forgetting the device got %q, want a fresh unique ID", id)
	}
}
