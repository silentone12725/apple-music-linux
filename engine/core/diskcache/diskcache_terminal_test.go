package diskcache

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"testing/synctest"
)

func TestStreamingTerminalSequences(t *testing.T) {
	for _, sequence := range []string{"CC", "DD", "CD", "DC"} {
		t.Run(sequence, func(t *testing.T) {
			c, _ := New(t.TempDir())
			w, _ := c.BeginStreamingPut("song", "alac")
			r := w.NewReader()
			defer r.Close()
			if _, err := w.Write([]byte("audio")); err != nil {
				t.Fatal(err)
			}
			var first error
			for i, operation := range sequence {
				var err error
				if operation == 'C' {
					err = w.Commit()
				} else {
					w.Discard()
					err = w.writeErr
				}
				if i == 0 {
					first = err
				}
			}
			b, err := io.ReadAll(r)
			if string(b) != "audio" || !errors.Is(err, first) {
				t.Fatalf("read %q, %v; first %v", b, err, first)
			}
			if w.refs.Load() != 1 {
				t.Fatalf("refs=%d", w.refs.Load())
			}
			r.Close()
			if _, err := w.file.Stat(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("file retained: %v", err)
			}
			select {
			case <-w.pending.done:
			default:
				t.Fatal("pending not completed")
			}
		})
	}
}

func TestStreamingConcurrentTerminal(t *testing.T) {
	for range 30 {
		c, _ := New(t.TempDir())
		w, _ := c.BeginStreamingPut("song", "alac")
		r := w.NewReader()
		var wg sync.WaitGroup
		results := make(chan error, 32)
		for i := range 32 {
			wg.Go(func() {
				if i%2 == 0 {
					results <- w.Commit()
				} else {
					w.Discard()
				}
			})
		}
		wg.Wait()
		close(results)
		for err := range results {
			if !errors.Is(err, w.writeErr) {
				t.Fatalf("commit=%v terminal=%v", err, w.writeErr)
			}
		}
		if w.refs.Load() != 1 {
			t.Fatalf("refs=%d", w.refs.Load())
		}
		_, err := io.ReadAll(r)
		if !errors.Is(err, w.writeErr) {
			t.Fatalf("reader=%v terminal=%v", err, w.writeErr)
		}
		r.Close()
	}
}

func TestStreamingTerminalWakesReader(t *testing.T) {
	for _, discard := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			c, _ := New(t.TempDir())
			w, _ := c.BeginStreamingPut("song", "alac")
			r := w.NewReader()
			defer r.Close()
			done := make(chan error, 1)
			go func() { _, err := r.Read(make([]byte, 1)); done <- err }()
			synctest.Wait()
			if discard {
				w.Discard()
			} else if err := w.Commit(); err != nil {
				t.Fatal(err)
			}
			err := <-done
			if discard && (err == nil || errors.Is(err, io.EOF)) {
				t.Fatalf("discard=%v", err)
			}
			if !discard && !errors.Is(err, io.EOF) {
				t.Fatalf("commit=%v", err)
			}
		})
	}
}

func TestStreamingLateTerminalPreservesNewOwner(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		c, _ := New(t.TempDir())
		a, _ := c.BeginStreamingPut("song", "alac")
		a.NewReader().Close()
		a.Discard()
		var cleanup func()
		var pending *pendingPut
		if streaming {
			b, _ := c.BeginStreamingPut("song", "alac")
			pending = b.pending
			cleanup = b.Discard
		} else {
			b, _ := c.BeginPut("song", "alac")
			pending = b.pending
			cleanup = b.Discard
		}
		a.Discard()
		_ = a.Commit()
		key := c.filename("song", "alac")
		if current, _ := c.inFlight.Load(key); current != pending {
			t.Fatal("old writer removed new reservation")
		}
		if streaming && c.GetStreaming("song", "alac") == nil {
			t.Fatal("old writer removed new streaming marker")
		}
		c.finishPut(key, a.pending, errors.New("late finish"))
		if current, _ := c.inFlight.Load(key); current != pending {
			t.Fatal("late finish removed new reservation")
		}
		cleanup()
	}
}

func TestStreamingRenameFailureIsTerminal(t *testing.T) {
	c, _ := New(t.TempDir())
	w, _ := c.BeginStreamingPut("song", "alac")
	r := w.NewReader()
	defer r.Close()
	if err := os.Mkdir(w.finalPath, 0o700); err != nil {
		t.Fatal(err)
	}
	first := w.Commit()
	if first == nil {
		t.Fatal("expected rename failure")
	}
	w.Discard()
	if err := w.Commit(); !errors.Is(err, first) {
		t.Fatalf("lost rename error: %v", err)
	}
	if _, err := io.ReadAll(r); err != nil {
		t.Fatalf("publication failure broke complete reader: %v", err)
	}
	if w.refs.Load() != 1 {
		t.Fatalf("refs=%d", w.refs.Load())
	}
}

func TestStreamingFileRepeatedFinish(t *testing.T) {
	for _, first := range []error{nil, context.Canceled, io.ErrShortWrite} {
		f, err := os.CreateTemp(t.TempDir(), "spool")
		if err != nil {
			t.Fatal(err)
		}
		w := NewStreamingFile(f)
		r := w.NewReader()
		w.FinishFile(first)
		w.FinishFile(errors.New("later"))
		if _, err := io.ReadAll(r); !errors.Is(err, first) {
			t.Fatalf("lost first result: %v, want %v", err, first)
		}
		r.Close()
		if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("descriptor retained: %v", err)
		}
	}
}

func TestStreamingFileRejectsCacheOperations(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "spool")
	if err != nil {
		t.Fatal(err)
	}
	w := NewStreamingFile(f)
	r := w.NewReader()
	defer r.Close()
	if err := w.Commit(); err == nil {
		t.Fatal("spool Commit must reject wrong mode")
	}
	w.Discard()
	if w.Finished() {
		t.Fatal("cache operation ended spool")
	}
	if _, err := w.Write([]byte("audio")); err != nil {
		t.Fatal(err)
	}
	w.FinishFile(nil)
	b, err := io.ReadAll(r)
	if string(b) != "audio" || err != nil {
		t.Fatalf("read=%q %v", b, err)
	}
}

func TestCacheWriterRejectsSpoolFinish(t *testing.T) {
	c, _ := New(t.TempDir())
	w, _ := c.BeginStreamingPut("song", "alac")
	r := w.NewReader()
	r.Close()
	w.FinishFile(context.Canceled)
	if w.Finished() {
		t.Fatal("wrong-mode finish ended cache writer")
	}
	if err := w.Commit(); err != nil {
		t.Fatal(err)
	}
	if w.refs.Load() != 0 {
		t.Fatalf("refs=%d", w.refs.Load())
	}
}

func TestFinishPutPreservesDifferentPendingIdentity(t *testing.T) {
	c, _ := New(t.TempDir())
	key := c.filename("song", "alac")
	old, current := newPendingPut(), newPendingPut()
	c.inFlight.Store(key, current)
	first := errors.New("original failure")
	c.finishPut(key, old, first)
	c.finishPut(key, old, nil)
	if got, _ := c.inFlight.Load(key); got != current {
		t.Fatal("released a different pendingPut")
	}
	if !errors.Is(old.err, first) {
		t.Fatalf("lost original error: %v", old.err)
	}
	select {
	case <-current.done:
		t.Fatal("notified wrong owner")
	default:
	}
}

func TestStreamingFileConcurrentFinish(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "spool")
	if err != nil {
		t.Fatal(err)
	}
	w := NewStreamingFile(f)
	r := w.NewReader()
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Go(func() {
			if i%2 == 0 {
				w.FinishFile(context.Canceled)
			} else {
				w.FinishFile(nil)
			}
		})
	}
	wg.Wait()
	if w.refs.Load() != 1 {
		t.Fatalf("refs=%d", w.refs.Load())
	}
	if _, err := io.ReadAll(r); !errors.Is(err, w.writeErr) {
		t.Fatalf("reader=%v terminal=%v", err, w.writeErr)
	}
	r.Close()
	if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("descriptor retained: %v", err)
	}
}
