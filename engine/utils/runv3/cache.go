package runv3

// cache.go — persistent on-disk segment cache with LRU eviction.
//
// Cached segment files live under CacheDir (default: OS cache dir).
// The cache key is derived from the segment URL (SHA-256 of the URL, hex).
// When a segment is fetched, it is written to disk; subsequent downloads of
// the same URL return the cached bytes, skipping the network entirely.
//
// Eviction uses a simple LRU policy enforced at cache insertion time:
// if the total cache size exceeds CacheMaxBytes, the least-recently-accessed
// files are deleted until the limit is satisfied.

import (
	"container/list"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	// CacheMaxBytes is the default maximum on-disk cache size (512 MiB).
	// Set to 0 to disable the cache.
	CacheMaxBytes int64 = 512 * 1024 * 1024

	// CacheDir is the subdirectory under os.UserCacheDir().
	cacheDirName = "apple-music-cli/segments"
)

// segmentCache is a global LRU segment cache.
var segmentCache = &SegmentCache{}

func init() {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	segmentCache.dir = filepath.Join(base, cacheDirName)
	segmentCache.maxBytes = CacheMaxBytes
	os.MkdirAll(segmentCache.dir, 0700)
}

// SegmentCache manages a bounded on-disk cache for HLS segment bytes.
type SegmentCache struct {
	dir      string
	maxBytes int64

	mu       sync.Mutex
	lru      list.List                // front = most recent
	entries  map[string]*list.Element // key → element
	totalSz  int64

	Hits   int64
	Misses int64
}

type cacheEntry struct {
	key  string
	size int64
	atime time.Time
}

// cacheKey returns the hex SHA-256 of the URL.
func cacheKey(url string) string {
	h := sha256.Sum256([]byte(url))
	return fmt.Sprintf("%x", h)
}

func (c *SegmentCache) cachePath(key string) string {
	return filepath.Join(c.dir, key[:2], key)
}

// On-disk format: [32 bytes SHA-256 of content] [content bytes]
// This lets us detect corruption and stale URL-reuse (Apple rotates access
// tokens in segment URLs; the content hash catches a URL reuse collision).

// Get returns the cached segment bytes for url, or (nil, false).
// The stored SHA-256 prefix is verified on every read; a mismatch deletes
// the corrupt entry and returns a miss.
func (c *SegmentCache) Get(url string) ([]byte, bool) {
	if c.maxBytes == 0 {
		return nil, false
	}
	key := cacheKey(url)
	path := c.cachePath(key)
	raw, err := os.ReadFile(path)
	if err != nil {
		c.mu.Lock()
		c.Misses++
		c.mu.Unlock()
		return nil, false
	}
	if len(raw) < 32 {
		os.Remove(path)
		c.mu.Lock()
		c.Misses++
		c.mu.Unlock()
		return nil, false
	}
	var stored [32]byte
	copy(stored[:], raw[:32])
	content := raw[32:]
	if sha256.Sum256(content) != stored {
		// Corrupt or stale entry — evict and return miss.
		os.Remove(path)
		c.mu.Lock()
		c.Misses++
		if el, ok := c.entries[key]; ok {
			c.totalSz -= el.Value.(*cacheEntry).size
			c.lru.Remove(el)
			delete(c.entries, key)
		}
		c.mu.Unlock()
		return nil, false
	}

	now := time.Now()
	os.Chtimes(path, now, now)
	c.mu.Lock()
	c.Hits++
	if el, ok := c.entries[key]; ok {
		c.lru.MoveToFront(el)
		el.Value.(*cacheEntry).atime = now
	}
	c.mu.Unlock()
	return content, true
}

// Put writes data for url to the cache with a SHA-256 integrity prefix.
func (c *SegmentCache) Put(url string, data []byte) {
	if c.maxBytes == 0 || len(data) == 0 {
		return
	}
	key := cacheKey(url)
	path := c.cachePath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return
	}
	// Prepend SHA-256 of data so reads can self-verify.
	hash := sha256.Sum256(data)
	buf := make([]byte, 32+len(data))
	copy(buf[:32], hash[:])
	copy(buf[32:], data)

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf, 0600); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return
	}

	size := int64(len(data))
	c.mu.Lock()
	if el, ok := c.entries[key]; ok {
		// Update existing entry.
		old := el.Value.(*cacheEntry)
		c.totalSz -= old.size
		old.size = size
		old.atime = time.Now()
		c.lru.MoveToFront(el)
	} else {
		if c.entries == nil {
			c.entries = make(map[string]*list.Element)
		}
		el = c.lru.PushFront(&cacheEntry{key: key, size: size, atime: time.Now()})
		c.entries[key] = el
	}
	c.totalSz += size
	c.mu.Unlock()

	c.evictIfNeeded()
}

// evictIfNeeded removes least-recently-used entries until totalSz ≤ maxBytes.
func (c *SegmentCache) evictIfNeeded() {
	if c.maxBytes <= 0 {
		return
	}
	c.mu.Lock()
	for c.totalSz > c.maxBytes && c.lru.Len() > 0 {
		el := c.lru.Back()
		if el == nil {
			break
		}
		entry := el.Value.(*cacheEntry)
		c.lru.Remove(el)
		delete(c.entries, entry.key)
		c.totalSz -= entry.size
		// Delete the file outside the lock.
		key := entry.key
		c.mu.Unlock()
		os.Remove(c.cachePath(key))
		c.mu.Lock()
	}
	c.mu.Unlock()
}

// WarmFromDisk loads cache metadata from the existing on-disk files so that
// the in-memory LRU reflects existing cached segments after a restart.
func (c *SegmentCache) WarmFromDisk() {
	if c.maxBytes == 0 {
		return
	}
	type fileInfo struct {
		key   string
		size  int64
		atime time.Time
	}
	var files []fileInfo
	filepath.Walk(c.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || len(info.Name()) != 64 {
			return nil
		}
		// Subtract the 32-byte hash prefix so totalSz tracks content bytes.
	sz := info.Size() - 32
	if sz < 0 {
		sz = 0
	}
	files = append(files, fileInfo{info.Name(), sz, info.ModTime()})
		return nil
	})
	// Sort by access time so most-recently-used ends up at front of LRU.
	sort.Slice(files, func(i, j int) bool {
		return files[i].atime.Before(files[j].atime)
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*list.Element)
	}
	for _, f := range files {
		el := c.lru.PushFront(&cacheEntry{key: f.key, size: f.size, atime: f.atime})
		c.entries[f.key] = el
		c.totalSz += f.size
	}
}

// CacheStats returns hit and miss counts.
func CacheStats() (hits, misses int64) {
	segmentCache.mu.Lock()
	defer segmentCache.mu.Unlock()
	return segmentCache.Hits, segmentCache.Misses
}

// GetCachedSegment is the public entrypoint used by downloadAndAssemble.
func GetCachedSegment(url string) ([]byte, bool) {
	return segmentCache.Get(url)
}

// PutCachedSegment stores a segment in the cache.
func PutCachedSegment(url string, data []byte) {
	segmentCache.Put(url, data)
}

// WarmCache warms the in-memory LRU index from existing on-disk files.
// Call once at startup.
func WarmCache() {
	go segmentCache.WarmFromDisk()
}

// SetCacheMaxBytes overrides the default cache size limit.
// Call before any downloads begin.
func SetCacheMaxBytes(n int64) {
	segmentCache.maxBytes = n
}
