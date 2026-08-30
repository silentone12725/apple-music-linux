package export

import (
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
)

// fileExists reports whether path exists (not a dir).
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// userHomeDir returns the current user's home directory.
func userHomeDir() (string, error) {
	if home, err := os.UserHomeDir(); err == nil {
		return home, nil
	}
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	return u.HomeDir, nil
}

// atomicWrite writes data to a temp file in the same directory as dst, then
// renames it to dst.  This ensures dst is never left in a partially-written
// state if the process is interrupted.
func atomicWrite(dst string, src io.Reader) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, fmt.Errorf("mkdir: %w", err)
	}
	f, err := os.CreateTemp(filepath.Dir(dst), ".export-*.tmp")
	if err != nil {
		return 0, fmt.Errorf("create temp: %w", err)
	}
	tmp := f.Name()

	n, copyErr := io.Copy(f, src)
	closeErr := f.Close()

	if copyErr != nil {
		os.Remove(tmp) //nolint:errcheck
		return n, fmt.Errorf("write: %w", copyErr)
	}
	if closeErr != nil {
		os.Remove(tmp) //nolint:errcheck
		return n, fmt.Errorf("close: %w", closeErr)
	}

	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return n, fmt.Errorf("rename: %w", err)
	}
	return n, nil
}

// ensureDir creates dir and all parents.
func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}
