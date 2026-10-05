package export

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
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

// resolveExisting makes p absolute and resolves symlinks in its longest existing
// prefix, leaving the not-yet-created remainder as is — so a path is judged by where it
// will really land, not by what it is spelled like.
func resolveExisting(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rest := ""
	for cur := abs; ; {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(real, rest), nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return abs, nil
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// pathWithin reports whether p is root or lies beneath it (path-element boundary).
func pathWithin(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// checkOutputDir enforces Options.OutputRoots.
func (m *Manager) checkOutputDir(dir string) error {
	if !m.confined {
		return nil
	}
	real, err := resolveExisting(dir)
	if err != nil {
		return fmt.Errorf("outputDir: %w", err)
	}
	for _, root := range m.roots {
		if pathWithin(real, root) {
			return nil
		}
	}
	return fmt.Errorf("outputDir must be inside one of the allowed export directories")
}
