package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTransientVLCSourceSeekAndCleanup(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	src, err := newTransientVLCSource(t.Context(), func(_ context.Context, w io.Writer) error {
		_, err := io.WriteString(w, "0123456789")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	<-src.done
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("temporary playback accessible to other users: %s mode=%o", path, info.Mode().Perm())
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Seek(4, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(src)
	if err != nil || string(b) != "456789" {
		t.Fatalf("read = %q, %v", b, err)
	}
	if src.Size() != 10 {
		t.Fatalf("size = %d", src.Size())
	}
	src.Close()
	src.Close()
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatalf("temporary playback retained: %v", entries)
	}
}

func TestTransientDirCleanupFailureIsReported(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	cleanupTransientDir("owned-test-directory", func(path string) error {
		if path != "owned-test-directory" {
			t.Fatalf("unexpected cleanup target: %s", path)
		}
		return os.ErrPermission
	})
	if !strings.Contains(output.String(), "[vlc] temporary source cleanup failed") ||
		!strings.Contains(output.String(), "permission denied") {
		t.Fatalf("cleanup failure not identified: %q", output.String())
	}
}

func TestTransientVLCSourceConcurrentClose(t *testing.T) {
	src, err := newTransientVLCSource(t.Context(), func(ctx context.Context, w io.Writer) error {
		<-ctx.Done()
		_, err := w.Write([]byte("must not be written after cancellation"))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() { defer wg.Done(); src.Close() }()
	}
	wg.Wait()
	<-src.done
	if n, err := src.writer.Write([]byte("late")); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("late write after Close = %d, %v", n, err)
	}
}

func TestTransientVLCSourceFailure(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	src, err := newTransientVLCSource(t.Context(), func(_ context.Context, w io.Writer) error {
		_, _ = io.WriteString(w, "partial")
		return errors.New("synthetic source failure")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	b, err := io.ReadAll(src)
	if string(b) != "partial" || err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("failure became clean EOF: %q, %v", b, err)
	}
	src.Close()
	<-src.done
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed source retained temporary audio: %v, %v", entries, err)
	}
}

func TestTransientVLCSourceCloseCancelsProducer(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	started := make(chan struct{})
	src, err := newTransientVLCSource(t.Context(), func(ctx context.Context, _ io.Writer) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	readDone := make(chan error, 1)
	go func() { _, err := src.Read(make([]byte, 1)); readDone <- err }()
	src.Close()
	select {
	case <-src.done:
	case <-time.After(time.Second):
		t.Fatal("producer not canceled")
	}
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("canceled reader reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("reader not unblocked")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatalf("temporary playback retained: %v", entries)
	}
}
