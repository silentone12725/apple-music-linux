package diskcache

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestPublicationResults(t *testing.T) {
	for _, mode := range []string{"success", "sync", "rename", "write"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := New(t.TempDir())
			w, _ := c.BeginStreamingPut("song", "alac")
			r := w.NewReader()
			defer r.Close()
			failure := errors.New("injected " + mode + " failure")
			if mode == "sync" {
				c.syncFile = func(*os.File) error { return failure }
			}
			if mode == "rename" {
				c.renameFile = func(string, string) error { return failure }
			}
			if mode == "write" {
				// The actual os.File.Write boundary fails, rather than only a producer return value.
				if err := w.file.Close(); err != nil {
					t.Fatal(err)
				}
				_, failure = w.Write([]byte("audio"))
				if failure == nil {
					t.Fatal("expected write error")
				}
			} else if _, err := w.Write([]byte("audio")); err != nil {
				t.Fatal(err)
			}
			err := w.Commit()
			want := failure
			if mode == "success" {
				want = nil
			}
			if !errors.Is(err, want) || !errors.Is(w.pending.err, want) {
				t.Fatalf("commit=%v pending=%v want=%v", err, w.pending.err, want)
			}
			if err := w.Commit(); !errors.Is(err, want) {
				t.Fatalf("repeat=%v", err)
			}
			w.Discard()
			data, readErr := io.ReadAll(r)
			if mode == "write" {
				if !errors.Is(readErr, failure) {
					t.Fatalf("source error became EOF: %v", readErr)
				}
			} else if string(data) != "audio" || readErr != nil {
				t.Fatalf("publication broke bytes: %q %v", data, readErr)
			}
			if f, hit := c.Get("song", "alac"); hit != (mode == "success") {
				t.Fatalf("cache hit=%v", hit)
			} else if f != nil {
				f.Close()
			}
			if w.refs.Load() != 1 {
				t.Fatalf("refs=%d", w.refs.Load())
			}
			select {
			case <-w.pending.done:
			default:
				t.Fatal("waiter not notified")
			}
		})
	}
}

func TestPublicationKeepsReservationDuringSync(t *testing.T) {
	c, _ := New(t.TempDir())
	w, _ := c.BeginStreamingPut("song", "alac")
	entered, resume := make(chan struct{}), make(chan struct{})
	original := c.syncFile
	c.syncFile = func(f *os.File) error { close(entered); <-resume; return original(f) }
	result := make(chan error, 1)
	go func() { result <- w.Commit() }()
	<-entered
	if other, err := c.BeginPut("song", "alac"); other != nil || err != nil {
		t.Fatalf("duplicate=%v %v", other, err)
	}
	close(resume)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestPutSyncFailureNotifiesWaiter(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _ := New(t.TempDir())
		w, _ := c.BeginPut("song", "alac")
		failure := errors.New("flush failed")
		c.syncFile = func(*os.File) error { return failure }
		result := make(chan error, 1)
		go func() { result <- c.WaitForWriter(t.Context(), "song", "alac") }()
		synctest.Wait()
		if err := w.Commit(); !errors.Is(err, failure) {
			t.Fatal(err)
		}
		if err := <-result; !errors.Is(err, failure) {
			t.Fatalf("waiter=%v", err)
		}
		if _, hit := c.Get("song", "alac"); hit {
			t.Fatal("published failed flush")
		}
	})
}

func staleFixture(t *testing.T, c *Cache) (string, os.FileInfo, time.Time) {
	t.Helper()
	name := "song-alac.m4a.tmp"
	path := filepath.Join(c.dir, name)
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return name, info, time.Now().Add(-staleTmpAge)
}

func TestCleanupPreservesClaimedWriter(t *testing.T) {
	c, _ := New(t.TempDir())
	name, info, cutoff := staleFixture(t, c)
	w, _ := c.BeginStreamingPut("song", "alac")
	r := w.NewReader()
	defer r.Close()
	if _, err := w.Write([]byte("new audio")); err != nil {
		t.Fatal(err)
	}
	if err := c.removeStaleTmp(name, info, cutoff); err != nil {
		t.Fatal(err)
	}
	if err := w.Commit(); err != nil {
		t.Fatal(err)
	}
	if data, err := io.ReadAll(r); string(data) != "new audio" || err != nil {
		t.Fatalf("read=%q %v", data, err)
	}
}

func TestCleanupRechecksReplacedFile(t *testing.T) {
	c, _ := New(t.TempDir())
	name, info, cutoff := staleFixture(t, c)
	replacement := filepath.Join(c.dir, "replacement")
	if err := os.WriteFile(replacement, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Keep the replacement stale too: timestamp alone must not authorize deletion.
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, filepath.Join(c.dir, name)); err != nil {
		t.Fatal(err)
	}
	if err := c.removeStaleTmp(name, info, cutoff); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(c.dir, name)); err != nil || string(data) != "new" {
		t.Fatalf("replacement deleted: %q %v", data, err)
	}
}

func TestCleanupReservationAndFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				c, _ := New(t.TempDir())
				name, info, cutoff := staleFixture(t, c)
				entered, resume := make(chan struct{}), make(chan struct{})
				failure := errors.New("remove failed")
				c.removeFile = func(path string) error {
					close(entered)
					<-resume
					if fail {
						return failure
					}
					return os.Remove(path)
				}
				result := make(chan error, 1)
				go func() { result <- c.removeStaleTmp(name, info, cutoff) }()
				<-entered
				var release sync.Once
				defer release.Do(func() { close(resume) })
				if w, err := c.BeginPut("song", "alac"); w != nil || err != nil {
					t.Fatalf("claim during cleanup=%v %v", w, err)
				}
				other, _ := c.BeginPut("other", "alac")
				if other == nil {
					t.Fatal("unrelated key blocked")
				}
				other.Discard()
				waiter := make(chan error, 1)
				go func() { waiter <- c.WaitForWriter(t.Context(), "song", "alac") }()
				synctest.Wait()
				select {
				case <-waiter:
					t.Fatal("waiter did not wait")
				default:
				}
				release.Do(func() { close(resume) })
				want := error(nil)
				if fail {
					want = failure
				}
				if err := <-result; !errors.Is(err, want) {
					t.Fatalf("cleanup=%v", err)
				}
				if err := <-waiter; !errors.Is(err, want) {
					t.Fatalf("waiter=%v", err)
				}
				w, err := c.BeginPut("song", "alac")
				if w == nil || err != nil {
					t.Fatalf("reservation retained: %v", err)
				}
				w.Discard()
			})
		})
	}
}

func TestCleanupSkipsUnownedLeaves(t *testing.T) {
	c, _ := New(t.TempDir())
	names := []string{"notes.tmp", "notes.m4a.tmp", "../outside"}
	for _, name := range names[:2] {
		path := filepath.Join(c.dir, name)
		if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-48 * time.Hour)
		_ = os.Chtimes(path, old, old)
	}
	c.sweepStaleTmp()
	for _, name := range names[:2] {
		if _, err := os.Stat(filepath.Join(c.dir, name)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSpoolWriteFailureCannotBecomeEOF(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "spool")
	if err != nil {
		t.Fatal(err)
	}
	w := NewStreamingFile(f)
	r := w.NewReader()
	defer r.Close()
	_ = f.Close()
	_, first := w.Write([]byte("audio"))
	if first == nil {
		t.Fatal("missing write error")
	}
	w.FinishFile(nil)
	if _, err := io.ReadAll(r); !errors.Is(err, first) {
		t.Fatalf("lost source failure: %v", err)
	}
}

func TestOldReaderSurvivesNewWriter(t *testing.T) {
	for _, commit := range []bool{false, true} {
		t.Run(map[bool]string{false: "discard", true: "commit"}[commit], func(t *testing.T) {
			c, _ := New(t.TempDir())
			old, _ := c.BeginStreamingPut("song", "alac")
			reader := old.NewReader()
			defer reader.Close()
			if _, err := old.Write([]byte("old audio")); err != nil {
				t.Fatal(err)
			}
			if commit {
				if err := old.Commit(); err != nil {
					t.Fatal(err)
				}
			} else {
				old.Discard()
			}
			newer, _ := c.BeginStreamingPut("song", "alac")
			if newer == nil {
				t.Fatal("new writer not claimed")
			}
			if _, err := newer.Write([]byte("new audio")); err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			if string(data) != "old audio" || (err == nil) != commit {
				t.Fatalf("old reader=%q %v", data, err)
			}
			reader.Close()
			if err := newer.Commit(); err != nil {
				t.Fatal(err)
			}
			f, ok := c.Get("song", "alac")
			if !ok {
				t.Fatal("new cache missing")
			}
			defer f.Close()
			data, err = io.ReadAll(f)
			if string(data) != "new audio" || err != nil {
				t.Fatalf("new reader=%q %v", data, err)
			}
		})
	}
}
