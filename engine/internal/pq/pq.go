// Package pq provides a goroutine-safe priority queue keyed by ID.
//
// Items pop in (priority descending, insertion sequence ascending) order, so
// equal priorities are FIFO. Pop blocks until an item is available or the
// queue is closed. Pop removes the item from both the heap and the ID index
// under one lock, so once an item has been popped, Update and Remove report
// it as no longer queued — callers use that to tell queued work from running
// work without a race.
package pq

import (
	"container/heap"
	"sort"
	"sync"
)

// Entry is one queued item as returned by Snapshot.
type Entry[T any] struct {
	ID   string
	Item T
	Prio int
}

type entry[T any] struct {
	id    string
	item  T
	prio  int
	seq   uint64
	index int
}

func less[T any](a, b *entry[T]) bool {
	if a.prio != b.prio {
		return a.prio > b.prio
	}
	return a.seq < b.seq
}

type entryHeap[T any] []*entry[T]

func (h entryHeap[T]) Len() int           { return len(h) }
func (h entryHeap[T]) Less(i, j int) bool { return less(h[i], h[j]) }
func (h entryHeap[T]) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}
func (h *entryHeap[T]) Push(x any) {
	e := x.(*entry[T])
	e.index = len(*h)
	*h = append(*h, e)
}
func (h *entryHeap[T]) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	e.index = -1
	return e
}

// Queue is a blocking max-priority queue with FIFO tie-breaking.
type Queue[T any] struct {
	mu     sync.Mutex
	cond   *sync.Cond
	h      entryHeap[T]
	byID   map[string]*entry[T]
	seq    uint64
	closed bool
}

// New returns an empty queue.
func New[T any]() *Queue[T] {
	q := &Queue[T]{byID: make(map[string]*entry[T])}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// Push enqueues item under id. The FIFO sequence number is assigned now, at
// push time. Returns false if id is already queued or the queue is closed.
func (q *Queue[T]) Push(id string, item T, prio int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	if _, dup := q.byID[id]; dup {
		return false
	}
	q.seq++
	e := &entry[T]{id: id, item: item, prio: prio, seq: q.seq}
	heap.Push(&q.h, e)
	q.byID[id] = e
	q.cond.Signal()
	return true
}

// Pop blocks until an item is available and removes the highest-priority one.
// Returns false once the queue is closed and drained.
func (q *Queue[T]) Pop() (T, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.h.Len() == 0 && !q.closed {
		q.cond.Wait()
	}
	if q.h.Len() == 0 {
		var zero T
		return zero, false
	}
	e := heap.Pop(&q.h).(*entry[T])
	delete(q.byID, e.id)
	return e.item, true
}

// Update changes the priority of a queued item. It keeps the item's original
// sequence number. Returns false if id is not queued (never pushed, removed,
// or already popped).
func (q *Queue[T]) Update(id string, prio int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	e, ok := q.byID[id]
	if !ok {
		return false
	}
	e.prio = prio
	heap.Fix(&q.h, e.index)
	return true
}

// Remove deletes a queued item and returns it. Returns false if id is not
// queued (for example, it was already popped by a worker).
func (q *Queue[T]) Remove(id string) (T, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	e, ok := q.byID[id]
	if !ok {
		var zero T
		return zero, false
	}
	heap.Remove(&q.h, e.index)
	delete(q.byID, id)
	return e.item, true
}

// Len returns the number of queued items.
func (q *Queue[T]) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.h.Len()
}

// Snapshot returns the queued items in pop order. A heap is only ordered at
// its root, so this copies the backing slice and sorts it explicitly.
func (q *Queue[T]) Snapshot() []Entry[T] {
	q.mu.Lock()
	es := make([]*entry[T], len(q.h))
	copy(es, q.h)
	q.mu.Unlock()
	sort.Slice(es, func(i, j int) bool { return less(es[i], es[j]) })
	out := make([]Entry[T], len(es))
	for i, e := range es {
		out[i] = Entry[T]{ID: e.id, Item: e.item, Prio: e.prio}
	}
	return out
}

// Close wakes all blocked Pop calls; subsequent Pushes are rejected and Pop
// returns false once the remaining items are drained.
func (q *Queue[T]) Close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}
