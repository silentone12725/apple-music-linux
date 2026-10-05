//go:build native_backend

package drm

import (
	"testing"
	"time"
)

// Stop must not tear the C library down under a call that is still inside it, and must
// refuse new calls from the moment it starts.
func TestQuiesceWaitsForInFlightCalls(t *testing.T) {
	b := &nativeBackend{running: true, gen: 1}

	leave, err := b.enter(0)
	if err != nil {
		t.Fatal(err)
	}

	drained := make(chan bool, 1)
	go func() { drained <- b.quiesce(5 * time.Second) }()

	// New calls are refused as soon as quiesce has begun, even though one is in flight.
	deadline := time.Now().Add(2 * time.Second)
	for {
		probe, err := b.enter(0)
		if err != nil {
			break
		}
		probe() // accepted before quiesce got going: release it, it must not count as in flight
		if time.Now().After(deadline) {
			t.Fatal("a new call was accepted after Stop began")
		}
		time.Sleep(5 * time.Millisecond)
	}

	select {
	case <-drained:
		t.Fatal("quiesce returned while a call was still inside the library")
	case <-time.After(100 * time.Millisecond):
	}

	leave()
	select {
	case ok := <-drained:
		if !ok {
			t.Fatal("quiesce timed out although the call finished")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("quiesce did not return after the call finished")
	}
}

func TestQuiesceGivesUpOnAStuckCall(t *testing.T) {
	b := &nativeBackend{running: true, gen: 1}
	if _, err := b.enter(0); err != nil {
		t.Fatal(err)
	}
	if b.quiesce(50 * time.Millisecond) {
		t.Fatal("quiesce reported a clean drain with a call still in flight")
	}
}

// A key context opened before a restart must not be used after it.
func TestEnterRejectsContextsFromAPreviousRun(t *testing.T) {
	b := &nativeBackend{running: true, gen: 2}
	if _, err := b.enter(1); err == nil {
		t.Fatal("a call carrying generation 1 was accepted by generation 2")
	}
	leave, err := b.enter(2)
	if err != nil {
		t.Fatal(err)
	}
	leave()
	if _, err := b.enter(0); err != nil {
		t.Fatalf("generation-less calls are always allowed while running: %v", err)
	}
	b.mu.Lock()
	b.active = 0
	b.mu.Unlock()
}
