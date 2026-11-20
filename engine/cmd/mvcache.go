package main

import (
	"encoding/json"
	"engine/internal/appdir"
	"log"
	"os"
	"path/filepath"
	"sync"
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
	return filepath.Join(appdir.Cache(), "engine", "mv-prefs.json")
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

var mvPrefsSaveMu sync.Mutex // concurrent setters must not interleave their writes into one file

func saveMVPrefs() {
	initMVPrefs()
	mvPrefsSaveMu.Lock()
	defer mvPrefsSaveMu.Unlock()
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
	// Through a temp file, so a crash mid-write cannot leave half a file that loadMVPrefs then discards.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		log.Printf("[mv-cache] prefs save error: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		log.Printf("[mv-cache] prefs save error: %v", err)
	}
}

var mvPrefsOnce sync.Once

// initMVPrefs applies the saved MV cache preferences, once. It is called when a server is
// built (and lazily by the accessors below) instead of from init(): importing the package
// must not read the user's files.
func initMVPrefs() {
	mvPrefsOnce.Do(func() {
		mvCachePrefMaxBytes.Store(aacstream.DefaultMVCacheMaxBytes)
		loadMVPrefs()
	})
}

// MVCacheGetInfo returns the current MV cache state for the capabilities/stats API.
func MVCacheGetInfo() (enabled bool, maxBytes, sizeBytes int64, quality string) {
	initMVPrefs()
	return aacstream.MVCacheEnabled(), aacstream.MVCacheMaxBytes(), aacstream.MVCacheTotalBytes(), mvlabel.Get()
}

func ClearMVCache() error { return aacstream.ClearMVCache() }

// MVCacheSetEnabled turns the MV cache on or off and persists the choice.
func MVCacheSetEnabled(enabled bool) {
	initMVPrefs()
	if enabled {
		aacstream.SetMVCacheMaxBytes(mvCachePrefMaxBytes.Load())
	} else {
		aacstream.SetMVCacheMaxBytes(0)
	}
	saveMVPrefs()
}

// MVCacheSetMaxBytes sets the MV cache capacity in bytes, enables the cache, and persists.
func MVCacheSetMaxBytes(n int64) {
	initMVPrefs()
	if n > 0 {
		mvCachePrefMaxBytes.Store(n)
	}
	aacstream.SetMVCacheMaxBytes(n)
	saveMVPrefs()
}
