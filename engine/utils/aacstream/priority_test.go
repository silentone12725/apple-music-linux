package aacstream

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func readAllAsync(ctx context.Context, s string) chan string {
	out := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(gate(ctx, strings.NewReader(s)))
		out <- string(b)
	}()
	return out
}

func TestHoldBackgroundParksBackgroundButNotPriority(t *testing.T) {
	release := HoldBackground(time.Minute)
	defer release()

	bg := readAllAsync(context.Background(), "background")
	prio := readAllAsync(WithSeekPriority(context.Background()), "priority")

	select {
	case got := <-prio:
		if got != "priority" {
			t.Fatalf("priority read = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("priority download was parked")
	}
	select {
	case got := <-bg:
		t.Fatalf("background download ran during a hold: %q", got)
	case <-time.After(100 * time.Millisecond):
	}

	release()
	select {
	case got := <-bg:
		if got != "background" {
			t.Fatalf("background read = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("background download not resumed after release")
	}
}

func TestHoldBackgroundIsBoundedAndNests(t *testing.T) {
	a := HoldBackground(time.Minute)
	b := HoldBackground(80 * time.Millisecond) // expires on its own
	bg := readAllAsync(context.Background(), "x")

	time.Sleep(150 * time.Millisecond) // b has expired, a still holds
	select {
	case <-bg:
		t.Fatal("resumed while an outer hold was still active")
	default:
	}
	a()
	a() // idempotent: must not release b's slot or underflow
	b()
	select {
	case <-bg:
	case <-time.After(time.Second):
		t.Fatal("not resumed after all holds released")
	}
	if n := bgHold.n.Load(); n != 0 {
		t.Fatalf("holds = %d, want 0", n)
	}
}

func TestWaitBackgroundHonoursCancellation(t *testing.T) {
	release := HoldBackground(time.Minute)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- waitBackground(ctx) }()
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("want ctx error")
		}
	case <-time.After(time.Second):
		t.Fatal("waitBackground ignored cancellation")
	}
}
