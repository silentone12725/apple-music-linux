package appdir

import (
	"fmt"
	"os"
	"path/filepath"
)

// PrivateTemp returns a directory under the system temp directory that only this user can use,
// for the rare files that have no per-user home to live in. The shared temp directory is
// writable by everyone, so a predictable name there can be pre-created, or pointed elsewhere
// with a symlink, by another user; the directory is therefore used only if it is a real
// directory owned by this user with no group or other access, and a fresh random one is made
// otherwise.
func PrivateTemp() (string, error) {
	dir := filepath.Join(os.TempDir(), fmt.Sprintf("adam-%d", os.Getuid()))
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return "", err
	}
	if privateDir(dir) {
		return dir, nil
	}
	return os.MkdirTemp("", "adam-")
}

func privateDir(dir string) bool {
	fi, err := os.Lstat(dir) // Lstat: a symlink is not a directory we made
	return err == nil && fi.IsDir() && fi.Mode().Perm()&0o077 == 0 && ownedByUser(fi)
}
