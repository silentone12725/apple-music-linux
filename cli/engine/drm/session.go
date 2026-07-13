package drm

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const sessionValidityTTL = 4 * time.Hour

// SessionManager is the engine's authoritative source for DRM session state.
//
// Ownership: SessionManager owns everything related to persisted session state.
//
//	mpl_db/ directory and all SQLite databases inside it
//	STOREFRONT_ID file
//	MUSIC_TOKEN file
//	drm-state file (path only; written by wrapper, read by SessionManager)
//	delete (ClearSession removes all of the above)
//	behavioral validity tracking (last successful DRM op timestamp)
//
// SessionManager does NOT own:
//
//	live authenticated state — that's ProcessBackend
//	Apple credentials — that's AuthCoordinator
//	2fa.txt — that's ProcessBackend (it writes; credentialHandler reads)
//
// Nothing outside this type reads or deletes the files it owns.
// ProcessBackend writes drm-state; SessionManager provides the path.
//
// Session validity is behavioral, not purely filesystem-based. A session is
// considered Valid only when:
//  1. mpl_db/accounts.sqlitedb exists and is non-empty, AND
//  2. STOREFRONT_ID and MUSIC_TOKEN are present, AND
//  3. A successful DRM operation has been observed within sessionValidityTTL
//     OR a live GetAccount() call succeeds.
//
// This design prevents the engine from claiming a session is valid solely
// because the files exist from a past, now-expired login.
type SessionManager struct {
	BaseDir string

	mu          sync.Mutex
	lastSuccess time.Time
}

// NewSessionManager creates a SessionManager rooted at baseDir.
func NewSessionManager(baseDir string) *SessionManager {
	return &SessionManager{BaseDir: baseDir}
}

// HasSession returns true if mpl_db/accounts.sqlitedb exists and has
// content. This indicates a prior login occurred but does NOT guarantee
// the session is currently usable — use IsSessionValid for that.
func (s *SessionManager) HasSession() bool {
	path := filepath.Join(s.BaseDir, "mpl_db", "accounts.sqlitedb")
	info, err := os.Stat(path)
	return err == nil && info.Size() > 0
}

// RecordSuccess records the timestamp of a successful DRM operation.
// DRMManager calls this after every successful Decrypt, GetM3U8, or
// GetAccount response. This is the behavioral signal that keeps
// SessionState == SessionValid.
func (s *SessionManager) RecordSuccess() {
	s.mu.Lock()
	s.lastSuccess = time.Now()
	s.mu.Unlock()
}

// IsSessionValid returns (true, nil) when the session appears usable.
// It first checks filesystem prerequisites, then validates behaviorally:
//   - If a successful DRM operation was observed within sessionValidityTTL, returns true.
//   - Otherwise attempts a live GetAccount() call to confirm the session works.
//
// The drm parameter is the DRMProvider to use for the live check; pass nil
// to skip the live check and rely on the TTL only.
func (s *SessionManager) IsSessionValid(ctx context.Context, drm DRMProvider) (bool, error) {
	if !s.HasSession() {
		return false, nil
	}
	if s.ReadStorefrontID() == "" || s.ReadMusicToken() == "" {
		return false, nil
	}

	s.mu.Lock()
	last := s.lastSuccess
	s.mu.Unlock()

	if !last.IsZero() && time.Since(last) < sessionValidityTTL {
		return true, nil
	}

	// No recent success on record — try a live confirmation.
	if drm == nil {
		// Caller opted out of live check; treat as expired.
		return false, nil
	}
	_, err := drm.GetAccount(ctx)
	if err == nil {
		s.RecordSuccess()
		return true, nil
	}
	return false, nil
}

// SessionInfo returns the cached storefront ID and music token.
// Returns nil if either file is missing or empty.
func (s *SessionManager) SessionInfo() *SessionInfo {
	sf := s.ReadStorefrontID()
	mt := s.ReadMusicToken()
	if sf == "" || mt == "" {
		return nil
	}
	return &SessionInfo{StorefrontID: sf, MusicToken: mt}
}

// SessionInfo holds cached account identifiers.
type SessionInfo struct {
	StorefrontID string
	MusicToken   string
}

// ClearSession removes mpl_db/, STOREFRONT_ID, MUSIC_TOKEN, and drm-state.
// The backend process must be stopped before calling ClearSession to avoid
// storeservicescore writing the files back during deletion.
func (s *SessionManager) ClearSession() error {
	paths := []string{
		filepath.Join(s.BaseDir, "mpl_db"),
		filepath.Join(s.BaseDir, "STOREFRONT_ID"),
		filepath.Join(s.BaseDir, "MUSIC_TOKEN"),
		filepath.Join(s.BaseDir, "drm-state"),
	}
	var lastErr error
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil && !os.IsNotExist(err) {
			lastErr = err
		}
	}
	s.mu.Lock()
	s.lastSuccess = time.Time{}
	s.mu.Unlock()
	return lastErr
}

// StateFilePath returns the path of the drm-state file written by main.c.
func (s *SessionManager) StateFilePath() string {
	return filepath.Join(s.BaseDir, "drm-state")
}

// TwoFAFilePath returns the path of the 2fa.txt file used by the
// --code-from-file mechanism in the wrapper's credentialHandler.
func (s *SessionManager) TwoFAFilePath() string {
	return filepath.Join(s.BaseDir, "2fa.txt")
}

// ReadStorefrontID reads {BaseDir}/STOREFRONT_ID.
func (s *SessionManager) ReadStorefrontID() string {
	return readFile(filepath.Join(s.BaseDir, "STOREFRONT_ID"))
}

// NormalizeStorefrontID strips the platform/content-class suffix that the
// wrapper appends to the raw STOREFRONT_ID file. The wrapper writes values
// like "143467-2,31" (numeric ID + content-class suffix); the MusicKit
// catalog API expects only the bare numeric ID ("143467").
//
// The format observed at runtime is "<id>-<platform>,<class>". We split on
// the first "-" and discard everything after it. If the value contains no
// "-", it is returned unchanged (already normalized, or an ISO 2-letter code
// like "us" set via config.yaml).
func NormalizeStorefrontID(sf string) string {
	if i := strings.IndexByte(sf, '-'); i >= 0 {
		return sf[:i]
	}
	return sf
}

// ReadMusicToken reads the current MUSIC_TOKEN from disk.
//
// It intentionally performs a fresh read on every call. The wrapper may
// refresh the token during the engine's lifetime, so callers must not
// assume the value is immutable or cache it.
func (s *SessionManager) ReadMusicToken() string {
	return readFile(filepath.Join(s.BaseDir, "MUSIC_TOKEN"))
}

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}
