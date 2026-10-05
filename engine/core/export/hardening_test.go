package export

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOutputRootsConfineExports(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil, nil, Options{OutputRoots: []string{root}})

	for dir, want := range map[string]bool{
		root:                                    true,
		filepath.Join(root, "Music", "New"):     true, // not created yet
		outside:                                 false,
		filepath.Join(root, "..", "elsewhere"):  false,
		root + "-sibling":                       false, // shares a prefix, not a path element
		filepath.Join(root, "escape"):           false, // a symlink out of the root
		filepath.Join(root, "escape", "deeper"): false,
		"/etc":                                  false,
	} {
		err := m.checkOutputDir(dir)
		if (err == nil) != want {
			t.Errorf("checkOutputDir(%q) = %v, want allowed=%v", dir, err, want)
		}
	}

	if err := NewManager(nil, nil, Options{}).checkOutputDir("/etc"); err != nil {
		t.Errorf("no roots configured must mean unrestricted, got %v", err)
	}
	if err := NewManager(nil, nil, Options{OutputRoots: []string{"/definitely/not/a/dir/\x00"}}).checkOutputDir(root); err == nil {
		t.Error("roots were configured, so a path outside them must be refused even if no root resolved")
	}
}

func TestEnqueueRefusesOutputDirOutsideRoots(t *testing.T) {
	m := NewManager(nil, nil, Options{OutputRoots: []string{t.TempDir()}})
	_, err := m.Enqueue(ExportRequest{AssetID: "1", OutputDir: "/etc"})
	if err == nil || !strings.Contains(err.Error(), "allowed export directories") {
		t.Fatalf("Enqueue(OutputDir=/etc) = %v, want a refusal", err)
	}
}

func TestFormatNumberOnlyAcceptsZeroPadding(t *testing.T) {
	for format, want := range map[string]string{
		"d": "7", "2d": " 7", "02d": "07", "03d": "007",
		"999999999d": "7", "[9]d": "7", "s": "7", "x": "7", "+d": "7", "": "7", "02d ": "7",
	} {
		if got := formatNumber(format, 7); got != want {
			t.Errorf("formatNumber(%q, 7) = %q, want %q", format, got, want)
		}
	}
}

func TestArtworkDownloadIsBoundedAndCancellable(t *testing.T) {
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, maxArtworkBytes+1024)) //nolint:errcheck
	}))
	defer big.Close()
	if _, _, err := fetchArtworkURL(context.Background(), big.URL); err == nil {
		t.Error("an oversized artwork response was accepted")
	}

	block := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer slow.Close()
	defer close(block)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := downloadArtworkBytes(ctx, slow.URL, 100)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a cancelled download reported success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelling the job did not stop the artwork download")
	}
}
