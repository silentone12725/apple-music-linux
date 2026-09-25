package main

import (
	"bytes"
	"io"
	"testing"

	"engine/core/diskcache"
)

func TestDiskAudioCache_TailOnlyWhileStreaming(t *testing.T) {
	dc, err := diskcache.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := diskAudioCache{dc}

	if _, ok := a.TailReader("1", "aac"); ok {
		t.Fatal("tail reported with no in-progress download")
	}

	sw, err := dc.BeginStreamingPut("1", "aac")
	if err != nil || sw == nil {
		t.Fatalf("BeginStreamingPut: %v", err)
	}
	sw.Write([]byte("hello "))
	r, ok := a.TailReader("1", "aac")
	if !ok {
		t.Fatal("no tail while playback download in progress")
	}
	if _, ok := a.TailReader("1", "alac"); ok {
		t.Fatal("tail reported for a different qualifier")
	}

	got := make(chan []byte, 1)
	go func() {
		b, err := io.ReadAll(r)
		if err != nil {
			t.Errorf("tail read: %v", err)
		}
		r.Close()
		got <- b
	}()
	sw.Write([]byte("world"))
	if err := sw.Commit(); err != nil {
		t.Fatal(err)
	}
	if b := <-got; !bytes.Equal(b, []byte("hello world")) {
		t.Fatalf("tail bytes %q", b)
	}
	if _, ok := a.Path("1", "aac"); !ok {
		t.Fatal("committed entry not visible via Path")
	}
	if _, ok := a.TailReader("1", "aac"); ok {
		t.Fatal("tail still reported after commit")
	}
}

func TestDiskAudioCache_TailErrorsOnDiscard(t *testing.T) {
	dc, _ := diskcache.New(t.TempDir())
	a := diskAudioCache{dc}
	sw, _ := dc.BeginStreamingPut("1", "aac")
	sw.Write([]byte("partial"))
	r, _ := a.TailReader("1", "aac")
	defer r.Close()
	sw.Discard()
	if _, err := io.ReadAll(r); err == nil {
		t.Fatal("tail read succeeded after the producer discarded")
	}
}
