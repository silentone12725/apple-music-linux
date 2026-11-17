package diskcache

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"syscall"
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

// Hold the observable finish prefix (done, but still published and reserved)
// until all waiters have tried it. This needs no production timing hook.
func TestWaitForTerminalStreamingWriter(t *testing.T) {
	for _, tc := range []struct {
		name           string
		publicationErr error
		sourceErr      error
		rename         bool
	}{
		{name: "commit success"},
		{name: "sync ENOSPC", publicationErr: syscall.ENOSPC},
		{name: "sync EIO", publicationErr: syscall.EIO},
		{name: "rename permission", publicationErr: os.ErrPermission, rename: true},
		{name: "source EIO", sourceErr: syscall.EIO},
		{name: "source short write", sourceErr: io.ErrShortWrite},
		{name: "source canceled", sourceErr: context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				c, err := New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				w, err := c.BeginStreamingPut("song", "alac")
				if err != nil {
					t.Fatal(err)
				}
				r := w.NewReader()
				defer r.Close()
				if _, err := w.Write([]byte("audio")); err != nil {
					t.Fatal(err)
				}
				if tc.publicationErr != nil {
					fail := func(*os.File) error { return tc.publicationErr }
					if tc.rename {
						c.renameFile = func(string, string) error { return tc.publicationErr }
					} else {
						c.syncFile = fail
					}
				}
				w.mu.Lock()
				w.done = true
				w.writeErr = tc.sourceErr
				w.producerErr = tc.sourceErr
				w.mu.Unlock()
				if c.GetStreaming("song", "alac") != w {
					t.Fatal("streaming marker missing from fixture")
				}
				select {
				case <-w.pending.done:
					t.Fatal("pending already finished")
				default:
				}
				if extra := w.NewReaderIfActive(); extra != nil {
					extra.Close()
					t.Error("terminal reader accepted")
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				const count = 8
				results := make(chan error, count)
				for range count {
					go func() { results <- c.WaitForWriter(ctx, "song", "alac") }()
				}
				synctest.Wait()
				early := 0
				for range count {
					select {
					case got := <-results:
						early++
						t.Errorf("false readiness before terminal publication: %v", got)
					default:
					}
				}
				if other, err := c.BeginStreamingPut("song", "alac"); other != nil || err != nil {
					t.Fatalf("duplicate writer=%v err=%v", other, err)
				}
				want := tc.publicationErr
				if tc.sourceErr != nil {
					want = tc.sourceErr
				}
				if err := w.Commit(); !errors.Is(err, want) {
					t.Errorf("commit=%v want=%v", err, want)
				}
				for i := early; i < count; i++ {
					if got := <-results; !errors.Is(got, want) {
						t.Errorf("waiter=%v want=%v", got, want)
					}
				}
				data, readErr := io.ReadAll(r)
				if string(data) != "audio" || !errors.Is(readErr, tc.sourceErr) {
					t.Errorf("reader=%q %v want=%v", data, readErr, tc.sourceErr)
				}
				if f, hit := c.Get("song", "alac"); hit != (want == nil) {
					t.Errorf("cache hit=%v", hit)
				} else if f != nil {
					f.Close()
				}
				if c.GetStreaming("song", "alac") != nil {
					t.Error("streaming marker retained")
				}
				if _, held := c.inFlight.Load(w.key); held {
					t.Error("reservation retained")
				}
				if w.refs.Load() != 1 {
					t.Errorf("refs=%d", w.refs.Load())
				}
				if err := w.Commit(); !errors.Is(err, want) {
					t.Error("repeat commit lost result")
				}
				w.Discard()
			})
		})
	}
}

func TestWaitForTerminalStreamingWriterCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, err := New(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		w, err := c.BeginStreamingPut("song", "alac")
		if err != nil {
			t.Fatal(err)
		}
		defer w.Discard()
		w.mu.Lock()
		w.done = true
		w.mu.Unlock()
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		result := make(chan error, 1)
		go func() { result <- c.WaitForWriter(ctx, "song", "alac") }()
		synctest.Wait()
		select {
		case err := <-result:
			t.Errorf("returned before cancellation: %v", err)
			return
		default:
		}
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel=%v", err)
		}
		select {
		case <-w.pending.done:
			t.Fatal("cancellation finished the producer")
		default:
		}
	})
}
