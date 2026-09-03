package prefetch

import (
	"testing"
	"time"

	"engine/internal/ring"
)

// ── Jobs map pruning ──────────────────────────────────────────────────────────

func TestCheckJobDone_PrunesCompletedJob(t *testing.T) {
	job := &WarmJob{
		ID:        "test-job-1",
		Total:     1,
		CreatedAt: time.Now(),
		cancel:    func() {},
	}
	job.mu.Lock()
	job.Cached = 1
	job.mu.Unlock()

	s := &Scheduler{
		jobs:       map[string]*WarmJob{"test-job-1": job},
		dedup:      make(map[string]bool),
		preWarmed:  make(map[string]preWarmedEntry),
		wq:         newWorkQueue(),
		latencies:  ring.New(10),
		queueWaits: ring.New(10),
	}

	s.checkJobDone(job)

	s.mu.RLock()
	_, stillPresent := s.jobs[job.ID]
	s.mu.RUnlock()

	if stillPresent {
		t.Fatal("checkJobDone should prune a completed job from s.jobs")
	}
}

func TestCheckJobDone_DoesNotPruneIncompleteJob(t *testing.T) {
	job := &WarmJob{
		ID:        "test-job-2",
		Total:     2,
		CreatedAt: time.Now(),
		cancel:    func() {},
	}
	// Only 1 of 2 done — still in-flight.
	job.mu.Lock()
	job.Cached = 1
	job.mu.Unlock()

	s := &Scheduler{
		jobs:       map[string]*WarmJob{"test-job-2": job},
		dedup:      make(map[string]bool),
		preWarmed:  make(map[string]preWarmedEntry),
		wq:         newWorkQueue(),
		latencies:  ring.New(10),
		queueWaits: ring.New(10),
	}

	s.checkJobDone(job)

	s.mu.RLock()
	_, stillPresent := s.jobs[job.ID]
	s.mu.RUnlock()

	if !stillPresent {
		t.Fatal("checkJobDone must NOT prune an incomplete job")
	}
}

// ── TakePreWarmed ─────────────────────────────────────────────────────────────

func TestTakePreWarmed_ExpiredReturnsNotFound(t *testing.T) {
	s := &Scheduler{
		token:      func() string { return "" },
		mut:        func() string { return "" },
		preWarmed:  map[string]preWarmedEntry{},
		wq:         newWorkQueue(),
		latencies:  ring.New(10),
		queueWaits: ring.New(10),
	}
	s.preWarmed["asset1"] = preWarmedEntry{
		sessionID: "sess-1",
		expiresAt: time.Now().Add(-time.Hour), // already expired
	}

	id, ok := s.TakePreWarmed("asset1")
	if ok {
		t.Errorf("expected ok=false for expired entry, got sessionID=%q", id)
	}
	if id != "" {
		t.Errorf("expected empty sessionID for expired entry, got %q", id)
	}
}

func TestTakePreWarmed_ValidReturnsSession(t *testing.T) {
	s := &Scheduler{
		preWarmed:  map[string]preWarmedEntry{},
		wq:         newWorkQueue(),
		latencies:  ring.New(10),
		queueWaits: ring.New(10),
	}
	s.preWarmed["asset2"] = preWarmedEntry{
		sessionID: "sess-2",
		expiresAt: time.Now().Add(time.Hour),
	}

	id, ok := s.TakePreWarmed("asset2")
	if !ok {
		t.Fatal("expected ok=true for valid entry")
	}
	if id != "sess-2" {
		t.Errorf("expected sessionID %q, got %q", "sess-2", id)
	}
	// Must be consumed on first successful take.
	_, ok2 := s.TakePreWarmed("asset2")
	if ok2 {
		t.Error("TakePreWarmed must consume the entry — second call must return ok=false")
	}
}

func TestTakePreWarmed_MissingReturnsNotFound(t *testing.T) {
	s := &Scheduler{
		preWarmed:  map[string]preWarmedEntry{},
		wq:         newWorkQueue(),
		latencies:  ring.New(10),
		queueWaits: ring.New(10),
	}
	_, ok := s.TakePreWarmed("nonexistent")
	if ok {
		t.Error("TakePreWarmed must return ok=false for missing asset")
	}
}
