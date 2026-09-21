package vlc

// TestVLCSyncStutter measures whether continuous libvlc_media_player_set_time
// calls (simulating a 100ms MusicKit-clock drift correction loop) cause
// synchronous pipeline stalls or visible stutter.
//
// Also tests SetRate-based correction as an alternative: gradual rate tweak
// instead of hard seeks, which avoids flush-and-reseek entirely.
//
// PREREQUISITE: set TEST_VLC_FILE to a local H.264 mp4 path before running.
// The file must have video (audio is muted by SetVolume(0) in the test).
//
//   TEST_VLC_FILE=/path/to/sample.mp4 go test -v -run TestVLCSyncStutter -tags vlc ./core/vlc/
//   TEST_VLC_FILE=/path/to/sample.mp4 go test -v -run TestVLCRateCorrection -tags vlc ./core/vlc/
//
// What the results tell you:
//   - p50/p95/max of SetTime CGO call duration → is libvlc blocking the goroutine?
//   - posErr after each call → does VLC actually land where we asked?
//   - Rate test: does 0.99/1.01x rate feel smooth or does it cause judder?

import (
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"testing"
	"time"
)

func testVLCFile(t *testing.T) string {
	t.Helper()
	f := os.Getenv("TEST_VLC_FILE")
	if f == "" {
		t.Skip("TEST_VLC_FILE not set — skipping VLC sync stutter test")
	}
	return f
}

// TestVLCSyncStutter simulates the continuous 100ms SetTime drift-correction
// loop and measures call latency + position accuracy.
func TestVLCSyncStutter(t *testing.T) {
	p, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	p.SetVolume(0) // mute: isolate video pipeline, no audio clock interference

	url := "file://" + testVLCFile(t)
	if err := p.Load(url); err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Let VLC pre-roll and reach Playing state before hammering SetTime.
	t.Log("waiting 3s for VLC to pre-roll...")
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		pos, _, state := p.Time()
		if state == "playing" && pos > 0 {
			t.Logf("VLC playing at pos=%dms", pos)
			break
		}
	}
	time.Sleep(2 * time.Second) // extra settle time

	const (
		interval    = 100 * time.Millisecond
		testDur     = 15 * time.Second
		warnThresh  = 15 * time.Millisecond // CGO call blocked this long → pipeline flush
		correction  = int64(30)             // ms of simulated drift to correct each tick
	)

	type sample struct {
		callDur time.Duration
		posErr  int64 // |actual - target| ms after the call
	}
	var samples []sample
	var warns int

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	stop := time.After(testDur)

	log.Println("[stutter-test] starting 100ms SetTime loop for 15s — watch native window for frame-drops")

	for {
		select {
		case <-stop:
			goto done
		case <-ticker.C:
			cur, _, state := p.Time()
			if state != "playing" {
				continue
			}
			target := cur + correction

			start := time.Now()
			p.SetTime(target)
			dur := time.Since(start)

			// Give VLC 5ms to apply the seek, then read actual position.
			time.Sleep(5 * time.Millisecond)
			actual, _, _ := p.Time()
			posErr := actual - target
			if posErr < 0 {
				posErr = -posErr
			}

			samples = append(samples, sample{dur, posErr})
			if dur > warnThresh {
				warns++
				log.Printf("[WARN] SetTime blocked=%v posErr=%dms (pipeline flush?)", dur, posErr)
			}
		}
	}

done:
	if len(samples) == 0 {
		t.Fatal("no samples collected — VLC never entered playing state")
	}

	// Compute latency percentiles.
	durs := make([]float64, len(samples))
	for i, s := range samples {
		durs[i] = float64(s.callDur.Milliseconds())
	}
	sort.Float64s(durs)
	p50 := durs[len(durs)/2]
	p95 := durs[int(float64(len(durs))*0.95)]
	maxDur := durs[len(durs)-1]

	// Compute position error percentiles.
	errs := make([]float64, len(samples))
	for i, s := range samples {
		errs[i] = float64(s.posErr)
	}
	sort.Float64s(errs)
	errP50 := errs[len(errs)/2]
	errP95 := errs[int(float64(len(errs))*0.95)]

	fmt.Printf("\n=== SetTime stutter test (%d samples) ===\n", len(samples))
	fmt.Printf("CGO call latency:  p50=%.1fms  p95=%.1fms  max=%.1fms\n", p50, p95, maxDur)
	fmt.Printf("Position error:    p50=%.0fms  p95=%.0fms\n", errP50, errP95)
	fmt.Printf("Warns (>%v):       %d / %d (%.1f%%)\n", warnThresh, warns, len(samples), float64(warns)/float64(len(samples))*100)

	fmt.Println("\nVerdict:")
	switch {
	case maxDur < 5:
		fmt.Println("  ✓ SetTime returns instantly — libvlc is async; stutter risk LOW")
		fmt.Println("    Drift correction via SetTime is viable.")
	case p95 < 15:
		fmt.Println("  ~ SetTime is mostly fast but occasionally blocks — stutter risk MODERATE")
		fmt.Println("    Rate-based correction (TestVLCRateCorrection) is safer.")
	default:
		fmt.Println("  ✗ SetTime regularly blocks the goroutine — STUTTER LIKELY")
		fmt.Println("    Do NOT use SetTime for drift correction. Use rate-based approach.")
	}
}

// TestVLCRateCorrection tests the alternative: adjusting playback rate by ±1%
// to gradually correct drift without seeking. Smooth if VLC applies rate changes
// by scaling the clock rather than re-decoding.
func TestVLCRateCorrection(t *testing.T) {
	p, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	p.SetVolume(0)

	url := "file://" + testVLCFile(t)
	if err := p.Load(url); err != nil {
		t.Fatalf("Load: %v", err)
	}

	t.Log("waiting for VLC to pre-roll...")
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		pos, _, state := p.Time()
		if state == "playing" && pos > 0 {
			t.Logf("VLC playing at pos=%dms", pos)
			break
		}
	}
	time.Sleep(2 * time.Second)

	// Simulate a PID-like rate correction: alternate between fast (+1%) and
	// slow (-1%) every 500ms to see if rate changes cause decoder judder.
	const testDur = 15 * time.Second
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	stop := time.After(testDur)
	fast := true

	type rateSample struct {
		rate    float64
		callDur time.Duration
	}
	var samples []rateSample

	log.Println("[rate-test] alternating ±1% rate every 500ms for 15s — watch for judder")

	for {
		select {
		case <-stop:
			goto done
		case <-ticker.C:
			rate := 0.99
			if fast {
				rate = 1.01
			}
			fast = !fast

			start := time.Now()
			p.SetRate(rate)
			dur := time.Since(start)
			samples = append(samples, rateSample{rate, dur})
		}
	}

done:
	durs := make([]float64, len(samples))
	for i, s := range samples {
		durs[i] = float64(s.callDur.Microseconds())
	}
	sort.Float64s(durs)
	p50 := durs[len(durs)/2]
	maxDur := durs[len(durs)-1]

	_ = math.Pi // keep math import

	fmt.Printf("\n=== Rate correction test (%d samples) ===\n", len(samples))
	fmt.Printf("SetRate CGO latency: p50=%.0fµs  max=%.0fµs\n", p50, maxDur)
	fmt.Println("\nIf the video above looked smooth during rate changes → rate correction is viable.")
	fmt.Println("If it juddered during the 500ms alternation → rate changes cause re-clocking artifacts.")
}
