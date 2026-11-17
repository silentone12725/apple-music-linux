package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestLoadOrderSupersedesOlderRequests(t *testing.T) {
	var o loadOrder
	older, newer := o.begin(), o.begin()

	ran, err := o.runIfCurrent(newer, func() error { return nil })
	if !ran || err != nil {
		t.Fatalf("newest request: ran=%v err=%v", ran, err)
	}
	ran, err = o.runIfCurrent(older, func() error {
		t.Error("a superseded load reached the player")
		return nil
	})
	if ran || err != nil {
		t.Fatalf("older request: ran=%v err=%v", ran, err)
	}

	boom := errors.New("boom")
	if ran, err := o.runIfCurrent(newer, func() error { return boom }); !ran || err != boom {
		t.Fatalf("errors must pass through: ran=%v err=%v", ran, err)
	}
}

// Loads that finish out of order must still leave the newest one playing.
func TestLoadOrderNewestLoadsLast(t *testing.T) {
	var (
		o      loadOrder
		mu     sync.Mutex
		played []uint64
		wg     sync.WaitGroup
	)
	const n = 64
	seqs := make([]uint64, n)
	for i := range seqs {
		seqs[i] = o.begin()
	}
	for i := n - 1; i >= 0; i-- { // the newest ones start first, the oldest finish last
		wg.Add(1)
		go func(seq uint64) {
			defer wg.Done()
			time.Sleep(time.Duration(n-int(seq)) * 50 * time.Microsecond)
			o.runIfCurrent(seq, func() error {
				mu.Lock()
				played = append(played, seq)
				mu.Unlock()
				return nil
			})
		}(seqs[i])
	}
	wg.Wait()
	if len(played) == 0 || played[len(played)-1] != seqs[n-1] {
		t.Fatalf("last load = %v, want the newest (%d)", played, seqs[n-1])
	}
	for i := 1; i < len(played); i++ {
		if played[i] <= played[i-1] {
			t.Fatalf("loads reached the player out of order: %v", played)
		}
	}
}

func TestLoadOrderHandoffSerializesState(t *testing.T) {
	var o loadOrder
	seq := o.begin()
	entered, resume := make(chan struct{}), make(chan struct{})
	done := make(chan struct{})
	state := uint64(0)
	go func() {
		defer close(done)
		o.runIfCurrent(seq, func() error {
			if o.mu.TryLock() {
				o.mu.Unlock()
				t.Error("handoff is not protected")
			}
			close(entered)
			<-resume
			state = seq
			return nil
		})
	}()
	<-entered
	newer := make(chan uint64, 1)
	go func() {
		next := o.begin()
		o.runIfCurrent(next, func() error { state = next; return nil })
		newer <- next
	}()
	close(resume)
	<-done
	if next := <-newer; state != next {
		t.Fatal("older state replaced newer handoff")
	}
}

func TestLoadOrderRejectsAllStaleSideEffects(t *testing.T) {
	var o loadOrder
	a, b := o.begin(), o.begin()
	session, seek, foreground := uint64(0), uint64(0), uint64(0)
	if ran, err := o.runIfCurrent(b, func() error { session, seek, foreground = b, 123, b; return nil }); !ran || err != nil {
		t.Fatal("new handoff failed")
	}
	if ran, _ := o.runIfCurrent(a, func() error { session, seek, foreground = a, 999, a; return nil }); ran {
		t.Fatal("old handoff accepted")
	}
	if session != b || seek != 123 || foreground != b {
		t.Fatal("stale side effects replaced new state")
	}
}
