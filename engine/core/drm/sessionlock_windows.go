//go:build windows

package drm

import "os"

// SessionLock is a no-op on Windows; flock(2) is Linux-only.
// The engine is not expected to run multiple concurrent instances on Windows.
type SessionLock struct {
	f    *os.File
	path string
}

func AcquireSessionLock(dir string) (*SessionLock, error) { return nil, nil }
func (l *SessionLock) Release() error                     { return nil }
