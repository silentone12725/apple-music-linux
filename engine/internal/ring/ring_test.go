package ring_test

import (
	"sync"
	"testing"

	"engine/internal/ring"
)

func TestBuffer_EmptySnapshot(t *testing.T) {
	b := ring.New(10)
	if s := b.Snapshot(); s != nil {
		t.Fatalf("expected nil snapshot on empty buffer, got %v", s)
	}
}

func TestBuffer_RecordAndSnapshot(t *testing.T) {
	b := ring.New(5)
	for i := int64(1); i <= 3; i++ {
		b.Record(i)
	}
	got := b.Snapshot()
	if len(got) != 3 {
		t.Fatalf("expected 3 samples, got %d", len(got))
	}
	for i, v := range got {
		if v != int64(i+1) {
			t.Errorf("sample[%d] = %d, want %d", i, v, i+1)
		}
	}
}

func TestBuffer_Wraps(t *testing.T) {
	b := ring.New(3)
	for i := int64(1); i <= 6; i++ {
		b.Record(i)
	}
	got := b.Snapshot()
	if len(got) != 3 {
		t.Fatalf("expected 3 samples after wrap, got %d", len(got))
	}
	// Oldest→newest: 4, 5, 6
	want := []int64{4, 5, 6}
	for i, v := range got {
		if v != want[i] {
			t.Errorf("sample[%d] = %d, want %d", i, v, want[i])
		}
	}
}

func TestBuffer_Stats(t *testing.T) {
	b := ring.New(10)
	for i := int64(1); i <= 10; i++ {
		b.Record(i)
	}
	avg, p95 := b.Stats()
	// avg of 1..10 = 5.5
	if avg != 5.5 {
		t.Errorf("avg = %f, want 5.5", avg)
	}
	// p95 of 1..10 sorted: idx = ceil(10*0.95)-1 = 9 → value 10
	if p95 != 10 {
		t.Errorf("p95 = %f, want 10", p95)
	}
}

func TestBuffer_EmptyStats(t *testing.T) {
	b := ring.New(10)
	avg, p95 := b.Stats()
	if avg != 0 || p95 != 0 {
		t.Errorf("empty buffer: got avg=%f p95=%f, want 0 0", avg, p95)
	}
}

func TestBuffer_ConcurrentSafe(t *testing.T) {
	b := ring.New(100)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(v int64) {
			defer wg.Done()
			b.Record(v)
			b.Snapshot()
			b.Stats()
		}(int64(i))
	}
	wg.Wait()
}
