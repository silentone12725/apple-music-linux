package drm

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// snapshotDir reads every file under dir (name -> content), so a shutdown can be shown to have changed nothing.
func snapshotDir(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error { //nolint:errcheck
		if err == nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(dir, p)
			out[rel] = b
		}
		return nil
	})
	return out
}

// A signed-in profile must come through a normal shutdown untouched (the next start reuses it), with no
// partial files left and the session lock free again.
func TestShutdownWhileSignedInKeepsTheSessionAndFreesTheLock(t *testing.T) {
	dir := t.TempDir()
	writeSignedIn(t, dir, "device-1")
	lock, err := AcquireSessionLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	b := newFake()
	m := newTestManager(t, dir, b)
	if err := m.backend.Start(context.Background(), BackendConfig{}); err != nil {
		t.Fatal(err)
	}
	before := snapshotDir(t, dir)
	delete(before, "engine-session.lock") // the lock file holds the owner's pid, which legitimately changes

	m.Shutdown()
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}

	after := snapshotDir(t, dir)
	for name, want := range before {
		if got, ok := after[name]; !ok || !bytes.Equal(got, want) {
			t.Errorf("%s changed or vanished across shutdown", name)
		}
	}
	for name := range after {
		if filepath.Ext(name) == ".tmp" || filepath.Ext(name) == ".part" {
			t.Errorf("partial file left behind: %s", name)
		}
	}
	if !NewSessionManager(dir).HasSession() {
		t.Error("the signed-in session must still be there for the next start")
	}
	next, err := AcquireSessionLock(dir)
	if err != nil {
		t.Fatalf("the next start could not take the session lock: %v", err)
	}
	next.Release() //nolint:errcheck
	if b.Running() {
		t.Error("the backend was left running")
	}
}

// A hard kill never releases anything by itself: the operating system drops the lock with the process, and
// the profile on disk is exactly as it was, so the next start proceeds without any repair.
func TestHardKilledOwnerLeavesTheSessionUsable(t *testing.T) {
	if os.Getenv("ADAM_TEST_LOCK_HOLDER") != "" {
		dir := os.Getenv("ADAM_TEST_LOCK_HOLDER")
		if _, err := AcquireSessionLock(dir); err != nil {
			os.Exit(3)
		}
		os.Stdout.WriteString("held\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	dir := t.TempDir()
	writeSignedIn(t, dir, "device-2")
	before := snapshotDir(t, dir)

	self, err := os.Executable() // absolute: a relative argv[0] is refused on Windows
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, "-test.run", "^TestHardKilledOwnerLeavesTheSessionUsable$")
	cmd.Env = append(os.Environ(), "ADAM_TEST_LOCK_HOLDER="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := out.Read(buf); err != nil || string(buf) != "held\n" {
		t.Fatalf("the holder did not take the lock: %q %v", buf, err)
	}
	if l, err := AcquireSessionLock(dir); err == nil {
		l.Release() //nolint:errcheck
		t.Fatal("the lock must be held by the other process")
	}
	cmd.Process.Kill() //nolint:errcheck
	cmd.Wait()         //nolint:errcheck

	var l *SessionLock
	for i := 0; i < 50; i++ { // the OS releases the lock as the process goes away
		if l, err = AcquireSessionLock(dir); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("a killed owner still holds the lock: %v", err)
	}
	l.Release() //nolint:errcheck
	after := snapshotDir(t, dir)
	delete(after, "engine-session.lock")
	delete(before, "engine-session.lock")
	for name, want := range before {
		if !bytes.Equal(after[name], want) {
			t.Errorf("%s changed after the owner was killed", name)
		}
	}
	if !NewSessionManager(dir).HasSession() {
		t.Error("the signed-in session must survive a hard kill")
	}
}
