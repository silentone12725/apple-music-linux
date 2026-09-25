package export

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"

	"engine/internal/pq"
)

// ── controller harness ────────────────────────────────────────────────────────

type fakeFg struct {
	mu     sync.Mutex
	active int
	bytes  int64
	need   int64
}

func (f *fakeFg) stats() (int, int64, int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active, f.bytes, f.need
}

func (f *fakeFg) set(active int, need int64) {
	f.mu.Lock()
	f.active, f.need = active, need
	f.mu.Unlock()
}

func (f *fakeFg) add(n int64) { f.mu.Lock(); f.bytes += n; f.mu.Unlock() }

type ctlHarness struct {
	c       *bwController
	fg      *fakeFg
	now     time.Time
	applied []rate.Limit
}

func newHarness() *ctlHarness {
	h := &ctlHarness{fg: &fakeFg{}, now: time.Unix(1000, 0)}
	h.c = newBWController(h.fg.stats, 0)
	h.c.now = func() time.Time { return h.now }
	h.c.apply = func(l rate.Limit) { h.applied = append(h.applied, l) }
	return h
}

// step advances the clock by one tick after playback wrote fgBytesPerSec
// worth of bytes over that interval, then runs the controller.
func (h *ctlHarness) step(fgBytesPerSec float64) {
	h.fg.add(int64(fgBytesPerSec * throttleTick.Seconds()))
	h.now = h.now.Add(throttleTick)
	h.c.tick()
}

func (h *ctlHarness) limit(t *testing.T) float64 {
	t.Helper()
	l := h.c.currentLimit()
	if l == nil {
		return -1
	}
	return float64(*l)
}

const need = 200_000 // foregroundNeedBps used by most tests (bytes/s)

// ── controller tests ──────────────────────────────────────────────────────────

func TestController_UnlimitedWithoutPlayback(t *testing.T) {
	t.Parallel()
	h := newHarness()
	for i := 0; i < 3; i++ {
		h.step(0)
	}
	if h.c.currentLimit() != nil {
		t.Fatal("limit set with no playback")
	}
	if len(h.applied) != 0 {
		t.Fatalf("SetLimit called %d times while idle, want 0", len(h.applied))
	}
}

func TestController_StartThenAIMD(t *testing.T) {
	t.Parallel()
	h := newHarness()
	h.fg.set(1, need)

	// Playback appears → Starting at startBps, no evaluation this tick.
	h.step(0)
	if got := h.limit(t); got != defaultStartBps {
		t.Fatalf("start limit %v, want %v", got, defaultStartBps)
	}
	if h.c.state != throttleStarting {
		t.Fatalf("state %v, want Starting", h.c.state)
	}

	// Under pressure (fg < 3×need) → halve.
	h.step(1 * need)
	if got := h.limit(t); got != defaultStartBps/2 {
		t.Fatalf("after pressure %v, want %v", got, defaultStartBps/2)
	}
	if h.c.state != throttleAdaptive {
		t.Fatalf("state %v, want Adaptive", h.c.state)
	}

	// Headroom (fg > 4×need) → +step.
	h.step(5 * need)
	if got := h.limit(t); got != defaultStartBps/2+defaultStepBps {
		t.Fatalf("after headroom %v, want %v", got, defaultStartBps/2+defaultStepBps)
	}

	// Hysteresis band (3×–4×) → hold, and no redundant SetLimit.
	n := len(h.applied)
	h.step(3.5 * need)
	if got := h.limit(t); got != defaultStartBps/2+defaultStepBps {
		t.Fatalf("hold band changed limit to %v", got)
	}
	if len(h.applied) != n {
		t.Fatalf("SetLimit called in hold band")
	}

	// Playback stops → Inf.
	h.fg.set(0, 0)
	h.step(0)
	if h.c.currentLimit() != nil {
		t.Fatal("limit not cleared when playback stopped")
	}
	if last := h.applied[len(h.applied)-1]; last != rate.Inf {
		t.Fatalf("last applied %v, want Inf", last)
	}
}

func TestController_FloorClamp(t *testing.T) {
	t.Parallel()
	h := newHarness()
	h.fg.set(1, need)
	h.step(0)
	for i := 0; i < 20; i++ {
		h.step(0) // sustained pressure
		if got := h.limit(t); got < defaultFloorBps {
			t.Fatalf("limit %v fell below floor %v", got, defaultFloorBps)
		}
	}
	if got := h.limit(t); got != defaultFloorBps {
		t.Fatalf("limit %v, want floor %v", got, defaultFloorBps)
	}
	// Staying at the floor must not re-apply the same value every tick.
	n := len(h.applied)
	h.step(0)
	if len(h.applied) != n {
		t.Fatal("SetLimit re-applied an unchanged floor")
	}
}

// Playback active but idle for an interval (0 bytes) is no evidence of
// headroom: be conservative.
func TestController_ZeroByteIntervalDecreases(t *testing.T) {
	t.Parallel()
	h := newHarness()
	h.fg.set(1, need)
	h.step(0)
	before := h.limit(t)
	h.step(0)
	if got := h.limit(t); got != before/2 {
		t.Fatalf("zero-byte interval: %v, want %v", got, before/2)
	}
}

// Defensive: without a threshold the controller must never grow.
func TestController_NonPositiveNeedNeverIncreases(t *testing.T) {
	t.Parallel()
	for _, nb := range []int64{0, -5} {
		h := newHarness()
		h.fg.set(1, nb)
		h.step(0)
		prev := h.limit(t)
		for i := 0; i < 5; i++ {
			h.step(100 << 20) // enormous playback throughput
			got := h.limit(t)
			if got > prev {
				t.Fatalf("need=%d: limit grew %v → %v", nb, prev, got)
			}
			if got < defaultFloorBps {
				t.Fatalf("need=%d: limit %v below floor", nb, got)
			}
			prev = got
		}
	}
}

// Throughput is per interval: a fast burst before playback went idle must
// not count once playback returns.
func TestController_FreshBaselineAfterIdle(t *testing.T) {
	t.Parallel()
	h := newHarness()
	h.fg.set(1, need)
	h.step(0)
	h.step(50 * need) // big burst

	h.fg.set(0, 0)
	h.fg.add(100 << 20) // bytes written while "idle" must not leak into the next interval
	h.step(0)

	h.fg.set(1, need)
	h.step(0) // Starting: fresh baseline, no evaluation
	if got := h.limit(t); got != defaultStartBps {
		t.Fatalf("restart limit %v, want %v", got, defaultStartBps)
	}
	h.step(1 * need) // first complete interval shows pressure
	if got := h.limit(t); got != defaultStartBps/2 {
		t.Fatalf("first interval after idle: %v, want %v (stale bytes leaked into measurement)", got, defaultStartBps/2)
	}
}

func TestController_StartStopRace(t *testing.T) {
	t.Parallel()
	fg := &fakeFg{}
	fg.set(1, need)
	c := newBWController(fg.stats, 0)
	for i := 0; i < 50; i++ {
		c.start()
		fg.add(1000)
		c.start() // idempotent while running
		c.stop()
		if c.currentLimit() != nil {
			t.Fatal("limit survived stop")
		}
		if c.lim.Limit() != rate.Inf {
			t.Fatal("limiter not reset to Inf after stop")
		}
	}
	c.stop() // idempotent when stopped
}

func TestController_StartThrottlesImmediately(t *testing.T) {
	t.Parallel()
	fg := &fakeFg{}
	fg.set(1, need)
	c := newBWController(fg.stats, 0)
	c.start()
	defer c.stop()
	if c.lim.Limit() == rate.Inf {
		t.Fatal("export started during playback ran unthrottled until the first tick")
	}
}

func TestController_CustomFloor(t *testing.T) {
	t.Parallel()
	fg := &fakeFg{}
	fg.set(1, need)
	c := newBWController(fg.stats, 2<<20) // floor above default start rate
	c.tick()
	if l := c.currentLimit(); l == nil || *l < 2<<20 {
		t.Fatalf("start limit %v below configured floor", l)
	}
}

// ── throttledWriter tests ─────────────────────────────────────────────────────

type recWaiter struct{ ns []int }

func (r *recWaiter) WaitN(_ context.Context, n int) error { r.ns = append(r.ns, n); return nil }

func TestThrottledWriter_Chunks(t *testing.T) {
	t.Parallel()
	rw := &recWaiter{}
	var buf bytes.Buffer
	tw := &throttledWriter{ctx: context.Background(), w: &buf, lim: rw, chunk: throttleBurst}
	p := bytes.Repeat([]byte{7}, 150<<10)
	n, err := tw.Write(p)
	if err != nil || n != len(p) {
		t.Fatalf("Write = %d, %v", n, err)
	}
	want := []int{64 << 10, 64 << 10, 22 << 10}
	if len(rw.ns) != len(want) {
		t.Fatalf("WaitN calls %v, want %v", rw.ns, want)
	}
	for i := range want {
		if rw.ns[i] != want[i] {
			t.Fatalf("WaitN calls %v, want %v", rw.ns, want)
		}
	}
	if !bytes.Equal(buf.Bytes(), p) {
		t.Fatal("bytes altered")
	}
}

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) { return len(p) / 2, nil }

func TestThrottledWriter_ShortWrite(t *testing.T) {
	t.Parallel()
	tw := &throttledWriter{ctx: context.Background(), w: shortWriter{}, lim: &recWaiter{}, chunk: throttleBurst}
	n, err := tw.Write(make([]byte, 100))
	if err != io.ErrShortWrite {
		t.Fatalf("err = %v, want io.ErrShortWrite", err)
	}
	if n != 50 {
		t.Fatalf("n = %d, want 50", n)
	}
}

func TestThrottledWriter_ContextCancel(t *testing.T) {
	t.Parallel()
	lim := rate.NewLimiter(1, 1) // effectively blocked for large writes
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tw := &throttledWriter{ctx: ctx, w: io.Discard, lim: lim, chunk: 1}
	if _, err := tw.Write([]byte("abc")); err == nil {
		t.Fatal("expected context error")
	}
}

// End to end against a real limiter: a finite limit actually slows writes.
func TestThrottledWriter_RealLimiterPaces(t *testing.T) {
	t.Parallel()
	lim := rate.NewLimiter(rate.Limit(64<<10), throttleBurst) // 64 KiB/s, 64 KiB burst
	tw := &throttledWriter{ctx: context.Background(), w: io.Discard, lim: lim, chunk: throttleBurst}
	start := time.Now()
	tw.Write(make([]byte, 64<<10+16<<10)) // burst + 16 KiB ≈ 250 ms
	if el := time.Since(start); el < 150*time.Millisecond {
		t.Fatalf("finite limit did not pace writes (took %v)", el)
	}
}

func TestSnapshot_LimitBps(t *testing.T) {
	t.Parallel()
	fg := &fakeFg{}
	m := &Manager{jobs: map[string]*ExportJob{}, queue: pq.New[*workItem](), bw: newBWController(fg.stats, 0)}
	m.jobs["j"] = &ExportJob{ID: "j", Phase: PhaseDownloading, Source: SourceNetwork}

	if j, _ := m.Get("j"); j.LimitBps != nil || j.Throttled {
		t.Fatal("unthrottled job reported a limit")
	}
	fg.set(1, need)
	m.bw.start()
	defer m.bw.stop()
	j, _ := m.Get("j")
	if j.LimitBps == nil || !j.Throttled || *j.LimitBps != defaultStartBps {
		t.Fatalf("snapshot limit=%v throttled=%v, want %d/true", j.LimitBps, j.Throttled, defaultStartBps)
	}
	// Reuse paths never touch the network, so they are never throttled.
	m.jobs["j"].Source = SourcePlayback
	if j, _ := m.Get("j"); j.LimitBps != nil {
		t.Fatal("tail-reuse job reported a limit")
	}
}
