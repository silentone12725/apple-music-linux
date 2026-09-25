package export

import (
	"context"
	"io"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Bandwidth scheduling between playback and exports.
//
// Playback owns the bandwidth budget; exports are opportunistic background
// consumers. While playback streams, the export's network stream is throttled
// by an AIMD controller (additive increase, multiplicative decrease — the
// same shape as TCP and LEDBAT-style "scavenger" transports) driven by how
// fast playback is actually fetching. The export never pauses: every finite
// limit is clamped to floorBps. A floor rather than a hard pause also keeps
// the CDN body flowing — cbcs's stall detector aborts a download whose body
// delivers <256 B in 30 s, which any sane floor comfortably exceeds.
//
// Backpressure reaches the network because pipeline.runChain joins stages
// with io.Pipe and sources read segments sequentially: slowing the export's
// final writer slows its reads.

const (
	defaultFloorBps = 128 << 10 // 128 KiB/s — the export never goes below this
	defaultStartBps = 1 << 20   // 1 MiB/s — conservative rate when playback appears
	defaultStepBps  = 256 << 10 // 256 KiB/s additive increase per tick
	throttleBurst   = 64 << 10  // limiter burst; WaitN is always called with ≤ this
	throttleTick    = 500 * time.Millisecond

	// Hysteresis band on measured foreground throughput, as multiples of
	// foregroundNeedBps: below decreaseAt → back off, above increaseAt → grow,
	// in between → hold. The gap prevents the limit oscillating every tick.
	decreaseAt = 3.0
	increaseAt = 4.0
)

// fgStatsFunc returns playback.Manager.ForegroundStats-style raw counters:
// active foreground streams, cumulative foreground bytes, and the summed
// required rate (foregroundNeedBps) of the active streams.
type fgStatsFunc func() (active int, bytes int64, needBps int64)

type throttleState uint8

const (
	throttleUnlimited throttleState = iota // no playback: limit = Inf
	throttleStarting                       // playback just appeared: startBps, baseline taken, no evaluation yet
	throttleAdaptive                       // AIMD with hysteresis
)

// bwController adapts the shared export limiter to foreground playback.
//
// foregroundNeedBps is a protection threshold, NOT an estimate of available
// bandwidth: measured playback throughput (fgBps) is observed consumption, not
// link capacity. Do not turn this into "spare = link − fgBps" arithmetic.
type bwController struct {
	lim      *rate.Limiter
	apply    func(rate.Limit) // lim.SetLimit; swappable so tests can count calls
	stats    fgStatsFunc
	now      func() time.Time
	floorBps float64
	startBps float64
	stepBps  float64

	mu          sync.Mutex
	state       throttleState
	limitBps    float64    // meaningful when state != throttleUnlimited
	applied     rate.Limit // last value handed to apply
	lastFgBytes int64
	lastTime    time.Time

	runMu   sync.Mutex
	cancel  context.CancelFunc
	stopped chan struct{}
}

func newBWController(stats fgStatsFunc, floorBps float64) *bwController {
	if floorBps <= 0 {
		floorBps = defaultFloorBps
	}
	lim := rate.NewLimiter(rate.Inf, throttleBurst)
	return &bwController{
		lim:      lim,
		apply:    lim.SetLimit,
		stats:    stats,
		now:      time.Now,
		floorBps: floorBps,
		startBps: max(defaultStartBps, floorBps),
		stepBps:  defaultStepBps,
		applied:  rate.Inf,
	}
}

// applyLocked hands l to the limiter only when it differs from the last value.
func (c *bwController) applyLocked(l rate.Limit) {
	if l == c.applied {
		return
	}
	c.applied = l
	c.apply(l)
}

// tick runs one controller step. Throughput is measured per interval
// (delta bytes / delta time), never cumulative bytes over total time.
func (c *bwController) tick() {
	active, fgBytes, need := c.stats()
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()

	if active == 0 {
		if c.state != throttleUnlimited {
			c.state = throttleUnlimited
			c.applyLocked(rate.Inf)
		}
		// Always re-baseline so a later playback never measures across the idle gap.
		c.lastFgBytes, c.lastTime = fgBytes, now
		return
	}

	switch c.state {
	case throttleUnlimited:
		// Playback appeared: drop to a conservative rate immediately and take a
		// fresh baseline. The interval so far is incomplete, so skip evaluation.
		c.state = throttleStarting
		c.setLimitLocked(c.startBps)
		c.lastFgBytes, c.lastTime = fgBytes, now
		return
	case throttleStarting:
		c.state = throttleAdaptive // first complete interval: evaluate below
	}

	dt := now.Sub(c.lastTime).Seconds()
	delta := fgBytes - c.lastFgBytes
	c.lastFgBytes, c.lastTime = fgBytes, now
	if dt <= 0 {
		return
	}
	fgBps := float64(delta) / dt

	next := c.limitBps
	switch {
	case need <= 0:
		// No threshold to protect against (should not happen: playback falls
		// back to per-kind rates). Never grow without evidence of headroom.
		next *= 0.5
	case fgBps < decreaseAt*float64(need):
		next *= 0.5
	case fgBps > increaseAt*float64(need):
		next += c.stepBps
	}
	c.setLimitLocked(next)
}

// setLimitLocked clamps to the floor and applies only real changes.
func (c *bwController) setLimitLocked(bps float64) {
	if bps < c.floorBps {
		bps = c.floorBps
	}
	c.limitBps = bps
	c.applyLocked(rate.Limit(bps))
}

// currentLimit returns the finite limit in force, or nil when unlimited.
func (c *bwController) currentLimit() *int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == throttleUnlimited {
		return nil
	}
	v := int64(c.limitBps)
	return &v
}

// start begins ticking for the duration of one export's network stream. The
// first tick runs synchronously so an export that starts during playback is
// throttled from its first byte.
func (c *bwController) start() {
	c.runMu.Lock()
	defer c.runMu.Unlock()
	if c.cancel != nil || c.stats == nil {
		return
	}
	c.tick()
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.stopped = make(chan struct{})
	go func(stopped chan struct{}) {
		defer close(stopped)
		t := time.NewTicker(throttleTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.tick()
			}
		}
	}(c.stopped)
}

// stop ends ticking and waits for the goroutine to exit before resetting to
// unlimited, so a late tick can never apply a limit to stale state.
func (c *bwController) stop() {
	c.runMu.Lock()
	defer c.runMu.Unlock()
	if c.cancel == nil {
		return
	}
	c.cancel()
	<-c.stopped
	c.cancel, c.stopped = nil, nil

	c.mu.Lock()
	c.state = throttleUnlimited
	c.applyLocked(rate.Inf)
	c.mu.Unlock()
}

// writer wraps w so every byte waits on the shared export limiter.
func (c *bwController) writer(ctx context.Context, w io.Writer) io.Writer {
	return &throttledWriter{ctx: ctx, w: w, lim: c.lim, chunk: throttleBurst}
}

type waiter interface {
	WaitN(ctx context.Context, n int) error
}

// throttledWriter rate-limits writes in chunks no larger than the limiter's
// burst (WaitN rejects n > burst on a finite limit).
type throttledWriter struct {
	ctx   context.Context
	w     io.Writer
	lim   waiter
	chunk int
}

func (t *throttledWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), t.chunk)
		if err := t.lim.WaitN(t.ctx, n); err != nil {
			return written, err
		}
		m, err := t.w.Write(p[:n])
		written += m
		if err != nil {
			return written, err
		}
		if m < n {
			return written, io.ErrShortWrite
		}
		p = p[n:]
	}
	return written, nil
}
