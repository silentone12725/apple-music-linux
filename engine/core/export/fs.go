package export

import (
	"errors"
	"fmt"
	"io/fs"
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
	roots := m.roots
	if m.more != nil {
		for _, r := range m.more() {
			if rr, err := resolveExisting(r); err == nil {
				roots = append(roots[:len(roots):len(roots)], rr)
			}
		}
	}
	for _, root := range roots {
		if pathWithin(real, root) {
			return nil
		}
	}
	return fmt.Errorf("outputDir must be inside one of the allowed export directories")
}

// moveFile renames src over dst, falling back to an atomic copy across devices.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	os.Remove(src) //nolint:errcheck
	return nil
}

// maxRenameAttempts bounds the "name (N).ext" search; a variable so a test can lower it.
var maxRenameAttempts = 10000

// moveNoClobber moves tmp to final honouring policy without a check-then-act gap:
// "overwrite" replaces; "rename" takes the first free "name (N).ext"; anything
// else (skip) keeps the existing file. The claim on the name is a hard link,
// which fails atomically when the name is taken. Filesystems without hard links
// fall back to moveNoReplace, which is just as atomic (renameat2 NOREPLACE, or an
// O_EXCL claim plus copy). Returns the path the content ended up at (the existing file's
// path when skipped).
func moveNoClobber(tmp, final, policy string) (string, error) {
	if policy == "overwrite" {
		return final, moveFile(tmp, final)
	}
	ext := filepath.Ext(final)
	base := strings.TrimSuffix(final, ext)
	for i := 0; i < maxRenameAttempts; i++ {
		dest := final
		if i > 0 {
			dest = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		err := os.Link(tmp, dest)
		if err == nil {
			os.Remove(tmp) //nolint:errcheck
			return dest, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			// No hard links here (or another device): a move that atomically refuses an
			// existing name, so a file created meanwhile is never replaced.
			err = moveNoReplace(tmp, dest)
			if err == nil {
				return dest, nil
			}
			if !errors.Is(err, fs.ErrExist) {
				return dest, err
			}
		}
		if policy != "rename" { // skip: keep what is there
			os.Remove(tmp) //nolint:errcheck
			return final, nil
		}
	}
	os.Remove(tmp) //nolint:errcheck
	return "", fmt.Errorf("no free name for %s after %d attempts", filepath.Base(final), maxRenameAttempts)
}

// normalizeOutputDir makes an export directory absolute. A relative value would resolve against the
// engine's working directory, and one starting with "-" would reach ffmpeg as an option, not a path.
func normalizeOutputDir(dir string) (string, error) {
	if strings.ContainsRune(dir, 0) {
		return "", fmt.Errorf("outputDir: invalid path")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("outputDir: %w", err)
	}
	return abs, nil
}
