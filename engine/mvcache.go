package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"

	"engine/utils/aacstream"
	"engine/utils/mvlabel"
)

// mvCachePrefMaxBytes is the last user-requested MV cache capacity.
// Stored separately so we can re-apply it when re-enabling after a disable.
var mvCachePrefMaxBytes atomic.Int64

type mvCachePrefs struct {
	Enabled  bool  `json:"enabled"`
	MaxBytes int64 `json:"maxBytes"`
}

func mvPrefsPath() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "apple-music-linux", "engine", "mv-prefs.json")
}

func loadMVPrefs() {
	data, err := os.ReadFile(mvPrefsPath())
	if err != nil {
		return // first run or no prefs yet, keep defaults
	}
	var p mvCachePrefs
	if err := json.Unmarshal(data, &p); err != nil {
		log.Printf("[mv-cache] prefs parse error: %v", err)
		return
	}
	if p.MaxBytes > 0 {
		mvCachePrefMaxBytes.Store(p.MaxBytes)
	}
	if !p.Enabled {
		aacstream.SetMVCacheMaxBytes(0)
	} else if p.MaxBytes > 0 {
		aacstream.SetMVCacheMaxBytes(p.MaxBytes)
	}
}

func saveMVPrefs() {
	p := mvCachePrefs{
		Enabled:  aacstream.MVCacheEnabled(),
		MaxBytes: mvCachePrefMaxBytes.Load(),
	}
	data, err := json.Marshal(p)
	if err != nil {
		return
	}
	path := mvPrefsPath()
	os.MkdirAll(filepath.Dir(path), 0700)
	if err := os.WriteFile(path, data, 0600); err != nil {
		log.Printf("[mv-cache] prefs save error: %v", err)
	}
}

func init() {
	mvCachePrefMaxBytes.Store(aacstream.DefaultMVCacheMaxBytes)
	loadMVPrefs()
}

// MVCacheGetInfo returns the current MV cache state for the capabilities/stats API.
func MVCacheGetInfo() (enabled bool, maxBytes, sizeBytes int64, quality string) {
	return aacstream.MVCacheEnabled(), aacstream.MVCacheMaxBytes(), aacstream.MVCacheTotalBytes(), mvlabel.Get()
}

func ClearMVCache() error { return aacstream.ClearMVCache() }

// MVCacheSetEnabled turns the MV cache on or off and persists the choice.
func MVCacheSetEnabled(enabled bool) {
	if enabled {
		aacstream.SetMVCacheMaxBytes(mvCachePrefMaxBytes.Load())
	} else {
		aacstream.SetMVCacheMaxBytes(0)
	}
	saveMVPrefs()
}

// MVCacheSetMaxBytes sets the MV cache capacity in bytes, enables the cache, and persists.
func MVCacheSetMaxBytes(n int64) {
	if n > 0 {
		mvCachePrefMaxBytes.Store(n)
	}
	aacstream.SetMVCacheMaxBytes(n)
	saveMVPrefs()
}
