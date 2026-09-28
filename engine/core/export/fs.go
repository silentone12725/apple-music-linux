package export

import (
	"os"
	"os/user"
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

// ensureDir creates dir and all parents.
func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}
