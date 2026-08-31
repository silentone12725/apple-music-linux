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
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	mvDecDirName  = "engine/mv-dec"
	mvDecKeyFile  = "aml/mv-dec.key" // relative to os.UserConfigDir(); mode 0600
	mvDecIVSize   = 16
)

var (
	mvDecDir     string
	mvDecTotalSz atomic.Int64

	mvDecKeyOnce sync.Once
	mvDecKey     []byte // 32 bytes, loaded/generated at first use

	mvDecMu    sync.RWMutex
	mvDecInFlt = map[string]struct{}{} // assetIDs currently being written
)

func init() {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	mvDecDir = filepath.Join(base, mvDecDirName)
	os.MkdirAll(mvDecDir, 0700)

	// Account for existing cached files. The directory holds at most ~10-20 large
	// files (bounded by the 2 GB segment cache limit), so the walk is fast enough
	// to do synchronously — avoiding a race with ClearMVDecCache's Store(0).
	var total int64
	filepath.Walk(mvDecDir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(info.Name(), ".enc") {
			total += info.Size()
		}
		return nil
	})
	mvDecTotalSz.Store(total)
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

		if raw, err := os.ReadFile(keyPath); err == nil && len(raw) == 32 {
			mvDecKey = raw
			log.Printf("[mv-dec] key loaded from %s", keyPath)
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
		if err := os.WriteFile(keyPath, key, 0600); err != nil {
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

func mvDecFilePath(assetID string) string {
	safe := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-' {
			return r
		}
		return '_'
	}, assetID)
	return filepath.Join(mvDecDir, safe+".enc")
}

// MVDecExists reports whether a complete encrypted track file exists for assetID.
func MVDecExists(assetID string) bool {
	if !MVCacheEnabled() || assetID == "" {
		return false
	}
	mvDecMu.RLock()
	_, inflight := mvDecInFlt[assetID]
	mvDecMu.RUnlock()
	if inflight {
		return false
	}
	info, err := os.Stat(mvDecFilePath(assetID))
	return err == nil && info.Size() > mvDecIVSize
}

// MVDecTotalBytes returns the total on-disk size of all cached encrypted track files.
func MVDecTotalBytes() int64 { return mvDecTotalSz.Load() }

// ServeMVDec decrypts and copies the cached track for assetID into dst.
func ServeMVDec(assetID string, dst io.Writer) error {
	initMVDecKey()
	f, err := os.Open(mvDecFilePath(assetID))
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
// Call Commit() on success or Abort() on error.
func MVDecCacheWriter(assetID string, dst io.Writer) *decCacheWriter {
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

	tmp, err := os.CreateTemp(mvDecDir, ".dec-*.enc.tmp")
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

	// Guard against two simultaneous first-plays of the same track: only the
	// first caller caches; the second streams directly to dst without caching.
	mvDecMu.Lock()
	_, alreadyInFlt := mvDecInFlt[assetID]
	if !alreadyInFlt {
		mvDecInFlt[assetID] = struct{}{}
	}
	mvDecMu.Unlock()
	if alreadyInFlt {
		tmp.Close()
		os.Remove(tmp.Name())
		return &decCacheWriter{dst: dst}
	}

	encWriter := &cipher.StreamWriter{S: stream, W: tmp}
	return &decCacheWriter{
		dst:     io.MultiWriter(dst, encWriter), // plaintext → HTTP + encrypt → file
		tmp:     tmp,
		assetID: assetID,
	}
}

type decCacheWriter struct {
	dst     io.Writer
	tmp     *os.File
	assetID string
}

func (w *decCacheWriter) Write(p []byte) (int, error) { return w.dst.Write(p) }

// Commit finalises the cached encrypted file. Call after a successful stream.
func (w *decCacheWriter) Commit() {
	if w.tmp == nil {
		return
	}
	size, _ := w.tmp.Seek(0, io.SeekCurrent)
	w.tmp.Close()
	final := mvDecFilePath(w.assetID)
	if err := os.Rename(w.tmp.Name(), final); err != nil {
		log.Printf("[mv-dec] rename: %v", err)
		os.Remove(w.tmp.Name())
	} else {
		mvDecTotalSz.Add(size)
		log.Printf("[mv-dec] cached %s (%.1f MB encrypted)", w.assetID, float64(size)/(1<<20))
	}
	mvDecMu.Lock()
	delete(mvDecInFlt, w.assetID)
	mvDecMu.Unlock()
}

// Abort discards the incomplete cache file. Call if streaming failed.
func (w *decCacheWriter) Abort() {
	if w.tmp == nil {
		return
	}
	w.tmp.Close()
	os.Remove(w.tmp.Name())
	mvDecMu.Lock()
	delete(mvDecInFlt, w.assetID)
	mvDecMu.Unlock()
}

// ClearMVDecCache deletes all cached encrypted track files.
func ClearMVDecCache() error {
	mvDecMu.Lock()
	defer mvDecMu.Unlock()
	if err := os.RemoveAll(mvDecDir); err != nil {
		return err
	}
	mvDecTotalSz.Store(0)
	return os.MkdirAll(mvDecDir, 0700)
}
