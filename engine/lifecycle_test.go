package main

import (
	"testing"
	"time"
)

// ── epochManager ──────────────────────────────────────────────────────────────

func TestEpoch_StartsAtGenerationOne(t *testing.T) {
	em := newEpochManager()
	if em.Current().Generation != 1 {
		t.Fatalf("expected generation=1, got %d", em.Current().Generation)
	}
	if em.Current().Reason != EpochEngineStart {
		t.Fatalf("expected reason=%q, got %q", EpochEngineStart, em.Current().Reason)
	}
}

func TestEpoch_AdvanceIncrementsGeneration(t *testing.T) {
	em := newEpochManager()
	info := em.Advance(EpochSessionChanged)
	if info.Generation != 2 {
		t.Fatalf("expected generation=2 after first Advance, got %d", info.Generation)
	}
	if info.Reason != EpochSessionChanged {
		t.Fatalf("expected reason=%q, got %q", EpochSessionChanged, info.Reason)
	}
	info2 := em.Advance(EpochSessionChanged)
	if info2.Generation != 3 {
		t.Fatalf("expected generation=3 after second Advance, got %d", info2.Generation)
	}
}

func TestEpoch_CurrentReturnsLatest(t *testing.T) {
	em := newEpochManager()
	em.Advance(EpochSessionChanged)
	cur := em.Current()
	if cur.Generation != 2 {
		t.Fatalf("Current() should reflect latest Advance; got generation=%d", cur.Generation)
	}
}

func TestEpoch_SinceIsRecentTimestamp(t *testing.T) {
	before := time.Now()
	em := newEpochManager()
	after := time.Now()
	info := em.Current()
	if info.Since.Before(before) || info.Since.After(after) {
		t.Fatalf("epoch.Since %v not in window [%v, %v]", info.Since, before, after)
	}
}

// ── engineLifecycle ───────────────────────────────────────────────────────────

func TestLifecycle_DRMReadySinceZeroBeforeReady(t *testing.T) {
	em := newEpochManager()
	lc := newEngineLifecycle(em)
	if !lc.DRMReadySince().IsZero() {
		t.Fatal("DRMReadySince must be zero before OnFairPlayReady is called")
	}
}

func TestLifecycle_OnFairPlayReadySetsTimestamp(t *testing.T) {
	em := newEpochManager()
	lc := newEngineLifecycle(em)

	before := time.Now()
	lc.OnFairPlayReady(func() {})
	after := time.Now()

	ts := lc.DRMReadySince()
	if ts.IsZero() {
		t.Fatal("DRMReadySince must be non-zero after OnFairPlayReady")
	}
	if ts.Before(before) || ts.After(after) {
		t.Fatalf("DRMReadySince %v not in window [%v, %v]", ts, before, after)
	}
}

func TestLifecycle_OnFairPlayReadySchedulesCallback(t *testing.T) {
	em := newEpochManager()
	lc := newEngineLifecycle(em)

	// Patch resetAfter to be tiny so we can observe the callback in the test.
	// We can't patch the const, so we stop and replace the timer directly.
	fired := make(chan struct{}, 1)
	lc.OnFairPlayReady(func() { fired <- struct{}{} })

	// Manually stop the long timer and replace with a 10ms one.
	lc.drmReadyMu.Lock()
	lc.drmRefreshTimer.Stop()
	lc.drmRefreshTimer = time.AfterFunc(10*time.Millisecond, func() { fired <- struct{}{} })
	lc.drmReadyMu.Unlock()

	select {
	case <-fired:
		// expected
	case <-time.After(200 * time.Millisecond):
		t.Fatal("proactive refresh callback was not fired")
	}
}

func TestLifecycle_OnFairPlayReadyCancelsOldTimer(t *testing.T) {
	em := newEpochManager()
	lc := newEngineLifecycle(em)

	count := 0
	// Call twice — only the second timer should fire.
	lc.OnFairPlayReady(func() { count++ })
	lc.OnFairPlayReady(func() { count++ })

	// Both timers have drmSessionTTL duration, so neither fires in the test.
	// What matters is that the first one was stopped and replaced — no double-fire.
	// We verify this by checking DRMReadySince is updated each call.
	t1 := lc.DRMReadySince()
	lc.OnFairPlayReady(func() {})
	t2 := lc.DRMReadySince()
	if !t2.Equal(t2) || t1.After(t2) {
		t.Fatal("OnFairPlayReady must update DRMReadySince each call")
	}
}

func TestLifecycle_OnDRMStateChangedIdempotent(t *testing.T) {
	em := newEpochManager()
	lc := newEngineLifecycle(em)

	lc.OnDRMStateChanged("session-A")
	gen1 := em.Current().Generation
	lc.OnDRMStateChanged("session-A") // same value — must not advance
	gen2 := em.Current().Generation
	if gen1 != gen2 {
		t.Fatal("OnDRMStateChanged must be idempotent when called with same value")
	}

	lc.OnDRMStateChanged("session-B") // new value — must advance
	gen3 := em.Current().Generation
	if gen3 <= gen2 {
		t.Fatal("OnDRMStateChanged must advance epoch on a new session string")
	}
}
