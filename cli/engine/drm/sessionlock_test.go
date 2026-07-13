package drm

import "testing"

func TestSessionLock_Exclusive(t *testing.T) {
	dir := t.TempDir()

	l1, err := AcquireSessionLock(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if l1 == nil {
		t.Fatal("expected a lock")
	}

	// A second acquisition on the same directory must fail while the first is held.
	if l2, err := AcquireSessionLock(dir); err == nil {
		l2.Release()
		t.Fatal("second acquire should fail while the first lock is held")
	}

	// After release, the lock is available again.
	if err := l1.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	l3, err := AcquireSessionLock(dir)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	l3.Release()
}

func TestSessionLock_EmptyDirIsNoop(t *testing.T) {
	l, err := AcquireSessionLock("")
	if err != nil {
		t.Fatalf("empty dir should be a no-op, got: %v", err)
	}
	if l != nil {
		t.Fatal("empty dir should return a nil lock")
	}
	// Release on nil must be safe.
	if err := l.Release(); err != nil {
		t.Fatalf("release on nil lock: %v", err)
	}
}
