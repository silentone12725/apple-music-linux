package pq

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func popAll(t *testing.T, q *Queue[string]) []string {
	t.Helper()
	var out []string
	for q.Len() > 0 {
		v, ok := q.Pop()
		if !ok {
			t.Fatal("Pop returned false with items queued")
		}
		out = append(out, v)
	}
	return out
}

func eq(a, b []string) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

func TestPriorityThenFIFO(t *testing.T) {
	q := New[string]()
	q.Push("a", "0/1", 0)
	q.Push("b", "5/2", 5)
	q.Push("c", "10/3", 10)
	q.Push("d", "10/4", 10)
	q.Push("e", "0/5", 0)
	got := popAll(t, q)
	want := []string{"10/3", "10/4", "5/2", "0/1", "0/5"}
	if !eq(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
}

func TestFIFOManyEqual(t *testing.T) {
	q := New[string]()
	var want []string
	for i := 0; i < 100; i++ {
		s := fmt.Sprint(i)
		q.Push(s, s, 1)
		want = append(want, s)
	}
	if got := popAll(t, q); !eq(got, want) {
		t.Fatalf("equal priorities not FIFO: %v", got)
	}
}

func TestDuplicatePushRejected(t *testing.T) {
	q := New[string]()
	if !q.Push("a", "x", 0) || q.Push("a", "y", 5) {
		t.Fatal("duplicate id accepted")
	}
}

func TestUpdateQueuedAndPopped(t *testing.T) {
	q := New[string]()
	q.Push("a", "a", 0)
	q.Push("b", "b", 0)
	q.Push("c", "c", 0)
	if !q.Update("c", 9) {
		t.Fatal("Update of queued item failed")
	}
	if v, _ := q.Pop(); v != "c" {
		t.Fatalf("after Update popped %q, want c", v)
	}
	if q.Update("c", 1) {
		t.Fatal("Update succeeded on a popped item")
	}
	if q.Update("zzz", 1) {
		t.Fatal("Update succeeded on an unknown item")
	}
}

// Raising then lowering keeps the original sequence for tie-breaking.
func TestUpdateKeepsSequence(t *testing.T) {
	q := New[string]()
	q.Push("a", "a", 0)
	q.Push("b", "b", 0)
	q.Update("a", 5)
	q.Update("a", 0)
	if got := popAll(t, q); !eq(got, []string{"a", "b"}) {
		t.Fatalf("got %v", got)
	}
}

func TestRemoveQueuedAndPopped(t *testing.T) {
	q := New[string]()
	q.Push("a", "a", 0)
	q.Push("b", "b", 0)
	q.Push("c", "c", 0)
	if v, ok := q.Remove("b"); !ok || v != "b" {
		t.Fatal("Remove of queued item failed")
	}
	if q.Len() != 2 {
		t.Fatalf("Len %d, want 2", q.Len())
	}
	v, _ := q.Pop()
	if _, ok := q.Remove(v); ok {
		t.Fatal("Remove succeeded on a popped item")
	}
	if got := popAll(t, q); !eq(got, []string{"c"}) {
		t.Fatalf("got %v", got)
	}
}

func TestSnapshotSorted(t *testing.T) {
	q := New[string]()
	// Push in an order whose heap array is not globally sorted.
	for i, p := range []int{1, 7, 3, 7, 0, 9, 3} {
		id := fmt.Sprint(i)
		q.Push(id, id, p)
	}
	snap := q.Snapshot()
	for i := 1; i < len(snap); i++ {
		a, b := snap[i-1], snap[i]
		if a.Prio < b.Prio {
			t.Fatalf("snapshot not sorted by priority: %+v", snap)
		}
	}
	var ids []string
	for _, e := range snap {
		ids = append(ids, e.ID)
	}
	if got := popAll(t, q); !eq(got, ids) {
		t.Fatalf("snapshot order %v != pop order %v", ids, got)
	}
}

func TestPopBlocksUntilPush(t *testing.T) {
	q := New[string]()
	got := make(chan string, 1)
	go func() { v, _ := q.Pop(); got <- v }()
	select {
	case <-got:
		t.Fatal("Pop returned on an empty queue")
	case <-time.After(30 * time.Millisecond):
	}
	q.Push("a", "a", 0)
	select {
	case v := <-got:
		if v != "a" {
			t.Fatalf("popped %q", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Pop did not wake on Push")
	}
}

func TestCloseWakesAndDrains(t *testing.T) {
	q := New[string]()
	done := make(chan bool, 1)
	go func() { _, ok := q.Pop(); done <- ok }()
	time.Sleep(10 * time.Millisecond)
	q.Close()
	if ok := <-done; ok {
		t.Fatal("Pop on closed empty queue returned true")
	}
	if q.Push("a", "a", 0) {
		t.Fatal("Push accepted after Close")
	}

	q2 := New[string]()
	q2.Push("a", "a", 0)
	q2.Close()
	if v, ok := q2.Pop(); !ok || v != "a" {
		t.Fatal("Close dropped queued items")
	}
	if _, ok := q2.Pop(); ok {
		t.Fatal("Pop after drain returned true")
	}
}

func TestConcurrentProducersConsumers(t *testing.T) {
	q := New[int]()
	const n = 500
	var wg sync.WaitGroup
	seen := make(chan int, n)
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				v, ok := q.Pop()
				if !ok {
					return
				}
				seen <- v
			}
		}()
	}
	for i := 0; i < n; i++ {
		go func(i int) { q.Push(fmt.Sprint(i), i, i%3) }(i)
	}
	deadline := time.After(5 * time.Second)
	got := map[int]bool{}
	for len(got) < n {
		select {
		case v := <-seen:
			got[v] = true
		case <-deadline:
			t.Fatalf("only %d/%d items popped", len(got), n)
		}
	}
	q.Close()
	wg.Wait()
}
