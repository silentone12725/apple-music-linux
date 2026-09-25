package export

import (
	"errors"
	"sync"
	"testing"
	"time"

	"engine/internal/pq"
)

// queueHarness runs a Manager whose worker hands popped items to the test
// instead of executing them, so ordering and races are deterministic.
type queueHarness struct {
	m       *Manager
	popped  chan *workItem
	proceed chan struct{}
	mu      sync.Mutex
	order   []string
}

func newQueueHarness(t *testing.T) *queueHarness {
	t.Helper()
	h := &queueHarness{popped: make(chan *workItem), proceed: make(chan struct{})}
	h.m = &Manager{
		jobs:     make(map[string]*ExportJob),
		requests: make(map[string]ExportRequest),
		queue:    pq.New[*workItem](),
		bw:       newBWController(nil, 0),
	}
	h.m.run = func(item *workItem) {
		h.popped <- item
		<-h.proceed
		h.mu.Lock()
		h.order = append(h.order, item.req.AssetID)
		h.mu.Unlock()
		h.m.advance(item.job, PhaseDone, 100)
	}
	go h.m.worker()
	t.Cleanup(h.m.queue.Close)
	return h
}

func (h *queueHarness) enqueue(t *testing.T, asset string, prio int) *ExportJob {
	t.Helper()
	j, err := h.m.Enqueue(ExportRequest{AssetID: asset, OutputDir: t.TempDir(), Priority: prio})
	if err != nil {
		t.Fatal(err)
	}
	return j
}

// next waits for the worker to pop an item and returns it (still unreleased).
func (h *queueHarness) next(t *testing.T) *workItem {
	t.Helper()
	select {
	case it := <-h.popped:
		return it
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not pop")
		return nil
	}
}

func TestQueue_PriorityOrderFIFOTies(t *testing.T) {
	h := newQueueHarness(t)
	h.enqueue(t, "x", 0)
	first := h.next(t) // worker busy with x; the rest queue up
	h.enqueue(t, "a", 0)
	h.enqueue(t, "b", 5)
	h.enqueue(t, "c", 5)
	h.enqueue(t, "d", 10)

	var got []string
	got = append(got, first.req.AssetID)
	h.proceed <- struct{}{}
	for i := 0; i < 4; i++ {
		got = append(got, h.next(t).req.AssetID)
		h.proceed <- struct{}{}
	}
	want := []string{"x", "d", "b", "c", "a"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order %v, want %v", got, want)
		}
	}
}

func TestQueue_QueueIndexAndPrioritize(t *testing.T) {
	h := newQueueHarness(t)
	running := h.enqueue(t, "run", 0)
	h.next(t)
	a := h.enqueue(t, "a", 0)
	b := h.enqueue(t, "b", 0)

	idx := func(id string) int { j, _ := h.m.Get(id); return j.QueueIndex }
	if idx(a.ID) != 1 || idx(b.ID) != 2 || idx(running.ID) != 0 {
		t.Fatalf("indexes a=%d b=%d running=%d, want 1/2/0", idx(a.ID), idx(b.ID), idx(running.ID))
	}

	snap, err := h.m.Prioritize(b.ID, 7)
	if err != nil {
		t.Fatalf("Prioritize queued: %v", err)
	}
	if snap.Priority != 7 || snap.QueueIndex != 1 {
		t.Fatalf("snapshot priority=%d index=%d, want 7/1", snap.Priority, snap.QueueIndex)
	}
	if idx(a.ID) != 2 {
		t.Fatalf("a index %d after b moved ahead, want 2", idx(a.ID))
	}

	if _, err := h.m.Prioritize(running.ID, 9); !errors.Is(err, ErrNotQueued) {
		t.Fatalf("Prioritize running: err=%v, want ErrNotQueued", err)
	}
	if _, err := h.m.Prioritize("nope", 1); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("Prioritize unknown: err=%v, want ErrJobNotFound", err)
	}
	h.proceed <- struct{}{}
	if got := h.next(t).req.AssetID; got != "b" {
		t.Fatalf("next popped %q, want b", got)
	}
	h.proceed <- struct{}{}
}

func TestQueue_CancelQueuedRemovesImmediately(t *testing.T) {
	h := newQueueHarness(t)
	h.enqueue(t, "run", 0)
	h.next(t)
	a := h.enqueue(t, "a", 0)
	b := h.enqueue(t, "b", 0)

	if !h.m.Cancel(a.ID) {
		t.Fatal("Cancel returned false")
	}
	if n := h.m.queue.Len(); n != 1 {
		t.Fatalf("queue len %d after cancel, want 1", n)
	}
	j, _ := h.m.Get(a.ID)
	if j.Phase != PhaseCancelled || j.QueueIndex != 0 {
		t.Fatalf("cancelled job phase=%s index=%d", j.Phase, j.QueueIndex)
	}
	if jb, _ := h.m.Get(b.ID); jb.QueueIndex != 1 {
		t.Fatalf("b index %d, want 1", jb.QueueIndex)
	}
	h.proceed <- struct{}{}
	if got := h.next(t).req.AssetID; got != "b" {
		t.Fatalf("cancelled job ran or order wrong: popped %q", got)
	}
	h.proceed <- struct{}{}
}

// Cancel after the worker popped the job but before it executes: the queue no
// longer holds it, so it is treated as running — its context is cancelled and
// the real execute path ends it cancelled without doing any work.
func TestQueue_CancelBetweenPopAndExecute(t *testing.T) {
	h := newQueueHarness(t)
	h.m.run = func(item *workItem) {
		h.popped <- item
		<-h.proceed
		h.m.execute(item) // real path: must bail on the cancelled context
	}
	j := h.enqueue(t, "a", 0)
	h.next(t) // popped, not yet executing

	if _, stillQueued := h.m.queue.Remove(j.ID); stillQueued {
		t.Fatal("popped job still in the queue")
	}
	if !h.m.Cancel(j.ID) {
		t.Fatal("Cancel returned false")
	}
	if got, _ := h.m.Get(j.ID); got.Phase != PhaseQueued {
		t.Fatalf("running job was marked %s as if queued", got.Phase)
	}
	h.proceed <- struct{}{}

	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := h.m.Get(j.ID)
		if !ok {
			t.Fatal("job vanished")
		}
		if got.Phase == PhaseCancelled {
			break
		}
		if got.Phase == PhaseFailed || time.Now().After(deadline) {
			t.Fatalf("job ended %s (%s), want cancelled", got.Phase, got.Error)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestQueue_RetryKeepsPriority(t *testing.T) {
	h := newQueueHarness(t)
	h.enqueue(t, "run", 0)
	h.next(t)
	a := h.enqueue(t, "a", 4)
	h.m.Cancel(a.ID)
	nj, ok := h.m.Retry(a.ID)
	if !ok {
		t.Fatal("Retry failed")
	}
	if nj.Priority != 4 {
		t.Fatalf("retried priority %d, want 4", nj.Priority)
	}
	h.proceed <- struct{}{}
	h.next(t)
	h.proceed <- struct{}{}
}
