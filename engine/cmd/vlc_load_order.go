package main

import (
	"sync"
	"sync/atomic"
)

// loadOrder keeps /vlc/load requests in arrival order. Opening a source can take
// a while (it may wait for a cache writer), so an earlier request can finish
// after a later one; without this its LoadSource would replace the newer track.
type loadOrder struct {
	mu      sync.Mutex
	seq     atomic.Uint64
	applied uint64
}

// The load-order mutex is outermost. Session manager and owner-gate calls
// release their own locks before we enter Player.
func (o *loadOrder) withPlayer(fn func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	fn()
}

// stop invalidates older opens, but does not interrupt a newer load already applied.
func (o *loadOrder) stop(fn func()) {
	seq := o.begin()
	o.withPlayer(func() {
		if seq > o.applied {
			o.applied = seq
			fn()
		}
	})
}

// begin registers a request as the newest one.
func (o *loadOrder) begin() uint64 { return o.seq.Add(1) }

// runIfCurrent calls fn only while no newer request has begun, and reports
// whether it did. Holding the lock across fn means two requests never reach
// the player at once, so the newest one is always the last to load.
func (o *loadOrder) runIfCurrent(seq uint64, fn func() error) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.seq.Load() != seq {
		return false, nil
	}
	if err := fn(); err != nil {
		return true, err
	}
	o.applied = seq
	return true, nil
}
