package main

import (
	"context"
	"io"
	"testing"

	"engine/core/diskcache"
)

// A fragment request arriving after the producer committed must still read the
// bytes: without the pin, the cache file is closed once the writer's own
// reference is dropped and the read fails with "file already closed".
func TestPinnedCancelKeepsFileReadableAfterCommit(t *testing.T) {
	c, err := diskcache.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	spw, err := c.BeginStreamingPut("asset", "mv-vseg")
	if err != nil || spw == nil {
		t.Fatalf("BeginStreamingPut: %v", err)
	}
	_, cancel := context.WithCancel(context.Background())
	pc := pinnedCancel(spw, cancel)

	if _, err := spw.Write([]byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if err := spw.Commit(); err != nil {
		t.Fatal(err)
	}

	rd := spw.NewReaderAt(2)
	got, err := io.ReadAll(rd)
	rd.Close()
	if err != nil || string(got) != "23456789" {
		t.Fatalf("read after commit = %q, %v", got, err)
	}

	pc()
	pc() // idempotent: a second cancel must not drop another reference
}
