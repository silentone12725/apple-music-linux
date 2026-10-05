package main

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func writeAsync(w *gatedWriter, n int) <-chan error {
	ch := make(chan error, 1)
	go func() { _, err := w.Write(make([]byte, n)); ch <- err }()
	return ch
}

func expectBlocked(t *testing.T, ch <-chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		t.Fatalf("%s: write returned (%v), want it parked", what, err)
	case <-time.After(50 * time.Millisecond):
	}
}

func expectDone(t *testing.T, ch <-chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	case <-time.After(time.Second):
		t.Fatalf("%s: write still parked", what)
	}
}

func TestALACGate_BackgroundParksUntilForegroundHasStartBytes(t *testing.T) {
	g := newALACGate()
	var bgBuf, fgBuf bytes.Buffer
	bg := g.writer(context.Background(), "bg", &bgBuf).(*gatedWriter)
	fg := g.writer(context.Background(), "fg", &fgBuf).(*gatedWriter)

	g.Foreground("fg", true)
	parked := writeAsync(bg, 10)
	expectBlocked(t, parked, "background")

	// The foreground itself is never parked, and partial progress does not release.
	expectDone(t, writeAsync(fg, alacStartBytes-1), "foreground")
	expectBlocked(t, parked, "background after partial foreground")

	expectDone(t, writeAsync(fg, 1), "foreground")
	expectDone(t, parked, "background after release")
	if bgBuf.Len() != 10 {
		t.Fatalf("background wrote %d bytes, want 10", bgBuf.Len())
	}
}

func TestALACGate_DoneReleases(t *testing.T) {
	g := newALACGate()
	bg := g.writer(context.Background(), "bg", &bytes.Buffer{}).(*gatedWriter)
	g.Foreground("fg", true)
	parked := writeAsync(bg, 1)
	expectBlocked(t, parked, "background")

	g.done("someone-else") // only the foreground's end releases
	expectBlocked(t, parked, "background after unrelated done")

	g.done("fg")
	expectDone(t, parked, "background after foreground done")
}

func TestALACGate_NoHoldNeverParks(t *testing.T) {
	g := newALACGate()
	bg := g.writer(context.Background(), "bg", &bytes.Buffer{}).(*gatedWriter)
	g.Foreground("fg", false) // already cached or well advanced
	expectDone(t, writeAsync(bg, 1), "background with no hold")
}

func TestALACGate_NewForegroundSupersedes(t *testing.T) {
	g := newALACGate()
	a := g.writer(context.Background(), "a", &bytes.Buffer{}).(*gatedWriter)
	g.Foreground("a", true)
	g.Foreground("b", true) // the user moved on before a got its bytes
	expectBlocked(t, writeAsync(a, 1), "former foreground")
}

func TestALACGate_ContextCancelUnparks(t *testing.T) {
	g := newALACGate()
	ctx, cancel := context.WithCancel(context.Background())
	bg := g.writer(ctx, "bg", &bytes.Buffer{}).(*gatedWriter)
	g.Foreground("fg", true)
	parked := writeAsync(bg, 1)
	expectBlocked(t, parked, "background")
	cancel()
	select {
	case err := <-parked:
		if err == nil {
			t.Fatal("cancelled write returned nil error")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled write still parked")
	}
}

func TestALACGate_NilIsTransparent(t *testing.T) {
	var g *alacGate
	var buf bytes.Buffer
	g.Foreground("x", true)
	g.done("x")
	w := g.writer(context.Background(), "x", &buf)
	if _, err := w.Write([]byte("ok")); err != nil || buf.String() != "ok" {
		t.Fatalf("nil gate altered the write: %q, %v", buf.String(), err)
	}
}
