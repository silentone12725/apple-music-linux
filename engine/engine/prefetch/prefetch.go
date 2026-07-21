// Package prefetch implements background cache warming for upcoming tracks.
//
// The Scheduler accepts a ContextPayload (PUT /api/v1/playback/context) and
// enqueues HLS segment warming jobs for each selected track.  Workers stream
// each track to io.Discard, which fills the engine's segment cache as a side-
// effect.  On subsequent real playback the segments are already in cache, so
// "Stream open" latency drops from 35–60 s to ~2 s.
//
// Separation of concerns:
//   - The renderer sends context + UI-derived signals.
//   - The scheduler owns all scheduling policy (which tracks, what order,
//     concurrency, retries).  Clients must not assume a particular algorithm.
//   - Scoring weights and strategy specifics are implementation details.
//   - Progress events are emitted over SSE via the EventSink.
package prefetch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"apple-music-cli/engine/playback"
)

const (
	// DefaultWorkers is the number of concurrent warming goroutines.
	DefaultWorkers = 3

	// maxRetries is the number of additional attempts after the first failure.
	maxRetries = 3
)

// ── Fail reasons ──────────────────────────────────────────────────────────────

// Stable reason codes included in EventTrackFailed for logging and future UI.
const (
	FailReasonNetwork        = "NETWORK"
	FailReasonTimeout        = "TIMEOUT"
	FailReasonAuth           = "AUTH"
	FailReasonNotFound       = "NOT_FOUND"
	FailReasonRetryExhausted = "RETRY_EXHAUSTED"
	FailReasonCancelled      = "CANCELLED"
)

// ── Public types ──────────────────────────────────────────────────────────────

// EventSink receives prefetch lifecycle events for forwarding to SSE clients.
type EventSink func(ev Event)

// EventKind classifies a prefetch SSE event.
type EventKind string

const (
	EventJobStarted   EventKind = "prefetch.started"
	EventTrackCached  EventKind = "prefetch.cached"
	EventTrackFailed  EventKind = "prefetch.failed"
	EventJobDone      EventKind = "prefetch.done"
	EventJobCancelled EventKind = "prefetch.cancelled"
)

// Event is forwarded to SSE clients.  Kind is also used as the SSE event-name
// field so clients can subscribe to specific event types directly.
type Event struct {
	Kind       EventKind `json:"kind"`
	JobID      string    `json:"jobId"`
	Generation int64     `json:"generation"` // increments per Submit; lets clients discard stale events
	AssetID    string    `json:"assetId,omitempty"`
	Total      int       `json:"total,omitempty"`
	Cached     int       `json:"cached,omitempty"`
	Failed     int       `json:"failed,omitempty"`
	Reason     string    `json:"reason,omitempty"` // set on prefetch.failed
}

// TrackSignals are UI-derived hints sent alongside each track.
type TrackSignals struct {
	Favorite          bool    `json:"favorite"`
	ApplePopularity   float64 `json:"applePopularity"`
	PlayCount         int     `json:"playCount"`
	SkipCount         int     `json:"skipCount"`
	LastPlayed        int64   `json:"lastPlayed"`
	QueueDistance     int     `json:"queueDistance"`
	Visible           bool    `json:"visible"`
	ExplicitSelection bool    `json:"explicitSelection"`
	RecentInteraction bool    `json:"recentInteraction"`
}

// TrackMetadata contains immutable facts about a track (e.g. track number).
type TrackMetadata struct {
	AlbumTrackIndex int `json:"albumTrackIndex"`
}

// TrackItem describes one track in a context payload.
type TrackItem struct {
	AssetID    string        `json:"assetId"`
	Storefront string        `json:"storefront"`
	Metadata   TrackMetadata `json:"metadata"`
	Signals    TrackSignals  `json:"signals"`
}

// ContextPayload is the decoded body of PUT /api/v1/playback/context.
type ContextPayload struct {
	Context struct {
		Type   string `json:"type"`
		ID     string `json:"id"`
		Reason string `json:"reason"`
	} `json:"context"`
	CurrentIndex int         `json:"currentIndex"`
	Tracks       []TrackItem `json:"tracks"`
}

// Phase describes the lifecycle state of a warm job.
type Phase string

const (
	PhaseQueued    Phase = "queued"
	PhaseRunning   Phase = "running"
	PhaseDone      Phase = "done"
	PhaseCancelled Phase = "cancelled"
)

// WarmJob is the public view of a cache-warming job.
type WarmJob struct {
	ID         string    `json:"jobId"`
	Generation int64     `json:"generation"`
	Status     Phase     `json:"status"`
	Total      int       `json:"total"`
	Warming    int       `json:"warming"`
	Cached     int       `json:"cached"`
	Failed     int       `json:"failed"`
	Cancelled  int       `json:"cancelled"`
	CreatedAt  time.Time `json:"createdAt"`

	cancel func()
	mu     sync.Mutex
}

func (j *WarmJob) snapshot() WarmJob {
	j.mu.Lock()
	id, gen, total, warming := j.ID, j.Generation, j.Total, j.Warming
	cached, failed, cancelled, createdAt := j.Cached, j.Failed, j.Cancelled, j.CreatedAt
	j.mu.Unlock()

	done := cached + failed + cancelled
	var status Phase
	switch {
	case done >= total && warming == 0:
		status = PhaseDone
	case warming > 0:
		status = PhaseRunning
	default:
		status = PhaseQueued
	}
	// Construct a fresh value — mu and cancel are intentionally left zero.
	return WarmJob{
		ID:        id, Generation: gen, Status: status,
		Total:     total, Warming: warming,
		Cached:    cached, Failed: failed, Cancelled: cancelled,
		CreatedAt: createdAt,
	}
}

func (j *WarmJob) startOne() {
	j.mu.Lock(); j.Warming++; j.mu.Unlock()
}

func (j *WarmJob) finishCached() (cached, total int) {
	j.mu.Lock(); j.Cached++; j.Warming--; cached, total = j.Cached, j.Total; j.mu.Unlock(); return
}

func (j *WarmJob) finishFailed() (failed, total int) {
	j.mu.Lock(); j.Failed++; j.Warming--; failed, total = j.Failed, j.Total; j.mu.Unlock(); return
}

func (j *WarmJob) finishCancelled() {
	j.mu.Lock(); j.Cancelled++; j.Warming--; j.mu.Unlock()
}

func (j *WarmJob) skipCancelled() {
	j.mu.Lock(); j.Cancelled++; j.mu.Unlock()
}

func (j *WarmJob) isDone() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.Cached+j.Failed+j.Cancelled >= j.Total && j.Warming == 0
}

// Stats holds internal scheduler metrics for observability.
type Stats struct {
	ActiveWorkers    int64   `json:"activeWorkers"`
	QueueDepth       int     `json:"queueDepth"`
	DedupHits        int64   `json:"dedupHits"`
	TotalCached      int64   `json:"totalCached"`
	TotalFailed      int64   `json:"totalFailed"`
	TotalCancelled   int64   `json:"totalCancelled"`
	TotalRetries     int64   `json:"totalRetries"`     // retry attempts (not first tries)
	AvgWarmMs        float64 `json:"avgWarmMs"`        // mean warm latency over last 200 successes
	P95WarmMs        float64 `json:"p95WarmMs"`        // 95th-percentile warm latency
	AvgQueueWaitMs   float64 `json:"avgQueueWaitMs"`   // mean time from enqueue to worker-start
	P95QueueWaitMs   float64 `json:"p95QueueWaitMs"`   // 95th-percentile queue wait
	CacheHitRatio    float64 `json:"cacheHitRatio"`    // cached / (cached + failed)
}

// isRetryable reports whether an error with the given reason code is worth
// retrying.  AUTH and NOT_FOUND are permanent; retrying them wastes workers.
func isRetryable(reason string) bool {
	return reason != FailReasonAuth && reason != FailReasonNotFound
}

// ── Latency tracking ──────────────────────────────────────────────────────────

const latencyCap = 200 // rolling window size

// latencyRing is a fixed-size circular buffer for warm-latency samples (ms).
type latencyRing struct {
	mu      sync.Mutex
	samples [latencyCap]int64
	pos     int
	n       int
}

func (lr *latencyRing) record(ms int64) {
	lr.mu.Lock()
	lr.samples[lr.pos%latencyCap] = ms
	lr.pos++
	if lr.n < latencyCap {
		lr.n++
	}
	lr.mu.Unlock()
}

// stats returns the mean and P95 latency over the current window.
func (lr *latencyRing) stats() (avg, p95 float64) {
	lr.mu.Lock()
	if lr.n == 0 {
		lr.mu.Unlock()
		return 0, 0
	}
	s := make([]int64, lr.n)
	start := lr.pos - lr.n
	for i := range s {
		s[i] = lr.samples[(start+i)%latencyCap]
	}
	lr.mu.Unlock()

	var sum int64
	for _, v := range s {
		sum += v
	}
	avg = float64(sum) / float64(len(s))

	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	idx := int(math.Ceil(float64(len(s))*0.95)) - 1
	if idx >= len(s) {
		idx = len(s) - 1
	}
	p95 = float64(s[idx])
	return
}

// ── Priority queue ────────────────────────────────────────────────────────────

type workItem struct {
	job        *WarmJob
	track      TrackItem
	token      string
	mut        string
	ctx        context.Context
	baseScore  float64   // computed once at Submit time via scoreTrack
	enqueuedAt time.Time // for aging calculation
}

// effectiveScore adds an aging bonus so lower-priority items never starve.
// Bonus: +0.01 per second waiting, capped at 0.5 (≈ 50 s to reach maximum).
func (w *workItem) effectiveScore() float64 {
	age := time.Since(w.enqueuedAt).Seconds()
	return w.baseScore + math.Min(age*0.01, 0.5)
}

// workQueue is a thread-safe priority queue ordered by effectiveScore.
// pop blocks until an item is available or the queue is closed.
type workQueue struct {
	mu    sync.Mutex
	cond  *sync.Cond
	items []*workItem
	done  bool
}

func newWorkQueue() *workQueue {
	wq := &workQueue{items: make([]*workItem, 0, 64)}
	wq.cond = sync.NewCond(&wq.mu)
	return wq
}

func (q *workQueue) push(item *workItem) {
	q.mu.Lock()
	q.items = append(q.items, item)
	q.cond.Signal()
	q.mu.Unlock()
}

// pop picks the item with the highest effectiveScore.
// O(n) scan — fine because queue depth is bounded at 512.
func (q *workQueue) pop() (*workItem, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.done {
		q.cond.Wait()
	}
	if len(q.items) == 0 {
		return nil, false // queue closed
	}
	best := 0
	for i := 1; i < len(q.items); i++ {
		if q.items[i].effectiveScore() > q.items[best].effectiveScore() {
			best = i
		}
	}
	item := q.items[best]
	// Swap-remove avoids shifting the underlying slice.
	q.items[best] = q.items[len(q.items)-1]
	q.items = q.items[:len(q.items)-1]
	return item, true
}

func (q *workQueue) close() {
	q.mu.Lock(); q.done = true; q.cond.Broadcast(); q.mu.Unlock()
}

func (q *workQueue) depth() int {
	q.mu.Lock(); n := len(q.items); q.mu.Unlock(); return n
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

// preWarmedEntry holds a session opened by a prefetch worker.
// Real playback can claim it to skip the webplayback API round-trip entirely.
type preWarmedEntry struct {
	sessionID string
	expiresAt time.Time
}

const preWarmTTL = 15 * time.Minute

// Scheduler manages cache-warming jobs using a bounded worker pool.
// Safe for concurrent use from multiple goroutines.
type Scheduler struct {
	pm    *playback.Manager
	token func() string
	mut   func() string
	sink  EventSink

	mu         sync.RWMutex
	jobs       map[string]*WarmJob
	dedup      map[string]bool            // assetId → currently in-flight
	preWarmed  map[string]preWarmedEntry  // assetId → pre-opened session (consumed on first use)
	generation atomic.Int64              // increments with each Submit call

	wq *workQueue

	// Cache config set by PUT /api/v1/cache/config; zero = unlimited/default.
	prewarmLimitMB atomic.Int64
	persistLimitMB atomic.Int64
	persistTTLDays atomic.Int64

	activeWorkers  atomic.Int64
	dedupHits      atomic.Int64
	totalCached    atomic.Int64
	totalFailed    atomic.Int64
	totalCancelled atomic.Int64
	totalRetries   atomic.Int64
	latencies      latencyRing // time from worker-start to opened (not streamed)
	queueWaits     latencyRing // time from enqueue to worker-start
}

// NewScheduler wires a Scheduler with the given playback manager.
// token and mut are called at Submit time to capture current credentials.
// sink receives SSE lifecycle events; pass nil to disable.
func NewScheduler(pm *playback.Manager, token, mut func() string, sink EventSink, workers int) *Scheduler {
	if workers <= 0 {
		workers = DefaultWorkers
	}
	s := &Scheduler{
		pm:        pm,
		token:     token,
		mut:       mut,
		sink:      sink,
		jobs:      make(map[string]*WarmJob),
		dedup:     make(map[string]bool),
		preWarmed: make(map[string]preWarmedEntry),
		wq:        newWorkQueue(),
	}
	for range workers {
		go s.worker()
	}
	return s
}

// CacheConfig holds user-configurable cache limits from PUT /api/v1/cache/config.
// Zero values mean unlimited/engine-default.
type CacheConfig struct {
	PrewarmLimitMB int64 `json:"prewarmLimitMB,omitempty"`
	PersistLimitMB int64 `json:"persistLimitMB,omitempty"`
	PersistTTLDays int64 `json:"persistTTLDays,omitempty"`
}

// SetCacheConfig atomically applies user-supplied cache limits.
func (s *Scheduler) SetCacheConfig(cfg CacheConfig) {
	if cfg.PrewarmLimitMB >= 0 {
		s.prewarmLimitMB.Store(cfg.PrewarmLimitMB)
	}
	if cfg.PersistLimitMB >= 0 {
		s.persistLimitMB.Store(cfg.PersistLimitMB)
	}
	if cfg.PersistTTLDays >= 0 {
		s.persistTTLDays.Store(cfg.PersistTTLDays)
	}
}

// GetCacheConfig returns the currently applied cache config.
func (s *Scheduler) GetCacheConfig() CacheConfig {
	return CacheConfig{
		PrewarmLimitMB: s.prewarmLimitMB.Load(),
		PersistLimitMB: s.persistLimitMB.Load(),
		PersistTTLDays: s.persistTTLDays.Load(),
	}
}

// Stats returns a point-in-time snapshot of internal scheduler metrics.
func (s *Scheduler) Stats() Stats {
	avg, p95 := s.latencies.stats()
	qAvg, qP95 := s.queueWaits.stats()
	cached := s.totalCached.Load()
	failed := s.totalFailed.Load()
	var hitRatio float64
	if cached+failed > 0 {
		hitRatio = float64(cached) / float64(cached+failed)
	}
	return Stats{
		ActiveWorkers:  s.activeWorkers.Load(),
		QueueDepth:     s.wq.depth(),
		DedupHits:      s.dedupHits.Load(),
		TotalCached:    cached,
		TotalFailed:    failed,
		TotalCancelled: s.totalCancelled.Load(),
		TotalRetries:   s.totalRetries.Load(),
		AvgWarmMs:      avg,
		P95WarmMs:      p95,
		AvgQueueWaitMs: qAvg,
		P95QueueWaitMs: qP95,
		CacheHitRatio:  hitRatio,
	}
}

// Submit enqueues a context payload for background cache warming.
// Returns the job ID (202 Accepted semantics — work may not be done yet).
func (s *Scheduler) Submit(payload ContextPayload) string {
	tracks := selectTracks(payload)
	gen := s.generation.Add(1)

	ctx, cancel := context.WithCancel(context.Background())
	job := &WarmJob{
		ID:         newID(),
		Generation: gen,
		Status:     PhaseQueued,
		Total:      len(tracks),
		CreatedAt:  time.Now(),
		cancel:     cancel,
	}

	s.mu.Lock()
	s.jobs[job.ID] = job
	s.mu.Unlock()

	if len(tracks) == 0 {
		cancel()
		return job.ID
	}

	tok := s.token()
	mut := s.mut()

	s.emit(Event{Kind: EventJobStarted, JobID: job.ID, Generation: gen, Total: len(tracks)})

	now := time.Now()
	for _, t := range tracks {
		s.wq.push(&workItem{
			job:        job,
			track:      t,
			token:      tok,
			mut:        mut,
			ctx:        ctx,
			baseScore:  scoreTrack(t),
			enqueuedAt: now,
		})
	}
	return job.ID
}

// Status returns a snapshot of the job's current state.
func (s *Scheduler) Status(id string) (WarmJob, bool) {
	s.mu.RLock()
	j, ok := s.jobs[id]
	s.mu.RUnlock()
	if !ok {
		return WarmJob{}, false
	}
	return j.snapshot(), true
}

// Cancel stops remaining work for the given job.
func (s *Scheduler) Cancel(id string) bool {
	s.mu.RLock()
	j, ok := s.jobs[id]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	j.cancel()
	s.emit(Event{Kind: EventJobCancelled, JobID: id, Generation: j.Generation})
	return true
}

// TakePreWarmed returns and removes the pre-opened session ID for assetID,
// allowing real playback to reuse it without a new webplayback API call.
// Returns ("", false) if no pre-warmed session exists or it has expired.
// Expired sessions are released back to the playback manager.
func (s *Scheduler) TakePreWarmed(assetID string) (sessionID string, ok bool) {
	s.mu.Lock()
	entry, found := s.preWarmed[assetID]
	if found {
		delete(s.preWarmed, assetID)
	}
	s.mu.Unlock()
	if !found {
		return "", false
	}
	if time.Now().After(entry.expiresAt) {
		s.pm.Release(entry.sessionID)
		return "", false
	}
	return entry.sessionID, true
}

// PruneExpiredPreWarmed releases pre-warmed sessions that were never claimed.
// Called periodically so abandoned sessions don't linger.
func (s *Scheduler) PruneExpiredPreWarmed() {
	now := time.Now()
	s.mu.Lock()
	var expired []string
	for assetID, entry := range s.preWarmed {
		if now.After(entry.expiresAt) {
			expired = append(expired, assetID)
		}
	}
	ids := make([]string, 0, len(expired))
	for _, assetID := range expired {
		ids = append(ids, s.preWarmed[assetID].sessionID)
		delete(s.preWarmed, assetID)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.pm.Release(id)
	}
}

// PrewarmCount returns the number of currently pre-warmed sessions.
func (s *Scheduler) PrewarmCount() int {
	s.mu.RLock()
	n := len(s.preWarmed)
	s.mu.RUnlock()
	return n
}

// ClearPreWarmed releases all pre-warmed sessions and removes them from the map.
func (s *Scheduler) ClearPreWarmed() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.preWarmed))
	for _, entry := range s.preWarmed {
		ids = append(ids, entry.sessionID)
	}
	s.preWarmed = make(map[string]preWarmedEntry)
	s.mu.Unlock()
	for _, id := range ids {
		s.pm.Release(id)
	}
}

// ── Workers ───────────────────────────────────────────────────────────────────

func (s *Scheduler) worker() {
	for {
		item, ok := s.wq.pop()
		if !ok {
			return // queue closed (shutdown)
		}
		s.warm(item)
	}
}

func (s *Scheduler) warm(item *workItem) {
	job := item.job

	// Fast-path: bail if already cancelled.
	select {
	case <-item.ctx.Done():
		job.skipCancelled()
		s.totalCancelled.Add(1)
		s.checkJobDone(job)
		return
	default:
	}

	// Dedup: skip if the same asset is already warming on another worker.
	s.mu.Lock()
	if s.dedup[item.track.AssetID] {
		s.mu.Unlock()
		job.skipCancelled()
		s.dedupHits.Add(1)
		s.totalCancelled.Add(1)
		s.checkJobDone(job)
		return
	}
	s.dedup[item.track.AssetID] = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.dedup, item.track.AssetID)
		s.mu.Unlock()
	}()

	s.queueWaits.record(time.Since(item.enqueuedAt).Milliseconds())
	job.startOne()
	s.activeWorkers.Add(1)
	defer s.activeWorkers.Add(-1)

	sf := item.track.Storefront
	if sf == "" {
		sf = "us"
	}

	startedAt := time.Now()
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			s.totalRetries.Add(1)
			delay := time.Duration(1<<uint(attempt-1)) * time.Second
			select {
			case <-item.ctx.Done():
				job.finishCancelled()
				s.totalCancelled.Add(1)
				s.checkJobDone(job)
				return
			case <-time.After(delay):
			}
		}

		select {
		case <-item.ctx.Done():
			job.finishCancelled()
			s.totalCancelled.Add(1)
			s.checkJobDone(job)
			return
		default:
		}

		sess, err := s.pm.Open(item.ctx, playback.OpenRequest{
			AssetID:    item.track.AssetID,
			Storefront: sf,
			Token:      item.token,
			MUT:        item.mut,
		})
		if err != nil {
			lastErr = err
			if item.ctx.Err() != nil {
				job.finishCancelled()
				s.totalCancelled.Add(1)
				s.checkJobDone(job)
				return
			}
			if !isRetryable(classifyError(err)) {
				break // permanent error — don't burn remaining retry slots
			}
			continue
		}

		// Store the pre-opened session so real playback can claim it.
		// Apple rotates access tokens in signed segment URLs between webplayback
		// API calls, so streaming to io.Discard does not benefit real playback
		// (different URL tokens → cache misses). Instead we hold the session open
		// so the real POST /api/v1/playback handler can reuse it immediately,
		// skipping its own webplayback API round-trip.
		s.mu.Lock()
		s.preWarmed[item.track.AssetID] = preWarmedEntry{
			sessionID: sess.ID,
			expiresAt: time.Now().Add(preWarmTTL),
		}
		s.mu.Unlock()

		// Guard against a cancellation that raced with the Open completion.
		select {
		case <-item.ctx.Done():
			// Job was cancelled — release the session we just opened.
			s.mu.Lock()
			delete(s.preWarmed, item.track.AssetID)
			s.mu.Unlock()
			s.pm.Release(sess.ID)
			job.finishCancelled()
			s.totalCancelled.Add(1)
			s.checkJobDone(job)
			return
		default:
		}

		s.latencies.record(time.Since(startedAt).Milliseconds())
		cached, total := job.finishCached()
		s.totalCached.Add(1)
		s.emit(Event{
			Kind:       EventTrackCached,
			JobID:      job.ID,
			Generation: job.Generation,
			AssetID:    item.track.AssetID,
			Cached:     cached,
			Total:      total,
		})
		s.checkJobDone(job)
		return
	}

	// All retries exhausted.
	failed, total := job.finishFailed()
	s.totalFailed.Add(1)
	s.emit(Event{
		Kind:       EventTrackFailed,
		JobID:      job.ID,
		Generation: job.Generation,
		AssetID:    item.track.AssetID,
		Failed:     failed,
		Total:      total,
		Reason:     classifyError(lastErr),
	})
	s.checkJobDone(job)
}

func (s *Scheduler) checkJobDone(job *WarmJob) {
	if job.isDone() {
		snap := job.snapshot()
		s.emit(Event{
			Kind:       EventJobDone,
			JobID:      job.ID,
			Generation: job.Generation,
			Total:      snap.Total,
			Cached:     snap.Cached,
			Failed:     snap.Failed,
		})
	}
}

func (s *Scheduler) emit(ev Event) {
	if s.sink != nil {
		s.sink(ev)
	}
}

// ── Track selection & scoring ─────────────────────────────────────────────────

func selectTracks(payload ContextPayload) []TrackItem {
	tracks := payload.Tracks
	if len(tracks) == 0 {
		return nil
	}

	reason := payload.Context.Reason
	current := payload.CurrentIndex

	switch reason {
	case "queue-change", "manual-play":
		start := current + 1
		if start < 0 {
			start = 0
		}
		if start >= len(tracks) {
			return nil
		}
		end := start + 5
		if end > len(tracks) {
			end = len(tracks)
		}
		return append([]TrackItem{}, tracks[start:end]...)

	case "hover-preview":
		return tracks[:1]

	case "startup", "album-open", "playlist-open", "radio":
		type scored struct {
			t TrackItem
			s float64
		}
		ss := make([]scored, len(tracks))
		for i, t := range tracks {
			ss[i] = scored{t, scoreTrack(t)}
		}
		sort.Slice(ss, func(a, b int) bool { return ss[a].s > ss[b].s })
		limit := len(tracks)
		if len(tracks) > 25 {
			limit = 5
		}
		out := make([]TrackItem, 0, limit)
		for _, s := range ss[:limit] {
			out = append(out, s.t)
		}
		return out

	default:
		end := 3
		if end > len(tracks) {
			end = len(tracks)
		}
		return append([]TrackItem{}, tracks[:end]...)
	}
}

func scoreTrack(t TrackItem) float64 {
	s := t.Signals
	score := 0.0
	if s.Favorite {
		score += 0.40
	}
	dist := s.QueueDistance
	if dist < 0 {
		dist = -dist
	}
	switch {
	case dist == 0:
		score += 0.35
	case dist <= 5:
		score += 0.35 * (1.0 - float64(dist)/6.0)
	}
	score += s.ApplePopularity * 0.15
	score += math.Min(float64(s.PlayCount)/10.0, 1.0) * 0.10
	if s.RecentInteraction {
		score += 0.05
	}
	score -= math.Min(float64(s.SkipCount)/5.0, 1.0) * 0.10
	return score
}

// classifyError maps an error to a stable FailReason* constant.
func classifyError(err error) string {
	if err == nil {
		return FailReasonRetryExhausted
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "unauthorized") || strings.Contains(msg, "forbidden") ||
		strings.Contains(msg, "401") || strings.Contains(msg, "403"):
		return FailReasonAuth
	case strings.Contains(msg, "not found") || strings.Contains(msg, "404"):
		return FailReasonNotFound
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
		return FailReasonTimeout
	case strings.Contains(msg, "connection") || strings.Contains(msg, "network") ||
		strings.Contains(msg, "dial") || strings.Contains(msg, "reset by peer"):
		return FailReasonNetwork
	default:
		return FailReasonRetryExhausted
	}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
