package main

import (
	"testing"
	"time"
)

func TestCircuitBreaker_StartsClose(t *testing.T) {
	cb := newCircuitBreaker(3, time.Second)
	if !cb.Allow() {
		t.Fatal("new breaker must be closed (Allow=true)")
	}
	if cb.State() != "closed" {
		t.Fatalf("expected state=closed, got %q", cb.State())
	}
}

func TestCircuitBreaker_TripsAtThreshold(t *testing.T) {
	cb := newCircuitBreaker(3, time.Hour)
	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != "closed" {
		t.Fatal("breaker must stay closed below threshold")
	}
	cb.RecordFailure() // 3rd — trips
	if cb.State() != "open" {
		t.Fatalf("expected state=open after threshold, got %q", cb.State())
	}
	if cb.Allow() {
		t.Fatal("Allow must return false while breaker is open")
	}
}

func TestCircuitBreaker_ResetsAfterTimeout(t *testing.T) {
	cb := newCircuitBreaker(1, 10*time.Millisecond)
	cb.RecordFailure()
	if cb.State() != "open" {
		t.Fatal("expected open after failure")
	}
	time.Sleep(20 * time.Millisecond)
	if cb.State() != "closed" {
		t.Fatalf("expected closed after reset window, got %q", cb.State())
	}
	if !cb.Allow() {
		t.Fatal("Allow must return true after reset")
	}
}

func TestCircuitBreaker_RecordSuccessClearsFailures(t *testing.T) {
	cb := newCircuitBreaker(3, time.Hour)
	cb.RecordFailure()
	cb.RecordFailure()
	cb.RecordSuccess()
	cb.RecordFailure()
	cb.RecordFailure()
	// Only 2 failures after reset — should not trip (threshold=3).
	if cb.State() != "closed" {
		t.Fatalf("expected closed after success reset failures, got %q", cb.State())
	}
}

func TestCircuitBreaker_ConcurrentSafe(t *testing.T) {
	cb := newCircuitBreaker(100, time.Second)
	done := make(chan struct{})
	for i := 0; i < 50; i++ {
		go func() {
			cb.RecordFailure()
			cb.RecordSuccess()
			cb.Allow()
			cb.State()
			done <- struct{}{}
		}()
	}
	for i := 0; i < 50; i++ {
		<-done
	}
}
