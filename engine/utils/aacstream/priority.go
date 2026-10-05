package aacstream

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// Seek-priority gate for MV segment downloads.
//
// The CDN's bandwidth is shared across connections (measured: one connection
// already saturates it, and N parallel ranges are no faster), so while a seek
// producer fetches the segment the player is waiting on, the long-running from-0
// producer must not compete for it. HoldBackground parks every download whose
// context was not marked with WithSeekPriority until released.

type seekPriorityKey struct{}

// WithSeekPriority marks downloads made under ctx as exempt from HoldBackground.
func WithSeekPriority(ctx context.Context) context.Context {
	return context.WithValue(ctx, seekPriorityKey{}, true)
}

func hasSeekPriority(ctx context.Context) bool {
	v, _ := ctx.Value(seekPriorityKey{}).(bool)
	return v
}

var bgHold struct {
	mu    sync.Mutex
	holds int
	wake  chan struct{} // closed (and replaced) when the last hold is released
	n     atomic.Int32  // mirrors holds for a lock-free fast path
}

// HoldBackground parks non-priority MV downloads until the returned release func
// is called or maxHold elapses, whichever is first. Holds nest; release is idempotent.
func HoldBackground(maxHold time.Duration) (release func()) {
	bgHold.mu.Lock()
	if bgHold.wake == nil {
		bgHold.wake = make(chan struct{})
	}
	bgHold.holds++
	bgHold.n.Store(int32(bgHold.holds))
	bgHold.mu.Unlock()

	var once sync.Once
	rel := func() {
		once.Do(func() {
			bgHold.mu.Lock()
			bgHold.holds--
			bgHold.n.Store(int32(bgHold.holds))
			if bgHold.holds == 0 {
				close(bgHold.wake)
				bgHold.wake = make(chan struct{})
			}
			bgHold.mu.Unlock()
		})
	}
	// The cap guarantees a lost release can never park the from-0 producer for good.
	time.AfterFunc(maxHold, rel)
	return rel
}

// waitBackground blocks a non-priority download while any hold is active.
func waitBackground(ctx context.Context) error {
	if bgHold.n.Load() == 0 || hasSeekPriority(ctx) {
		return nil
	}
	for {
		bgHold.mu.Lock()
		if bgHold.holds == 0 {
			bgHold.mu.Unlock()
			return nil
		}
		wake := bgHold.wake
		bgHold.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// gatedReader pauses reads of a background download while a hold is active, so
// the kernel's receive window closes and the connection stops taking bandwidth.
type gatedReader struct {
	ctx context.Context
	r   io.Reader
}

func (g gatedReader) Read(p []byte) (int, error) {
	if err := waitBackground(g.ctx); err != nil {
		return 0, err
	}
	return g.r.Read(p)
}

func gate(ctx context.Context, r io.Reader) io.Reader {
	if hasSeekPriority(ctx) {
		return r
	}
	return gatedReader{ctx: ctx, r: r}
}
