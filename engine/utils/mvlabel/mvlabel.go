// Package mvlabel holds the most recently selected MV video quality label
// (e.g. "1920x1080"). It is a shared data cell with no other dependencies
// so that engine/core/apple can write it and engine (main) can read it
// without engine/core/apple needing to import engine/utils/aacstream.
package mvlabel

import "sync"

var mu sync.RWMutex
var label string

// Set records the resolution string of the most recently selected MV variant.
func Set(resolution string) {
	mu.Lock()
	label = resolution
	mu.Unlock()
}

// Get returns the cached MV quality label, e.g. "1920x1080". Empty if unset.
func Get() string {
	mu.RLock()
	defer mu.RUnlock()
	return label
}
