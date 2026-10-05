package aacstream

// mvcache_dec.go — per-track decrypted MP4 cache with per-user encryption.
//
// On first play the full transcoded (decrypted + FFmpeg-remuxed) video is
// written to ~/.cache/aml/engine/mv-dec/<assetID>.enc while simultaneously
// streaming to the HTTP response.  On subsequent plays the cached file is
// decrypted on-the-fly via AES-256-CTR and served directly, skipping the
// entire download → Apple-DRM-decrypt → FFmpeg pipeline.
//
// Encryption key: a random 256-bit value generated once and stored at
// ~/.config/aml/mv-dec.key (mode 0600).  Only the owning Linux user can read
// it; other users on the same machine cannot decrypt the cache.  Reading the
// 32-byte file costs a single syscall (~microseconds); no KDF iterations.
// If the key file cannot be persisted, dec-caching is disabled for that run
// so cached files are never left with an unknown/lost key.
//
// File format: [16-byte random IV][AES-256-CTR ciphertext]

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	mvDecDirName = "engine/mv-dec"
	mvDecKeyFile = "aml/mv-dec.key" // relative to os.UserConfigDir(); mode 0600
	mvDecIVSize  = 16
)

var (
	mvDecDir     string
	mvDecTotalSz atomic.Int64

	mvDecKeyOnce sync.Once
	mvDecKey     []byte // 32 bytes, loaded/generated at first use

	mvDecMu    sync.RWMutex
	mvDecInFlt = map[string]struct{}{} // assetIDs currently being written
)

var mvDecOnce sync.Once

// mvDecDirPath returns the encrypted MV cache directory. It is created, and the size of
// what is already in it counted, on first use rather than at import.
func mvDecDirPath() string {
	mvDecOnce.Do(func() {
		if mvDecDir == "" {
			base, err := os.UserCacheDir()
			if err != nil {
				base = os.TempDir()
			}
			mvDecDir = filepath.Join(base, mvDecDirName)
		}
		os.MkdirAll(mvDecDir, 0700)

		// Account for existing cached files. The directory holds at most ~10-20 large
		// files (bounded by the 2 GB segment cache limit), so the walk is fast.
		var total int64
		filepath.Walk(mvDecDir, func(_ string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() && strings.HasSuffix(info.Name(), ".enc") {
				total += info.Size()
			}
			return nil
		})
		mvDecTotalSz.Store(total)
	})
	return mvDecDir
}

// initMVDecKey loads (or generates) the per-user AES-256 key.
//
// The key lives at ~/.config/aml/mv-dec.key (mode 0600).  On first call it is
// generated from crypto/rand and written; on subsequent calls it is read back.
// Reading 32 bytes from a local file takes microseconds — no KDF iterations needed.
// File permissions prevent other Linux users from reading the key.
func initMVDecKey() {
	mvDecKeyOnce.Do(func() {
		cfgDir, err := os.UserConfigDir()
		if err != nil {
			cfgDir = filepath.Join(os.Getenv("HOME"), ".config")
		}
		keyPath := filepath.Join(cfgDir, mvDecKeyFile)

		raw, rerr := os.ReadFile(keyPath)
		if rerr == nil && len(raw) == 32 {
			mvDecKey = raw
			log.Printf("[mv-dec] key loaded from %s", keyPath)
			return
		}
		// Only a missing file means "no key yet". An unreadable or malformed one must not
		// be replaced: a new key would orphan every cached file encrypted under the old.
		if rerr == nil || !errors.Is(rerr, fs.ErrNotExist) {
			log.Printf("[mv-dec] key file %s unusable (%v) — dec cache disabled; delete it to reset", keyPath, rerr)
			return
		}

		// Generate a fresh random key and persist it.
		// If we can't persist it, do NOT use it: a key that lives only in RAM
		// means the next restart generates a different key, making cached files
		// permanently unreadable.
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			log.Printf("[mv-dec] rand: %v — dec cache disabled", err)
			return
		}
		if err := os.MkdirAll(filepath.Dir(keyPath), 0700); err != nil {
			log.Printf("[mv-dec] mkdir %s: %v — dec cache disabled", filepath.Dir(keyPath), err)
			return
		}
		// O_EXCL: if another process created the key meanwhile, use theirs.
		f, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, fs.ErrExist) {
			if raw, rerr := os.ReadFile(keyPath); rerr == nil && len(raw) == 32 {
				mvDecKey = raw
				return
			}
		}
		if err == nil {
			if _, err = f.Write(key); err == nil {
				err = f.Close()
			} else {
				f.Close()
			}
			if err != nil {
				os.Remove(keyPath) //nolint:errcheck
			}
		}
		if err != nil {
			log.Printf("[mv-dec] write key %s: %v — dec cache disabled", keyPath, err)
			return
		}
		log.Printf("[mv-dec] new key written to %s", keyPath)
		mvDecKey = key
	})
}

func newAESCTR(iv []byte) (cipher.Stream, error) {
	block, err := aes.NewCipher(mvDecKey)
	if err != nil {
		return nil, err
	}
	return cipher.NewCTR(block, iv), nil
}

func mvDecFilePath(assetID string, maxHeight int) string {
	safe := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-' {
			return r
		}
		return '_'
	}, assetID)
	return filepath.Join(mvDecDirPath(), fmt.Sprintf("%s-%d.enc", safe, maxHeight))
}

func mvDecInFltKey(assetID string, maxHeight int) string {
	return fmt.Sprintf("%s:%d", assetID, maxHeight)
}

// MVDecExists reports whether a complete encrypted track file exists for
// assetID at the given quality (maxHeight). Different qualities are cached
// separately so a quality change always triggers a fresh transcode.
func MVDecExists(assetID string, maxHeight int) bool {
	if !MVCacheEnabled() || assetID == "" {
		return false
	}
	mvDecMu.RLock()
	_, inflight := mvDecInFlt[mvDecInFltKey(assetID, maxHeight)]
	mvDecMu.RUnlock()
	if inflight {
		return false
	}
	info, err := os.Stat(mvDecFilePath(assetID, maxHeight))
	return err == nil && info.Size() > mvDecIVSize
}

// MVDecTotalBytes returns the total on-disk size of all cached encrypted track files.
func MVDecTotalBytes() int64 {
	mvDecDirPath() // count what is already on disk before the first read
	return mvDecTotalSz.Load()
}

// ServeMVDec decrypts and copies the cached track for assetID at maxHeight into dst.
func ServeMVDec(assetID string, maxHeight int, dst io.Writer) error {
	initMVDecKey()
	f, err := os.Open(mvDecFilePath(assetID, maxHeight))
	if err != nil {
		return err
	}
	defer f.Close()

	var iv [mvDecIVSize]byte
	if _, err := io.ReadFull(f, iv[:]); err != nil {
		return err
	}
	stream, err := newAESCTR(iv[:])
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, &cipher.StreamReader{S: stream, R: f})
	return err
}

// MVDecCacheWriter returns a writer that writes plaintext to dst and, if
// caching is enabled, simultaneously encrypts to a temp file for caching.
// maxHeight is included in the cache key so different quality selections
// produce separate cache files. Call Commit() on success or Abort() on error.
func MVDecCacheWriter(assetID string, maxHeight int, dst io.Writer) *decCacheWriter {
	if !MVCacheEnabled() || assetID == "" {
		return &decCacheWriter{dst: dst}
	}
	initMVDecKey()

	var iv [mvDecIVSize]byte
	if _, err := rand.Read(iv[:]); err != nil {
		log.Printf("[mv-dec] rand: %v", err)
		return &decCacheWriter{dst: dst}
	}
	stream, err := newAESCTR(iv[:])
	if err != nil {
		log.Printf("[mv-dec] cipher: %v", err)
		return &decCacheWriter{dst: dst}
	}

	tmp, err := os.CreateTemp(mvDecDirPath(), ".dec-*.enc.tmp")
	if err != nil {
		log.Printf("[mv-dec] temp file: %v", err)
		return &decCacheWriter{dst: dst}
	}
	// Write IV header.
	if _, err := tmp.Write(iv[:]); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return &decCacheWriter{dst: dst}
	}

	// Guard against two simultaneous first-plays of the same track+quality:
	// only the first caller caches; the second streams directly without caching.
	fltKey := mvDecInFltKey(assetID, maxHeight)
	mvDecMu.Lock()
	_, alreadyInFlt := mvDecInFlt[fltKey]
	if !alreadyInFlt {
		mvDecInFlt[fltKey] = struct{}{}
	}
	mvDecMu.Unlock()
	if alreadyInFlt {
		tmp.Close()
		os.Remove(tmp.Name())
		return &decCacheWriter{dst: dst}
	}

	cache := &softWriter{w: &cipher.StreamWriter{S: stream, W: tmp}}
	return &decCacheWriter{
		// plaintext → HTTP + encrypt → file. The cache side is fail-soft: a
		// cache write error (disk full) must never abort the playback stream.
		// The indexer is fed separately in Write() with exactly the bytes that
		// reached the client.
		dst:       io.MultiWriter(dst, cache),
		cache:     cache,
		tmp:       tmp,
		assetID:   assetID,
		maxHeight: maxHeight,
		idx:       newMVDecIndexer(),
	}
}

type decCacheWriter struct {
	dst       io.Writer
	cache     *softWriter // nil when not caching
	tmp       *os.File
	assetID   string
	maxHeight int
	idx       *mvDecIndexer // fragment index built inline during write (best-effort)
}

func (w *decCacheWriter) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	// Feed the indexer exactly the bytes that landed in the cache, so its offsets
	// match the cached stream even on a short write.
	if n > 0 {
		w.idx.feed(p[:n])
	}
	return n, err
}

// Commit finalises the cached encrypted file. Call after a successful stream.
func (w *decCacheWriter) Commit() {
	if w.tmp == nil {
		return
	}
	if w.cache != nil && w.cache.err != nil {
		log.Printf("[mv-dec] cache write failed (%v) — not caching %s", w.cache.err, w.assetID)
		w.Abort()
		return
	}
	size, _ := w.tmp.Seek(0, io.SeekCurrent)
	w.tmp.Close()
	final := mvDecFilePath(w.assetID, w.maxHeight)
	if err := os.Rename(w.tmp.Name(), final); err != nil {
		log.Printf("[mv-dec] rename: %v", err)
		os.Remove(w.tmp.Name())
	} else {
		mvDecTotalSz.Add(size)
		// Persist the fragment index alongside the committed cache (best-effort;
		// writes nothing if indexing was disabled, leaving seeks on the FFmpeg path).
		w.idx.finish(final)
		nFrags := 0
		if w.idx != nil {
			nFrags = len(w.idx.frags)
		}
		log.Printf("[mv-dec] cached %s@%dp (%.1f MB encrypted, %d fragments indexed)", w.assetID, w.maxHeight, float64(size)/(1<<20), nFrags)
	}
	fltKey := mvDecInFltKey(w.assetID, w.maxHeight)
	mvDecMu.Lock()
	delete(mvDecInFlt, fltKey)
	mvDecMu.Unlock()
}

// Abort discards the incomplete cache file. Call if streaming failed.
func (w *decCacheWriter) Abort() {
	if w.tmp == nil {
		return
	}
	w.tmp.Close()
	os.Remove(w.tmp.Name())
	fltKey := mvDecInFltKey(w.assetID, w.maxHeight)
	mvDecMu.Lock()
	delete(mvDecInFlt, fltKey)
	mvDecMu.Unlock()
}

// ClearMVDecCache deletes all cached encrypted track files.
// Uses an atomic rename so in-progress writers keep writing to the old directory
// rather than hitting ENOENT after RemoveAll.
func ClearMVDecCache() error {
	mvDecMu.Lock()
	defer mvDecMu.Unlock()

	// Rename the old directory aside so in-flight writers (which have open file
	// handles) continue to succeed; their files will be cleaned up below.
	dir := mvDecDirPath()
	old := dir + ".clearing"
	_ = os.RemoveAll(old) // remove any stale .clearing dir from a previous crash
	if err := os.Rename(dir, old); err != nil && !os.IsNotExist(err) {
		return err
	}
	mvDecTotalSz.Store(0)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Remove the old directory in the background so the caller isn't blocked by
	// disk I/O proportional to how much was cached.
	go os.RemoveAll(old)
	return nil
}

// softWriter forwards writes until the first error, then records it and
// swallows all further writes (reporting success), so an io.MultiWriter
// pairing it with the client connection keeps serving the client.
type softWriter struct {
	w   io.Writer
	err error
}

func (s *softWriter) Write(p []byte) (int, error) {
	if s.err == nil {
		if _, err := s.w.Write(p); err != nil {
			s.err = err
		}
	}
	return len(p), nil
}
