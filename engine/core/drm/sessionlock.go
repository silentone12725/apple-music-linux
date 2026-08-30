package drm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// SessionLock is an exclusive advisory lock over the shared session/credential
// directory (mpl_db + derived token files). The engine holds it for its whole
// lifetime so that no two engine instances — and no two backends — can ever own
// the single-user Apple session concurrently. This guards against SQLite races,
// concurrent token refreshes, and wrapper session corruption.
//
// It is an flock(2) on a dedicated lockfile (not on the SQLite db itself), held
// by the engine process. The wrapper subprocess still opens mpl_db as before;
// the lock only prevents a second engine from also managing the same session.
//
// Linux/Unix (flock); the engine is Linux-only (see engine/drm/embedded.go).
type SessionLock struct {
	f    *os.File
	path string
}

// AcquireSessionLock takes an exclusive, non-blocking lock on dir. A nil dir
// (no session directory configured) is a no-op returning (nil, nil). If another
// process already holds the lock, it returns an error without blocking.
func AcquireSessionLock(dir string) (*SessionLock, error) {
	if dir == "" {
		return nil, nil // no session dir → nothing to guard
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("session lock: mkdir %s: %w", dir, err)
	}
	path := filepath.Join(dir, "engine-session.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("session lock: open %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Try to read the owner PID written by the holding process so the error
		// message identifies it without requiring external tools.
		ownerSuffix := ""
		if data, rerr := os.ReadFile(path); rerr == nil {
			if pid := strings.TrimSpace(string(data)); pid != "" {
				ownerSuffix = " (held by pid " + pid + ")"
			}
		}
		f.Close()
		return nil, fmt.Errorf("session already owned by another engine instance%s (%s): %w", ownerSuffix, path, err)
	}
	// Record this engine's PID in the lock file. A concurrent AcquireSessionLock
	// failure will read it to produce a more informative error message.
	_ = f.Truncate(0)
	fmt.Fprintf(f, "%d\n", os.Getpid())
	return &SessionLock{f: f, path: path}, nil
}

// Release unlocks and closes the lockfile. Safe to call on a nil lock.
func (l *SessionLock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}
