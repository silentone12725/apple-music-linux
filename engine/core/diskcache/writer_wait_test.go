package diskcache

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestWaitForWriterPublication(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _ := New(t.TempDir())
		// Hold the reservation at the exact point before a writer is published.
		p := newPendingPut()
		key := c.filename("song", "alac")
		c.inFlight.Store(key, p)
		done := make(chan error, 1)
		go func() { done <- c.WaitForWriter(t.Context(), "song", "alac") }()
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("returned before publication")
		default:
		}
		if w, err := c.BeginStreamingPut("song", "alac"); w != nil || err != nil {
			t.Fatalf("second writer acquired a reserved key: %v, %v", w, err)
		}
		c.streaming.Store(key, &StreamingPutWriter{})
		close(p.ready)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		c.streaming.Delete(key)
		c.finishPut(key, p, nil)
	})
}

func TestWaitForNonStreamingWriter(t *testing.T) {
	for _, tc := range []struct {
		name   string
		commit bool
	}{{"commit", true}, {"discard", false}} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				c, _ := New(t.TempDir())
				w, _ := c.BeginPut("song", "alac")
				done := make(chan error, 1)
				go func() { done <- c.WaitForWriter(t.Context(), "song", "alac") }()
				synctest.Wait()
				select {
				case <-done:
					t.Fatal("did not wait for non-streaming writer")
				default:
				}
				if tc.commit {
					_, _ = w.Write([]byte("audio"))
					if err := w.Commit(); err != nil {
						t.Fatal(err)
					}
				} else {
					w.Discard()
					w.Discard()
				}
				if err := <-done; (err == nil) != tc.commit {
					t.Fatalf("completion error = %v", err)
				}
				if w, err := c.BeginStreamingPut("song", "alac"); w == nil || err != nil {
					t.Fatalf("key not released: %v", err)
				} else {
					w.Discard()
				}
			})
		})
	}
}

func TestWaitForWriterDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _ := New(t.TempDir())
		w, _ := c.BeginPut("song", "alac")
		defer w.Discard()
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if err := c.WaitForWriter(ctx, "song", "alac"); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("wait error = %v", err)
		}
	})
}

func TestStreamingReaderCommitInterleaving(t *testing.T) {
	for range 50 {
		c, _ := New(t.TempDir())
		w, _ := c.BeginStreamingPut("song", "alac")
		_, _ = w.Write([]byte("complete audio"))
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.Commit(); err != nil {
				t.Error(err)
			}
		}()
		if r := w.NewReaderIfActive(); r != nil {
			b, err := io.ReadAll(r)
			r.Close()
			r.Close()
			if err != nil || string(b) != "complete audio" {
				t.Errorf("read = %q, %v", b, err)
			}
		}
		wg.Wait()
		f, ok := c.Get("song", "alac")
		if !ok {
			t.Fatal("committed entry missing")
		}
		b, err := io.ReadAll(f)
		f.Close()
		if err != nil || string(b) != "complete audio" {
			t.Fatalf("committed read = %q, %v", b, err)
		}
		if _, err := w.file.Stat(); err == nil {
			t.Fatal("writer descriptor retained without readers")
		}
	}
}

func TestBeginStreamingPutOrGetReusesCommittedEntry(t *testing.T) {
	c, _ := New(t.TempDir())
	w, _ := c.BeginStreamingPut("song", "alac")
	_, _ = w.Write([]byte("complete audio"))
	if err := w.Commit(); err != nil {
		t.Fatal(err)
	}
	writer, f, err := c.BeginStreamingPutOrGet("song", "alac")
	if writer != nil || f == nil || err != nil {
		t.Fatalf("writer=%v file=%v err=%v", writer, f, err)
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil || string(b) != "complete audio" {
		t.Fatalf("read=%q, %v", b, err)
	}
	if c.GetStreaming("song", "alac") != nil {
		t.Fatal("published a duplicate writer for a completed entry")
	}
	if _, held := c.inFlight.Load(c.filename("song", "alac")); held {
		t.Fatal("cache hit retained the key")
	}
}

func TestStreamingFileFinishAndReferences(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"complete", nil}, {"failure", errors.New("disk I/O failed")}, {"cancel", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, err := os.CreateTemp(t.TempDir(), "private-spool")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			w := NewStreamingFile(f)
			r := w.NewReader()
			if _, err := w.Write([]byte("partial or complete audio")); err != nil {
				t.Fatal(err)
			}
			w.FinishFile(tc.err)
			if _, err := f.Stat(); err != nil {
				t.Fatal("producer closed a live reader's descriptor")
			}
			b, err := io.ReadAll(r)
			if string(b) != "partial or complete audio" || !errors.Is(err, tc.err) {
				t.Fatalf("read=%q error=%v, want original error %v", b, err, tc.err)
			}
			r.Close()
			r.Close()
			if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("descriptor retained: %v", err)
			}
		})
	}
}
