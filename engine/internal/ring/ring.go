// Package ring provides a fixed-capacity circular buffer for int64 latency samples.
package ring

import (
	"math"
	"sort"
	"sync"
)

// Buffer is a thread-safe circular buffer of int64 samples.
type Buffer struct {
	mu      sync.Mutex
	samples []int64
	pos     int
	n       int
}

// New returns a Buffer with the given capacity.
func New(capacity int) *Buffer {
	return &Buffer{samples: make([]int64, capacity)}
}

// Record adds one sample.
func (b *Buffer) Record(v int64) {
	b.mu.Lock()
	b.samples[b.pos%len(b.samples)] = v
	b.pos++
	if b.n < len(b.samples) {
		b.n++
	}
	b.mu.Unlock()
}

// Snapshot returns a copy of the current window (oldest→newest).
func (b *Buffer) Snapshot() []int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.n == 0 {
		return nil
	}
	out := make([]int64, b.n)
	start := b.pos - b.n
	cap := len(b.samples)
	for i := range out {
		out[i] = b.samples[(start+i)%cap]
	}
	return out
}

// Stats returns the mean and p95 latency over the current window.
func (b *Buffer) Stats() (avg, p95 float64) {
	b.mu.Lock()
	if b.n == 0 {
		b.mu.Unlock()
		return 0, 0
	}
	var tmp [1024]int64
	s := tmp[:b.n]
	start := b.pos - b.n
	cap := len(b.samples)
	for i := range s {
		s[i] = b.samples[(start+i)%cap]
	}
	b.mu.Unlock()

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
