package main

import (
	"context"
	"io"
	"sync"
	"time"

	"engine/core/diskcache"
)

// Foreground-first scheduling for ALAC cache downloads.
//
// The CDN link is shared by every download, so when the user starts a track while an
// earlier track's (or the next track's gapless pre-warm) download is still running, all
// of them fetch at once and the track the player is waiting on gets a fraction of the
// bandwidth. alacGate parks every background download's writer from the moment the
// player loads a track until that track has its first alacStartBytes on disk (or it ends,
// or alacHoldMax passes), then lets them continue. Parking is back-pressure on the
// writer: the stream stops pulling from the CDN until released.
const (
	alacStartBytes = 3 << 20
	alacHoldMax    = 15 * time.Second
)

type alacGate struct {
	mu     sync.Mutex
	fg     string                        // session whose download the player is waiting on
	source *diskcache.StreamingPutWriter // actual shared producer, once selected
	held   bool                          // background writers park while true
	wake   chan struct{}                 // closed when held goes false; non-nil while held
	seen   int64                         // bytes the foreground session has written since Foreground
	gen    uint64                        // invalidates the cap timer of a superseded Foreground call
}

func newALACGate() *alacGate { return &alacGate{} }

// Foreground marks id as the download the player is waiting on. With hold set, every
// other session's writer parks until id has written alacStartBytes, ends, or alacHoldMax
// elapses. A nil gate does nothing.
func (g *alacGate) Foreground(id string, hold bool) uint64 {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.setHeldLocked(false) // wake parked writers so they recheck the new owner
	g.fg, g.seen, g.source = id, 0, nil
	g.gen++
	g.setHeldLocked(hold)
	if hold {
		gen := g.gen
		time.AfterFunc(alacHoldMax, func() {
			g.mu.Lock()
			if g.gen == gen {
				g.setHeldLocked(false)
			}
			g.mu.Unlock()
		})
	}
	return g.gen
}

// bindWriter promotes the producer actually supplying the selected reader.
// An older load must not change a newer foreground selection. No writer lock
// is taken under the gate lock; the caller checks progress after publication.
func (g *alacGate) bindWriter(gen uint64, source *diskcache.StreamingPutWriter, hold bool) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.gen != gen {
		return
	}
	g.setHeldLocked(false)
	g.source = source
	g.setHeldLocked(hold)
}

func (g *alacGate) release(gen uint64) {
	if g == nil {
		return
	}
	g.mu.Lock()
	if g.gen == gen {
		g.setHeldLocked(false)
	}
	g.mu.Unlock()
}

func (g *alacGate) matches(id string, source *diskcache.StreamingPutWriter) bool {
	if g.source != nil {
		return source == g.source
	}
	return id == g.fg
}

func (g *alacGate) setHeldLocked(h bool) {
	if h == g.held {
		return
	}
	g.held = h
	if h {
		g.wake = make(chan struct{})
	} else {
		close(g.wake)
	}
}

// done is called when id's download ends, successfully or not: a foreground that
// finished or failed must not keep the others parked.
func (g *alacGate) done(id string, source ...*diskcache.StreamingPutWriter) {
	if g == nil {
		return
	}
	g.mu.Lock()
	var sw *diskcache.StreamingPutWriter
	if len(source) != 0 {
		sw = source[0]
	}
	if g.matches(id, sw) {
		g.setHeldLocked(false)
	}
	g.mu.Unlock()
}

// wait blocks a non-foreground writer while the gate is held.
func (g *alacGate) wait(ctx context.Context, id string, source *diskcache.StreamingPutWriter) error {
	for {
		g.mu.Lock()
		if !g.held || g.matches(id, source) {
			g.mu.Unlock()
			return nil
		}
		wake := g.wake
		g.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (g *alacGate) wrote(id string, source *diskcache.StreamingPutWriter, n int) {
	g.mu.Lock()
	if g.matches(id, source) && g.held {
		g.seen += int64(n)
		if g.seen >= alacStartBytes {
			g.setHeldLocked(false)
		}
	}
	g.mu.Unlock()
}

// writer wraps w so writes for session id take part in the gate.
func (g *alacGate) writer(ctx context.Context, id string, w io.Writer) io.Writer {
	if g == nil {
		return w
	}
	source, _ := w.(*diskcache.StreamingPutWriter)
	return &gatedWriter{g: g, ctx: ctx, id: id, w: w, source: source}
}

type gatedWriter struct {
	g      *alacGate
	ctx    context.Context
	id     string
	w      io.Writer
	source *diskcache.StreamingPutWriter
}

func (gw *gatedWriter) Write(p []byte) (int, error) {
	if err := gw.g.wait(gw.ctx, gw.id, gw.source); err != nil {
		return 0, err
	}
	n, err := gw.w.Write(p)
	if n > 0 {
		gw.g.wrote(gw.id, gw.source, n)
	}
	return n, err
}
