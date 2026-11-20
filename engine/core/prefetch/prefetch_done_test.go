package prefetch

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestJobEndIsAnnouncedOnce(t *testing.T) {
	var done atomic.Int32
	s := &Scheduler{jobs: map[string]*WarmJob{}, sink: func(ev Event) {
		if ev.Kind == EventJobDone {
			done.Add(1)
		}
	}}
	job := &WarmJob{ID: "j", Total: 2, Cached: 2}
	s.jobs[job.ID] = job
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); s.checkJobDone(job) }()
	}
	wg.Wait()
	if n := done.Load(); n != 1 {
		t.Fatalf("job end announced %d times", n)
	}
}
