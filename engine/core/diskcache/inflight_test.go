package diskcache

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveInFlightDropsUnfinishedDownloadsOnly(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	w, err := c.BeginPut("111", "alac")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("partial")); err != nil {
		t.Fatal(err)
	}
	done, err := c.BeginPut("222", "aac")
	if err != nil {
		t.Fatal(err)
	}
	done.Write([]byte("whole")) //nolint:errcheck
	if err := done.Commit(); err != nil {
		t.Fatal(err)
	}

	c.RemoveInFlight()

	if left, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(left) != 0 {
		t.Fatalf("unfinished downloads left behind: %v", left)
	}
	if _, err := os.Stat(filepath.Join(dir, c.filename("222", "aac"))); err != nil {
		t.Fatalf("a committed entry must stay: %v", err)
	}
	c.RemoveInFlight() // idempotent
}
