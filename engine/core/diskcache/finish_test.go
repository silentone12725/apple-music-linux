package diskcache

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStreamingFinishIsSingleShot(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := c.BeginStreamingPut("a", "alac")
	if err != nil || first == nil {
		t.Fatalf("first writer: %v, %v", first, err)
	}
	first.Discard()

	// A newer writer now owns the key and its temp file.
	second, err := c.BeginStreamingPut("a", "alac")
	if err != nil || second == nil {
		t.Fatalf("second writer: %v, %v", second, err)
	}
	if _, err := second.Write([]byte("live")); err != nil {
		t.Fatal(err)
	}

	first.Discard() // a stray repeat must not touch the newer writer
	if err := first.Commit(); err == nil {
		t.Fatal("Commit after Discard must fail")
	}
	if w, err := c.BeginStreamingPut("a", "alac"); err != nil || w != nil {
		t.Fatalf("the key was released under a live writer: %v, %v", w, err)
	}
	if _, err := os.Stat(second.file.Name()); err != nil {
		t.Fatalf("a stale Discard removed the live writer's temp file: %v", err)
	}

	if err := second.Commit(); err != nil {
		t.Fatal(err)
	}
	second.Discard() // after Commit it must do nothing, not remove or unpublish
	if err := second.Commit(); err == nil {
		t.Fatal("a second Commit must fail")
	}
	got, err := os.ReadFile(filepath.Join(c.dir, c.filename("a", "alac")))
	if err != nil || string(got) != "live" {
		t.Fatalf("committed entry = %q, %v", got, err)
	}
}

func TestCommitPublishesTheWholeFile(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pw, err := c.BeginPut("b", "alac")
	if err != nil || pw == nil {
		t.Fatalf("BeginPut: %v, %v", pw, err)
	}
	pw.Write([]byte("whole"))
	if err := pw.Commit(); err != nil {
		t.Fatal(err)
	}
	sw, err := c.BeginStreamingPut("c", "alac")
	if err != nil || sw == nil {
		t.Fatalf("BeginStreamingPut: %v, %v", sw, err)
	}
	r := sw.NewReader()
	defer r.Close()
	sw.Write([]byte("streamed"))
	if err := sw.Commit(); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"b": "whole", "c": "streamed"} {
		got, err := os.ReadFile(filepath.Join(c.dir, c.filename(key, "alac")))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v; want %q", key, got, err, want)
		}
	}
}

func TestEvictReclaimsOnlyStaleTmpFiles(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "crashed-alac.m4a.tmp")
	fresh := filepath.Join(dir, "downloading-alac.m4a.tmp")
	kept := filepath.Join(dir, "done-alac.m4a")
	for _, p := range []string{stale, fresh, kept} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-staleTmpAge - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(kept, old, old); err != nil { // old committed entries are not tmp files
		t.Fatal(err)
	}

	c.Evict() // no size limit set: only the orphan sweep runs

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale tmp file survived: %v", err)
	}
	for _, p := range []string{fresh, kept} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s was removed: %v", filepath.Base(p), err)
		}
	}
}
