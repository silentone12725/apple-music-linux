// Package appdir resolves Adam's per-user config and cache directories and folds the
// directories earlier versions used (apple-music-linux, aml) into them on first use.
package appdir

import (
	"os"
	"path/filepath"
	"sync"
)

// Name is the directory name under the OS config and cache roots.
const Name = "adam"

var legacyNames = []string{"apple-music-linux", "aml"}

var (
	mu       sync.Mutex
	resolved = map[bool]string{} // key: cache?
)

// Config returns the per-user config directory (for example ~/.config/adam).
func Config() string { return resolve(false) }

// Cache returns the per-user cache directory (for example ~/.cache/adam).
func Cache() string { return resolve(true) }

func root(cache bool) string {
	var b string
	var err error
	if cache {
		b, err = os.UserCacheDir()
	} else {
		b, err = os.UserConfigDir()
	}
	if err == nil && b != "" {
		return b
	}
	home, herr := os.UserHomeDir()
	if herr != nil || home == "" {
		if dir, perr := PrivateTemp(); perr == nil {
			return dir
		}
		return filepath.Join(os.TempDir(), "adam-unavailable")
	}
	if cache {
		return filepath.Join(home, ".cache")
	}
	return filepath.Join(home, ".config")
}

func resolve(cache bool) string {
	mu.Lock()
	defer mu.Unlock()
	if d, ok := resolved[cache]; ok {
		return d
	}
	r := root(cache)
	dir := filepath.Join(r, Name)
	for _, old := range legacyNames {
		merge(filepath.Join(r, old), dir)
	}
	resolved[cache] = dir
	return dir
}

// merge moves everything in src into dst without overwriting: a whole-directory rename when
// dst does not exist, otherwise entry by entry (recursing into directories present in both).
// Files that exist on both sides keep the dst copy and the src copy stays where it is.
func merge(src, dst string) {
	fi, err := os.Lstat(src)
	if err != nil || !fi.IsDir() {
		return
	}
	if _, err := os.Lstat(dst); os.IsNotExist(err) {
		if os.MkdirAll(filepath.Dir(dst), 0o700) == nil && os.Rename(src, dst) == nil {
			return
		}
	}
	if os.MkdirAll(dst, 0o700) != nil {
		return
	}
	ents, err := os.ReadDir(src)
	if err != nil {
		return
	}
	for _, e := range ents {
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if _, err := os.Lstat(d); os.IsNotExist(err) {
			_ = os.Rename(s, d)
		} else if e.IsDir() {
			merge(s, d)
		}
	}
	_ = os.Remove(src) // succeeds only when nothing was left behind
}

// MoveInto renames oldPath to newPath when only the old one exists. For one-off relocations
// of paths that do not live under the legacy directory names.
func MoveInto(oldPath, newPath string) {
	if _, err := os.Lstat(newPath); err == nil {
		return
	}
	if _, err := os.Lstat(oldPath); err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(newPath), 0o700) == nil {
		_ = os.Rename(oldPath, newPath)
	}
}
