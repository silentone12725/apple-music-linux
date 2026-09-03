package main

import (
	"sync/atomic"

	"engine/utils/aacstream"
	"engine/utils/mvlabel"
)

// mvCachePrefMaxBytes is the last user-requested MV cache capacity.
// Stored separately so we can re-apply it when re-enabling after a disable.
var mvCachePrefMaxBytes atomic.Int64

func init() { mvCachePrefMaxBytes.Store(aacstream.DefaultMVCacheMaxBytes) }

// MVCacheGetInfo returns the current MV cache state for the capabilities/stats API.
func MVCacheGetInfo() (enabled bool, maxBytes, sizeBytes int64, quality string) {
	return aacstream.MVCacheEnabled(), aacstream.MVCacheMaxBytes(), aacstream.MVCacheTotalBytes(), mvlabel.Get()
}

func ClearMVCache() error { return aacstream.ClearMVCache() }

// MVCacheSetEnabled turns the MV cache on or off.
// When enabling, the last-configured capacity is restored.
func MVCacheSetEnabled(enabled bool) {
	if enabled {
		aacstream.SetMVCacheMaxBytes(mvCachePrefMaxBytes.Load())
	} else {
		aacstream.SetMVCacheMaxBytes(0)
	}
}

// MVCacheSetMaxBytes sets the MV cache capacity in bytes and ensures the cache is enabled.
func MVCacheSetMaxBytes(n int64) {
	if n > 0 {
		mvCachePrefMaxBytes.Store(n)
	}
	aacstream.SetMVCacheMaxBytes(n)
}
