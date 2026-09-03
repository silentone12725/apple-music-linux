package main

import (
	"testing"
	"time"
)

func newTestBus() *eventBus {
	epoch := newEpochManager()
	return newEventBus(epoch)
}

// ── emit + subscribe ──────────────────────────────────────────────────────────

func TestEventBus_EmitDeliveredToSubscriber(t *testing.T) {
	b := newTestBus()
	_, ch, _, _ := b.subscribeAndReplay(-1)

	b.emit("test.event", map[string]string{"k": "v"})

	select {
	case ev := <-ch:
		if ev.Type != "test.event" {
			t.Fatalf("expected type test.event, got %q", ev.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event")
	}
}

func TestEventBus_IDsMonotonicallyIncreasing(t *testing.T) {
	b := newTestBus()
	_, ch, _, _ := b.subscribeAndReplay(-1)

	b.emit("a", nil)
	b.emit("b", nil)
	b.emit("c", nil)

	var prev int64
	for i := 0; i < 3; i++ {
		select {
		case ev := <-ch:
			if ev.ID <= prev {
				t.Fatalf("event ID %d not greater than previous %d", ev.ID, prev)
			}
			prev = ev.ID
		case <-time.After(100 * time.Millisecond):
			t.Fatal("timeout")
		}
	}
}

// ── replay buffer ─────────────────────────────────────────────────────────────

func TestEventBus_ReplayAfterReconnect(t *testing.T) {
	b := newTestBus()

	// First subscriber — consume 3 events, then disconnect.
	subID, ch, _, _ := b.subscribeAndReplay(-1)
	b.emit("ev1", nil)
	b.emit("ev2", nil)
	b.emit("ev3", nil)
	var lastID int64
	for i := 0; i < 3; i++ {
		ev := <-ch
		lastID = ev.ID
	}
	b.unsubscribe(subID)

	// Second subscriber reconnects with Last-Event-ID = lastID-1 (missed ev3).
	_, _, replay, truncated := b.subscribeAndReplay(lastID - 1)
	if truncated {
		t.Fatal("replay must not be truncated for recent events")
	}
	if len(replay) < 1 {
		t.Fatalf("expected at least 1 replayed event, got %d", len(replay))
	}
	for _, rv := range replay {
		if rv.ID <= lastID-1 {
			t.Errorf("replayed event ID %d should be > afterID %d", rv.ID, lastID-1)
		}
	}
}

func TestEventBus_NoReplayOnFirstConnect(t *testing.T) {
	b := newTestBus()
	b.emit("old", nil)

	_, _, replay, truncated := b.subscribeAndReplay(-1) // -1 = first-time connect
	if len(replay) != 0 {
		t.Fatalf("first-time connect must not replay; got %d events", len(replay))
	}
	if truncated {
		t.Fatal("truncated must be false on first connect")
	}
}

func TestEventBus_TruncatedWhenRingEvicted(t *testing.T) {
	b := newTestBus()

	// Fill ring past ringSize (256) so the earliest events are evicted.
	for i := 0; i < ringSize+10; i++ {
		b.emit("fill", nil)
	}

	// Reconnect requesting event ID 1 — definitely evicted.
	_, _, _, truncated := b.subscribeAndReplay(1)
	if !truncated {
		t.Fatal("expected truncated=true when requested ID was evicted from ring")
	}
}

func TestEventBus_RingBoundsEmptyBus(t *testing.T) {
	b := newTestBus()
	oldest, newest := b.ringBounds()
	if oldest != 0 || newest != 0 {
		t.Fatalf("empty bus ring bounds should be 0,0; got %d,%d", oldest, newest)
	}
}

func TestEventBus_RingBoundsNonEmpty(t *testing.T) {
	b := newTestBus()
	b.emit("x", nil)
	b.emit("y", nil)
	oldest, newest := b.ringBounds()
	if oldest == 0 || newest == 0 {
		t.Fatal("ring bounds should be non-zero after emitting events")
	}
	if oldest > newest {
		t.Fatalf("oldest %d > newest %d", oldest, newest)
	}
}

// ── unsubscribe ───────────────────────────────────────────────────────────────

func TestEventBus_UnsubscribeClosesChan(t *testing.T) {
	b := newTestBus()
	subID, ch, _, _ := b.subscribeAndReplay(-1)
	b.unsubscribe(subID)

	select {
	case _, open := <-ch:
		if open {
			t.Fatal("channel must be closed after unsubscribe")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout — channel not closed")
	}
}

// ── concurrent safety ─────────────────────────────────────────────────────────

func TestEventBus_ConcurrentEmitAndSubscribe(t *testing.T) {
	b := newTestBus()
	done := make(chan struct{})

	for i := 0; i < 10; i++ {
		go func() {
			b.emit("concurrent", nil)
			done <- struct{}{}
		}()
	}
	for i := 0; i < 5; i++ {
		go func() {
			id, ch, _, _ := b.subscribeAndReplay(-1)
			time.Sleep(time.Millisecond)
			b.unsubscribe(id)
			_ = ch
			done <- struct{}{}
		}()
	}
	for i := 0; i < 15; i++ {
		<-done
	}
}
