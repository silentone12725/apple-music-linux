package main

import (
	"sync"
)

// loadOrder keeps /vlc/load requests in arrival order. Opening a source can take
// a while (it may wait for a cache writer), so an earlier request can finish
// after a later one; without this its LoadSource would replace the newer track.
type loadOrder struct {
	mu  sync.Mutex
	seq uint64
}

// begin registers a request as the newest one.
func (o *loadOrder) begin() uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.seq++
	return o.seq
}

// runIfCurrent calls fn only while no newer request has begun, and reports
// whether it did. Holding the lock across fn means two requests never reach
// the player at once, so the newest one is always the last to load.
func (o *loadOrder) runIfCurrent(seq uint64, fn func() error) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.seq != seq {
		return false, nil
	}
	return true, fn()
}
