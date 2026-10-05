package main

import (
	"context"
	"io"
	"sync"
	"time"
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
	mu   sync.Mutex
	fg   string        // session whose download the player is waiting on
	held bool          // background writers park while true
	wake chan struct{} // closed when held goes false; non-nil while held
	seen int64         // bytes the foreground session has written since Foreground
	gen  uint64        // invalidates the cap timer of a superseded Foreground call
}

func newALACGate() *alacGate { return &alacGate{} }

// Foreground marks id as the download the player is waiting on. With hold set, every
// other session's writer parks until id has written alacStartBytes, ends, or alacHoldMax
// elapses. A nil gate does nothing.
func (g *alacGate) Foreground(id string, hold bool) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fg, g.seen = id, 0
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
func (g *alacGate) done(id string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	if id == g.fg {
		g.setHeldLocked(false)
	}
	g.mu.Unlock()
}

// wait blocks a non-foreground writer while the gate is held.
func (g *alacGate) wait(ctx context.Context, id string) error {
	for {
		g.mu.Lock()
		if !g.held || id == g.fg {
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

func (g *alacGate) wrote(id string, n int) {
	g.mu.Lock()
	if id == g.fg && g.held {
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
	return &gatedWriter{g: g, ctx: ctx, id: id, w: w}
}

type gatedWriter struct {
	g   *alacGate
	ctx context.Context
	id  string
	w   io.Writer
}

func (gw *gatedWriter) Write(p []byte) (int, error) {
	if err := gw.g.wait(gw.ctx, gw.id); err != nil {
		return 0, err
	}
	n, err := gw.w.Write(p)
	if n > 0 {
		gw.g.wrote(gw.id, n)
	}
	return n, err
}
