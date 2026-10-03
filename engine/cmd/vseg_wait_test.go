package main

import (
	"context"
	"testing"
	"time"

	"engine/core/diskcache"
)

func TestWaitForGrowth(t *testing.T) {
	c, err := diskcache.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	spw, _ := c.BeginStreamingPut("mv", "vseg")
	defer spw.Discard()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- waitForGrowth(ctx, spw, 0) }()
	time.Sleep(20 * time.Millisecond)
	cancel() // client disconnect with no producer progress
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waitForGrowth ignored client disconnect")
	}

	go func() { done <- waitForGrowth(context.Background(), spw, 0) }()
	time.Sleep(20 * time.Millisecond)
	spw.Write([]byte("x"))
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("err = %v after growth", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waitForGrowth did not wake on new bytes")
	}
}
