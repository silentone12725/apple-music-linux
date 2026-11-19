//go:build windows

package appdir

import "os"

// The per-user temp directory on Windows is already private to the user.
func ownedByUser(os.FileInfo) bool { return true }
