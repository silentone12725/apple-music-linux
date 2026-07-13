package harness

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// clockTicksPerSec is USER_HZ on Linux (getconf CLK_TCK). It is 100 on every
// mainstream Linux build; /proc CPU times are expressed in these ticks.
const clockTicksPerSec = 100.0

// RuntimeStats mirrors GET /api/v1/debug/runtime — metrics only the engine
// process can report about itself.
type RuntimeStats struct {
	Goroutines      int    `json:"goroutines"`
	HeapAllocBytes  uint64 `json:"heapAllocBytes"`
	HeapSysBytes    uint64 `json:"heapSysBytes"`
	StackSysBytes   uint64 `json:"stackSysBytes"`
	TotalAllocBytes uint64 `json:"totalAllocBytes"`
	NumGC           uint32 `json:"numGC"`
	GCPauseTotalNs  uint64 `json:"gcPauseTotalNs"`
	NextGCBytes     uint64 `json:"nextGCBytes"`
}

// Sample is one point-in-time reading of the engine process.
type Sample struct {
	Elapsed        time.Duration `json:"elapsedMs"`
	RSSBytes       int64         `json:"rssBytes"`
	CPUUserSec     float64       `json:"cpuUserSec"`
	CPUSysSec      float64       `json:"cpuSysSec"`
	FDs            int           `json:"fds"`
	Goroutines     int           `json:"goroutines"`
	HeapAllocBytes uint64        `json:"heapAllocBytes"`
	NumGC          uint32        `json:"numGC"`
	GCPauseTotalNs uint64        `json:"gcPauseTotalNs"`
}

// Sampler periodically records external (/proc) and internal (runtime endpoint)
// metrics for a running Engine.
type Sampler struct {
	eng      *Engine
	interval time.Duration
	start    time.Time

	mu      sync.Mutex
	samples []Sample
	done    chan struct{}
}

// NewSampler creates a sampler for eng at the given cadence.
func NewSampler(eng *Engine, interval time.Duration) *Sampler {
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	return &Sampler{eng: eng, interval: interval, done: make(chan struct{})}
}

// Run samples in a goroutine until ctx is cancelled or Stop is called.
func (s *Sampler) Run(ctx context.Context) {
	s.start = time.Now()
	go func() {
		defer close(s.done)
		t := time.NewTicker(s.interval)
		defer t.Stop()
		s.record(ctx) // t=0 baseline
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.record(ctx)
			}
		}
	}()
}

// Stop waits for the sampling goroutine to finish and returns all samples.
// The caller is expected to cancel Run's context first.
func (s *Sampler) Stop() []Sample {
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Sample, len(s.samples))
	copy(out, s.samples)
	return out
}

func (s *Sampler) record(ctx context.Context) {
	pid := s.eng.PID()
	rss, fds := procRSS(pid), procFDCount(pid)
	user, sys := procCPU(pid)

	smp := Sample{
		Elapsed:    time.Since(s.start),
		RSSBytes:   rss,
		CPUUserSec: user,
		CPUSysSec:  sys,
		FDs:        fds,
	}
	// Best-effort internal metrics; skip on error (e.g. mid-shutdown).
	rctx, cancel := context.WithTimeout(ctx, time.Second)
	if rs, err := s.eng.RuntimeStats(rctx); err == nil {
		smp.Goroutines = rs.Goroutines
		smp.HeapAllocBytes = rs.HeapAllocBytes
		smp.NumGC = rs.NumGC
		smp.GCPauseTotalNs = rs.GCPauseTotalNs
	}
	cancel()

	s.mu.Lock()
	s.samples = append(s.samples, smp)
	s.mu.Unlock()
}

// ── /proc readers (Linux) ─────────────────────────────────────────────────────

func procRSS(pid int) int64 {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "VmRSS:") {
			var kb int64
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ = strconv.ParseInt(fields[1], 10, 64)
			}
			return kb * 1024
		}
	}
	return 0
}

func procFDCount(pid int) int {
	entries, err := os.ReadDir("/proc/" + strconv.Itoa(pid) + "/fd")
	if err != nil {
		return -1
	}
	return len(entries)
}

// procCPU returns cumulative user and system CPU seconds from /proc/<pid>/stat.
// The comm field (field 2) may contain spaces inside parentheses, so we split
// after the final ')'.
func procCPU(pid int) (userSec, sysSec float64) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, 0
	}
	s := string(data)
	rparen := strings.LastIndexByte(s, ')')
	if rparen < 0 || rparen+2 >= len(s) {
		return 0, 0
	}
	// Fields after comm start at field 3 (state). utime=field14, stime=field15.
	rest := strings.Fields(s[rparen+2:])
	const utimeIdx, stimeIdx = 11, 12 // 14-3, 15-3
	if len(rest) <= stimeIdx {
		return 0, 0
	}
	utime, _ := strconv.ParseFloat(rest[utimeIdx], 64)
	stime, _ := strconv.ParseFloat(rest[stimeIdx], 64)
	return utime / clockTicksPerSec, stime / clockTicksPerSec
}

// ── summary ────────────────────────────────────────────────────────────────

// Summary aggregates a sample series for reporting.
type Summary struct {
	Samples         int     `json:"samples"`
	DurationSec     float64 `json:"durationSec"`
	PeakRSSBytes    int64   `json:"peakRssBytes"`
	FinalRSSBytes   int64   `json:"finalRssBytes"`
	PeakFDs         int     `json:"peakFds"`
	CPUUserSec      float64 `json:"cpuUserSec"`    // total over the window
	CPUSysSec       float64 `json:"cpuSysSec"`     // total over the window
	AvgCPUPercent   float64 `json:"avgCpuPercent"` // (user+sys)/wall × 100
	StartGoroutines int     `json:"startGoroutines"`
	FinalGoroutines int     `json:"finalGoroutines"`
	PeakGoroutines  int     `json:"peakGoroutines"`
	StartHeapBytes  uint64  `json:"startHeapAllocBytes"`
	FinalHeapBytes  uint64  `json:"finalHeapAllocBytes"`
	PeakHeapBytes   uint64  `json:"peakHeapAllocBytes"`
	NumGC           uint32  `json:"numGC"`
	GCPauseTotalNs  uint64  `json:"gcPauseTotalNs"`
}

// Summarize reduces a sample series. CPU is the delta between first and last
// cumulative readings; wall is the elapsed span between them.
func Summarize(samples []Sample) Summary {
	var sum Summary
	sum.Samples = len(samples)
	if len(samples) == 0 {
		return sum
	}
	first, last := samples[0], samples[len(samples)-1]
	sum.DurationSec = (last.Elapsed - first.Elapsed).Seconds()
	sum.CPUUserSec = last.CPUUserSec - first.CPUUserSec
	sum.CPUSysSec = last.CPUSysSec - first.CPUSysSec
	if sum.DurationSec > 0 {
		sum.AvgCPUPercent = 100.0 * (sum.CPUUserSec + sum.CPUSysSec) / sum.DurationSec
	}
	sum.StartGoroutines, sum.FinalGoroutines = first.Goroutines, last.Goroutines
	sum.StartHeapBytes, sum.FinalHeapBytes = first.HeapAllocBytes, last.HeapAllocBytes
	sum.FinalRSSBytes = last.RSSBytes
	sum.NumGC = last.NumGC - first.NumGC
	sum.GCPauseTotalNs = last.GCPauseTotalNs - first.GCPauseTotalNs

	for _, smp := range samples {
		if smp.RSSBytes > sum.PeakRSSBytes {
			sum.PeakRSSBytes = smp.RSSBytes
		}
		if smp.FDs > sum.PeakFDs {
			sum.PeakFDs = smp.FDs
		}
		if smp.Goroutines > sum.PeakGoroutines {
			sum.PeakGoroutines = smp.Goroutines
		}
		if smp.HeapAllocBytes > sum.PeakHeapBytes {
			sum.PeakHeapBytes = smp.HeapAllocBytes
		}
	}
	return sum
}
