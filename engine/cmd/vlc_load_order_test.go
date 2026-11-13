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
