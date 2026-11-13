package main

import (
	"context"
	"testing"
	"testing/synctest"

	"engine/core/diskcache"
)

func TestALACGateSharedWriterAndBackground(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache, err := diskcache.New(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		writer, _ := cache.BeginStreamingPut("same", "alac")
		defer writer.Discard()
		other, _ := cache.BeginStreamingPut("other", "alac")
		defer other.Discard()
		g := newALACGate()
		gen := g.Foreground("B", true)
		g.bindWriter(gen, writer, true)
		foreground := make(chan error, 1)
		background := make(chan error, 1)
		go func() { _, err := g.writer(t.Context(), "A", writer).Write([]byte("shared")); foreground <- err }()
		go func() { _, err := g.writer(t.Context(), "C", other).Write([]byte("background")); background <- err }()
		synctest.Wait()
		select {
		case err := <-foreground:
			if err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatal("shared producer parked behind playback Session B")
		}
		select {
		case <-background:
			t.Fatal("unrelated background download escaped the gate")
		default:
		}
		g.done("A", writer)
		if err := <-background; err != nil {
			t.Fatal(err)
		}
	})
}

func TestALACGateStaleSelectionCannotOverrideCurrent(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache, _ := diskcache.New(t.TempDir())
		a, _ := cache.BeginStreamingPut("A", "alac")
		defer a.Discard()
		c, _ := cache.BeginStreamingPut("C", "alac")
		defer c.Discard()
		g := newALACGate()
		first := g.Foreground("A", true)
		g.bindWriter(first, a, true)
		g.Foreground("B", true)
		old := g.Foreground("A-again", true)
		current := g.Foreground("C", true)
		g.bindWriter(current, c, true)
		// An old load returning after C selected its producer must be inert.
		returned := make(chan struct{})
		go func() {
			g.bindWriter(old, a, true)
			g.release(old)
			g.done("A", a)
			close(returned)
		}()
		<-returned
		if g.source != c || !g.held {
			t.Fatal("stale A changed C's foreground state")
		}
		done := make(chan error, 1)
		ctx, cancel := context.WithCancel(t.Context())
		go func() { _, err := g.writer(ctx, "A", a).Write([]byte("old")); done <- err }()
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("old producer no longer background")
		default:
		}
		// Promoting an already parked writer must wake it immediately.
		next := g.Foreground("new-A", true)
		g.bindWriter(next, a, true)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		cancel()
	})
}

func TestALACGateSharedWriterThreshold(t *testing.T) {
	cache, _ := diskcache.New(t.TempDir())
	w, _ := cache.BeginStreamingPut("A", "alac")
	defer w.Discard()
	g := newALACGate()
	gen := g.Foreground("B", true)
	g.bindWriter(gen, w, true)
	if _, err := g.writer(t.Context(), "A", w).Write(make([]byte, alacStartBytes)); err != nil {
		t.Fatal(err)
	}
	if g.held {
		t.Fatal("actual producer's bytes did not release the gate")
	}
	if alacStartBytes != 3<<20 || alacHoldMax.Seconds() != 15 {
		t.Fatal("scheduling constants changed")
	}
}
