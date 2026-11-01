package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPickedExportRoots(t *testing.T) {
	abs := t.TempDir()
	f := filepath.Join(t.TempDir(), "export-folders.txt")
	os.WriteFile(f, []byte(abs+"\n\nrelative/dir\n  \n"), 0o600) //nolint:errcheck
	t.Setenv("ADAM_EXPORT_PICKED", f)
	got := pickedExportRoots()
	if len(got) != 1 || got[0] != abs {
		t.Fatalf("got %v, want only the absolute path %q", got, abs)
	}
	t.Setenv("ADAM_EXPORT_PICKED", filepath.Join(t.TempDir(), "missing"))
	if got := pickedExportRoots(); got != nil {
		t.Fatalf("missing file gave %v", got)
	}
	t.Setenv("ADAM_EXPORT_PICKED", "")
	if got := pickedExportRoots(); got != nil {
		t.Fatalf("unset env gave %v", got)
	}
}
