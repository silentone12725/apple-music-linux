package appdir

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPrivateTempIsOwnerOnly(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	dir, err := PrivateTemp()
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && !privateDir(dir) {
		t.Fatalf("%s is not private", dir)
	}
}

func TestPrivateTempRefusesAnotherUsersDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("modes do not apply")
	}
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	squatted := filepath.Join(tmp, fmt.Sprintf("adam-%d", os.Getuid()))
	if err := os.Mkdir(squatted, 0o755); err != nil { // someone left it open to others
		t.Fatal(err)
	}
	dir, err := PrivateTemp()
	if err != nil {
		t.Fatal(err)
	}
	if dir == squatted {
		t.Fatal("reused a directory other users can write to")
	}
	link := filepath.Join(tmp, "elsewhere")
	if err := os.Symlink(t.TempDir(), link); err != nil || privateDir(link) {
		t.Fatalf("a symlink must not count as ours (err=%v)", err)
	}
}
