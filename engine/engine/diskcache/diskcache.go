// Package diskcache caches decrypted audio tracks to disk so that replaying a
// track skips the HLS download + decryption pipeline entirely.
//
// Cache layout:
//
//	{dir}/{assetID}-{qualifier}.m4a          ← committed entry
//	{dir}/{assetID}-{qualifier}.m4a.tmp      ← in-progress write (deleted on abort)
//
// The qualifier is the codec name (aac, alac, atmos, …), optionally suffixed
// with "_raw" when the caller requested the native container without transcode.
// Files are named with only alphanumeric/hyphen/underscore chars so the dir is
// ls-friendly with no shell quoting needed.
//
// Eviction is size-based (LRU by mtime) and TTL-based; both are enforced lazily
// after each successful write.  Callers set limits via SetConfig; zero means
// unlimited/no-expiry.
package diskcache

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var unsafeChars = regexp.MustCompile(`[^a-zA-Z0-9_\-]`)

// Cache is safe for concurrent use.
type Cache struct {
	dir string

	limitBytes atomic.Int64 // 0 = unlimited
	ttlDays    atomic.Int64 // 0 = never expire

	// in-flight tracks a put in progress for a given filename so that
	// concurrent requests for the same track don't both write to temp files.
	// Value is struct{}; presence means "write in progress".
	inFlight sync.Map
}

// New returns a Cache rooted at dir, creating it if necessary.
func New(dir string) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Cache{dir: dir}, nil
}

// SetConfig updates the cache limits atomically.  Zero means unlimited/no-expiry.
func (c *Cache) SetConfig(limitMB, ttlDays int64) {
	c.limitBytes.Store(limitMB * 1024 * 1024)
	c.ttlDays.Store(ttlDays)
}

func (c *Cache) filename(assetID, qualifier string) string {
	safe := func(s string) string { return unsafeChars.ReplaceAllString(s, "_") }
	return safe(assetID) + "-" + safe(qualifier) + ".m4a"
}

// Get returns an open *os.File for the cached track, or (nil, false) on miss.
// The caller must close the file.  A hit may still return false if the entry
// has expired (it is deleted and treated as a miss).
func (c *Cache) Get(assetID, qualifier string) (*os.File, bool) {
	path := filepath.Join(c.dir, c.filename(assetID, qualifier))
	info, err := os.Stat(path)
	if err != nil {
		return nil, false
	}

	ttl := c.ttlDays.Load()
	if ttl > 0 && time.Since(info.ModTime()) > time.Duration(ttl)*24*time.Hour {
		os.Remove(path)
		return nil, false
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}

	// Touch mtime so LRU eviction keeps recently accessed entries.
	now := time.Now()
	os.Chtimes(path, now, now)

	return f, true
}

// PutWriter is the handle returned by BeginPut.
// Write to it; then call Commit or Discard.
type PutWriter struct {
	*os.File            // the temp file
	finalPath string
	key       string
	cache     *Cache
	committed bool
}

// BeginPut opens a temp file for a cache write.  Returns (nil, nil) if another
// goroutine is already writing the same key (the caller should skip caching).
func (c *Cache) BeginPut(assetID, qualifier string) (*PutWriter, error) {
	key := c.filename(assetID, qualifier)
	if _, loaded := c.inFlight.LoadOrStore(key, struct{}{}); loaded {
		return nil, nil // already being written; skip
	}

	tmpPath := filepath.Join(c.dir, key+".tmp")
	f, err := os.Create(tmpPath)
	if err != nil {
		c.inFlight.Delete(key)
		return nil, err
	}
	return &PutWriter{
		File:      f,
		finalPath: filepath.Join(c.dir, key),
		key:       key,
		cache:     c,
	}, nil
}

// Commit closes the temp file and renames it to its final path.
// After Commit the cache triggers eviction if a size limit is set.
func (pw *PutWriter) Commit() error {
	pw.File.Close()
	pw.committed = true
	pw.cache.inFlight.Delete(pw.key)
	if err := os.Rename(pw.File.Name(), pw.finalPath); err != nil {
		os.Remove(pw.File.Name())
		return err
	}
	go pw.cache.Evict() // async so it doesn't block the streaming response
	return nil
}

// Discard closes and deletes the temp file without committing.
func (pw *PutWriter) Discard() {
	if pw.committed {
		return
	}
	pw.File.Close()
	os.Remove(pw.File.Name())
	pw.cache.inFlight.Delete(pw.key)
}

// TeeWriter wraps an io.Writer (the HTTP response) and simultaneously writes
// to the PutWriter.  If the cache write fails the stream to dst continues
// unaffected; the put is discarded on first error.
type TeeWriter struct {
	dst io.Writer
	pw  *PutWriter
	bad bool // cache write failed; stop trying
}

// NewTee returns a TeeWriter that writes to dst and pw simultaneously.
// dst may be nil and set later via SetDst before the first Write.
// If pw is nil the TeeWriter is a transparent pass-through to dst.
func NewTee(dst io.Writer, pw *PutWriter) *TeeWriter {
	return &TeeWriter{dst: dst, pw: pw}
}

// SetDst sets the primary destination writer.  Must be called before Write.
func (t *TeeWriter) SetDst(dst io.Writer) { t.dst = dst }

func (t *TeeWriter) Write(p []byte) (int, error) {
	n, err := t.dst.Write(p)
	if n > 0 && t.pw != nil && !t.bad {
		if _, cerr := t.pw.Write(p[:n]); cerr != nil {
			t.bad = true
			t.pw.Discard()
			t.pw = nil
		}
	}
	return n, err
}

// Finish commits the cache entry if the stream completed without error, or
// discards the temp file if err != nil.
func (t *TeeWriter) Finish(streamErr error) {
	if t.pw == nil {
		return
	}
	if streamErr != nil {
		t.pw.Discard()
		return
	}
	t.pw.Commit()
}

// Stats returns the total size in bytes and file count of committed cache entries.
func (c *Cache) Stats() (totalBytes int64, count int) {
	entries, _ := os.ReadDir(c.dir)
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		if info, err := e.Info(); err == nil {
			totalBytes += info.Size()
			count++
		}
	}
	return
}

// Clear deletes all committed cache entries (not temp files).
func (c *Cache) Clear() error {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		os.Remove(filepath.Join(c.dir, e.Name()))
	}
	return nil
}

// Evict removes the oldest entries (by mtime) until the total size is below
// the configured limit.  No-op when no limit is set.
func (c *Cache) Evict() {
	limit := c.limitBytes.Load()
	if limit == 0 {
		return
	}

	type entry struct {
		path  string
		size  int64
		mtime time.Time
	}

	entries, _ := os.ReadDir(c.dir)
	var files []entry
	var total int64
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, entry{
			path:  filepath.Join(c.dir, e.Name()),
			size:  info.Size(),
			mtime: info.ModTime(),
		})
		total += info.Size()
	}
	if total <= limit {
		return
	}

	// Oldest first.
	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime.Before(files[j].mtime)
	})
	for _, f := range files {
		if total <= limit {
			break
		}
		os.Remove(f.path)
		total -= f.size
	}
}

// EvictExpired removes all entries older than the configured TTL.
// No-op when TTL is zero.
func (c *Cache) EvictExpired() {
	ttl := c.ttlDays.Load()
	if ttl == 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(ttl) * 24 * time.Hour)
	entries, _ := os.ReadDir(c.dir)
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			os.Remove(filepath.Join(c.dir, e.Name()))
		}
	}
}
