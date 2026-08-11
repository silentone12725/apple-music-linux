package main

import (
	"sync/atomic"

	"engine/utils/runv3"
)

// mvCachePrefMaxBytes is the last user-requested MV cache capacity.
// Stored separately so we can re-apply it when re-enabling after a disable.
var mvCachePrefMaxBytes atomic.Int64

func init() { mvCachePrefMaxBytes.Store(runv3.DefaultMVCacheMaxBytes) }

// MVCacheGetInfo returns the current MV cache state for the capabilities/stats API.
func MVCacheGetInfo() (enabled bool, maxBytes, sizeBytes int64, quality string) {
	return runv3.MVCacheEnabled(), runv3.MVCacheMaxBytes(), runv3.MVCacheTotalBytes(), runv3.MVCacheQualityLabel()
}

func ClearMVCache() error { return runv3.ClearMVCache() }

// MVCacheSetEnabled turns the MV cache on or off.
// When enabling, the last-configured capacity is restored.
func MVCacheSetEnabled(enabled bool) {
	if enabled {
		runv3.SetMVCacheMaxBytes(mvCachePrefMaxBytes.Load())
	} else {
		runv3.SetMVCacheMaxBytes(0)
	}
}

// MVCacheSetMaxBytes sets the MV cache capacity in bytes and ensures the cache is enabled.
func MVCacheSetMaxBytes(n int64) {
	if n > 0 {
		mvCachePrefMaxBytes.Store(n)
	}
	runv3.SetMVCacheMaxBytes(n)
}
