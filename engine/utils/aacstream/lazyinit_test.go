package aacstream

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Importing the package must not create directories or read the user's files. The
// check runs this test binary again with an empty cache/config home: its init functions
// run before any test, so anything they create shows up there.
func TestImportHasNoFilesystemSideEffects(t *testing.T) {
	home := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDoesNothing$")
	cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CACHE_HOME="+filepath.Join(home, "cache"),
		"XDG_CONFIG_HOME="+filepath.Join(home, "config"), "AACSTREAM_HELPER=noop")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("importing aacstream created %v under the user's home", names)
	}
}

func TestHelperDoesNothing(t *testing.T) {
	if os.Getenv("AACSTREAM_HELPER") == "" {
		t.Skip("helper for TestImportHasNoFilesystemSideEffects")
	}
}

// SetCacheBaseDir redirects where the caches live, as long as it comes before first use.
func TestSetCacheBaseDirBeforeFirstUse(t *testing.T) {
	base := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperUsesCustomBase$")
	cmd.Env = append(os.Environ(), "AACSTREAM_HELPER=base", "AACSTREAM_BASE="+base,
		"XDG_CACHE_HOME="+t.TempDir())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(base, cacheDirName)); err != nil {
		t.Fatalf("segment cache not created under the configured base: %v", err)
	}
}

func TestHelperUsesCustomBase(t *testing.T) {
	if os.Getenv("AACSTREAM_HELPER") != "base" {
		t.Skip("helper for TestSetCacheBaseDirBeforeFirstUse")
	}
	if err := SetCacheBaseDir(os.Getenv("AACSTREAM_BASE")); err != nil {
		t.Fatal(err)
	}
	PutCachedSegment("https://example.invalid/seg", []byte("x"))
	if err := SetCacheBaseDir("/elsewhere"); err == nil {
		t.Fatal("SetCacheBaseDir after first use must fail")
	}
}
