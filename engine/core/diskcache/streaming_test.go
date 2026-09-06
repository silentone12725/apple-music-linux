package diskcache

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestStreamingPutWriter_BasicReadWrite(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}

	spw, err := c.BeginStreamingPut("asset1", "alac")
	if err != nil || spw == nil {
		t.Fatalf("BeginStreamingPut failed: %v", err)
	}

	want := []byte("hello from the writer side of the streaming cache")

	// Reader goroutine must observe all bytes written before EOF.
	var got []byte
	var readErr error
	var wg sync.WaitGroup
	wg.Add(1)
	reader := spw.NewReader()
	go func() {
		defer wg.Done()
		defer reader.Close()
		got, readErr = io.ReadAll(reader)
	}()

	// Write in two halves with a small gap so the reader blocks between them.
	half := len(want) / 2
	if _, err := spw.Write(want[:half]); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := spw.Write(want[half:]); err != nil {
		t.Fatal(err)
	}
	spw.Commit()

	wg.Wait()
	if readErr != nil {
		t.Fatalf("reader error: %v", readErr)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	// Committed file should exist on disk.
	if _, err := os.Stat(filepath.Join(dir, c.filename("asset1", "alac"))); err != nil {
		t.Fatalf("committed file missing: %v", err)
	}
}

func TestStreamingPutWriter_DiscardPropagatesError(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(dir)

	spw, _ := c.BeginStreamingPut("asset2", "alac")
	reader := spw.NewReader()

	var readErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer reader.Close()
		_, readErr = io.ReadAll(reader)
	}()

	spw.Write([]byte("partial data"))
	spw.Discard()

	wg.Wait()
	if readErr == nil {
		t.Fatal("expected error from Discard, got nil")
	}
	// Temp file must be gone.
	tmpPath := filepath.Join(dir, c.filename("asset2", "alac")+".tmp")
	if _, err := os.Stat(tmpPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temp file still exists after Discard")
	}
}

func TestStreamingPutWriter_MultipleReaders(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(dir)

	spw, _ := c.BeginStreamingPut("asset3", "alac")
	const nReaders = 4
	want := bytes.Repeat([]byte("x"), 4096)

	var wg sync.WaitGroup
	results := make([][]byte, nReaders)
	for i := 0; i < nReaders; i++ {
		i := i
		r := spw.NewReader()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer r.Close()
			results[i], _ = io.ReadAll(r)
		}()
	}

	spw.Write(want)
	spw.Commit()
	wg.Wait()

	for i, got := range results {
		if !bytes.Equal(got, want) {
			t.Errorf("reader %d: got %d bytes, want %d", i, len(got), len(want))
		}
	}
}

func TestStreamingPutWriter_NewReaderAt(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(dir)

	spw, _ := c.BeginStreamingPut("asset5", "alac")
	data := []byte("0123456789abcdef")

	// Reader starts at offset 8 and should only see the second half.
	var got []byte
	var wg sync.WaitGroup
	wg.Add(1)
	reader := spw.NewReaderAt(8)
	go func() {
		defer wg.Done()
		defer reader.Close()
		got, _ = io.ReadAll(reader)
	}()

	// Write in two halves; reader at offset 8 must block until second half arrives.
	spw.Write(data[:8])
	time.Sleep(10 * time.Millisecond)
	spw.Write(data[8:])
	spw.Commit()

	wg.Wait()
	if !bytes.Equal(got, data[8:]) {
		t.Fatalf("NewReaderAt(8): got %q, want %q", got, data[8:])
	}
}

func TestStreamingPutWriter_GetStreaming(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(dir)

	if got := c.GetStreaming("asset6", "alac"); got != nil {
		t.Fatal("expected nil before any streaming put")
	}

	spw, _ := c.BeginStreamingPut("asset6", "alac")
	if got := c.GetStreaming("asset6", "alac"); got != spw {
		t.Fatal("GetStreaming did not return the in-progress writer")
	}

	spw.Discard()
	if got := c.GetStreaming("asset6", "alac"); got != nil {
		t.Fatal("expected nil after Discard")
	}
}

func TestStreamingPutWriter_InFlightBlocksSecondPut(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(dir)

	spw1, _ := c.BeginStreamingPut("asset4", "alac")
	spw2, err := c.BeginStreamingPut("asset4", "alac")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if spw2 != nil {
		t.Fatal("second BeginStreamingPut should return nil while first is in flight")
	}
	spw1.Discard()

	// After discard the slot is free again.
	spw3, _ := c.BeginStreamingPut("asset4", "alac")
	if spw3 == nil {
		t.Fatal("expected non-nil after first writer discarded")
	}
	spw3.Discard()
}
