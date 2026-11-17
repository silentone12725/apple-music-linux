package diskcache

import (
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewReaderAtIfActiveStopsAtTerminal(t *testing.T) {
	for _, finish := range []string{"commit", "discard"} {
		t.Run(finish, func(t *testing.T) {
			c, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			sw, err := c.BeginStreamingPut("a", "alac")
			if err != nil || sw == nil {
				t.Fatalf("BeginStreamingPut: %v, %v", sw, err)
			}
			if _, err := sw.Write([]byte("0123456789")); err != nil {
				t.Fatal(err)
			}
			r := sw.NewReaderAtIfActive(4)
			if r == nil {
				t.Fatal("no reader on an unfinished writer")
			}
			buf := make([]byte, 3)
			if _, err := io.ReadFull(r, buf); err != nil || string(buf) != "456" {
				t.Fatalf("read from offset 4 = %q, %v", buf, err)
			}
			r.Close()
			if finish == "commit" {
				if err := sw.Commit(); err != nil {
					t.Fatal(err)
				}
			} else {
				sw.Discard()
			}
			if got := sw.NewReaderAtIfActive(0); got != nil {
				t.Fatal("a finished writer handed out a reader")
			}
			if c.GetStreaming("a", "alac") != nil {
				t.Fatal("a finished writer is still published")
			}
		})
	}
}

// A range request finds the writer with GetStreaming and then takes a reader. However the
// finish races with that, the reader it gets must sit on an open file.
func TestGetStreamingThenReaderAtNeverSeesAClosedFile(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var closed, total atomic.Int64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 8)
			for {
				select {
				case <-stop:
					return
				default:
				}
				sw := c.GetStreaming("a", "alac")
				if sw == nil {
					continue
				}
				r := sw.NewReaderAtIfActive(0)
				if r == nil {
					continue
				}
				total.Add(1)
				if _, err := r.Read(buf); err != nil && strings.Contains(err.Error(), "closed") {
					closed.Add(1)
				}
				r.Close()
			}
		}()
	}
	deadline := time.Now().Add(750 * time.Millisecond)
	for time.Now().Before(deadline) {
		sw, err := c.BeginStreamingPut("a", "alac")
		if err != nil || sw == nil {
			continue
		}
		sw.Write([]byte("0123456789abcdef"))
		if err := sw.Commit(); err != nil {
			t.Fatal(err)
		}
		c.Remove("a", "alac")
	}
	close(stop)
	wg.Wait()
	if closed.Load() != 0 {
		t.Fatalf("%d of %d readers sat on a closed file", closed.Load(), total.Load())
	}
}
