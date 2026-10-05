package prefetch

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"engine/core/media"
	"engine/core/playback"
)

// blockingProvider holds every Open until its context ends, like a stalled upstream.
type blockingProvider struct {
	opens   atomic.Int32
	current atomic.Int32
	peak    atomic.Int32
	started chan struct{}
}

func (p *blockingProvider) Open(ctx context.Context, _ media.OpenRequest) (*media.Session, error) {
	p.opens.Add(1)
	n := p.current.Add(1)
	for {
		old := p.peak.Load()
		if n <= old || p.peak.CompareAndSwap(old, n) {
			break
		}
	}
	defer p.current.Add(-1)
	select {
	case p.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func newBlockingScheduler(workers int) (*Scheduler, *blockingProvider) {
	prov := &blockingProvider{started: make(chan struct{}, 64)}
	pm := playback.NewWithProvider(prov)
	return NewScheduler(pm, func() string { return "t" }, func() string { return "m" }, nil, workers), prov
}

// Stop must end running jobs (their sessions are opened under the scheduler's context)
// and the workers themselves, and be safe to repeat.
func TestStopCancelsRunningJobsAndWorkers(t *testing.T) {
	s, prov := newBlockingScheduler(2)

	var p ContextPayload
	p.Context.Reason = "album-open"
	p.Tracks = []TrackItem{{AssetID: "A", Storefront: "us"}, {AssetID: "B", Storefront: "us"}}
	s.Submit(p)
	select {
	case <-prov.started:
	case <-time.After(3 * time.Second):
		t.Fatal("no job reached the provider")
	}

	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return: a job ignored cancellation")
	}
	if n := prov.current.Load(); n != 0 {
		t.Fatalf("%d provider calls still running after Stop", n)
	}
	s.Stop() // idempotent
}

func TestWorkQueueCloseWakesBlockedPop(t *testing.T) {
	q := newWorkQueue()
	got := make(chan bool, 1)
	go func() { _, ok := q.pop(); got <- ok }()
	time.Sleep(20 * time.Millisecond)
	q.close()
	select {
	case ok := <-got:
		if ok {
			t.Fatal("pop on a closed empty queue reported an item")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not wake the blocked pop")
	}
}

// A burst of expired or mismatched claims must not turn into a burst of re-opens, and a
// stalled upstream must not pin a re-warm forever.
func TestRewarmIsBoundedAndCancellable(t *testing.T) {
	s, prov := newBlockingScheduler(1)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.rewarm(preWarmedEntry{req: playback.OpenRequest{AssetID: "X", Storefront: "us"}})
		}()
	}
	time.Sleep(200 * time.Millisecond)
	if peak := prov.peak.Load(); peak > maxConcurrentRewarms {
		t.Fatalf("%d re-warms ran at once, cap is %d", peak, maxConcurrentRewarms)
	}

	stopped := make(chan struct{})
	go func() { s.Stop(); wg.Wait(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop left re-warm goroutines blocked on a stalled provider")
	}
}
