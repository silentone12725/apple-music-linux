package diskcache

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newCloseTestWriter(t *testing.T) *StreamingPutWriter {
	t.Helper()
	cache, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sw, err := cache.BeginStreamingPut("close-contract", "alac")
	if err != nil || sw == nil {
		t.Fatalf("BeginStreamingPut: writer=%v err=%v", sw, err)
	}
	t.Cleanup(func() {
		sw.mu.Lock()
		done := sw.done
		sw.mu.Unlock()
		if !done {
			sw.Discard()
		}
		// Failure-path cleanup only; assertions below check closure before this.
		sw.file.Close()
	})
	return sw
}

func checkCloseReferences(t *testing.T, sw *StreamingPutWriter, want int32) {
	t.Helper()
	if got := sw.refs.Load(); got != want {
		t.Errorf("references = %d, want %d", got, want)
	}
	_, err := sw.file.Stat()
	if want == 0 {
		if !errors.Is(err, os.ErrClosed) {
			t.Errorf("last reference did not close descriptor: %v", err)
		}
	} else if err != nil {
		t.Errorf("descriptor closed with live owners: %v", err)
	}
}

func closeConcurrently(reader *StreamingReader) {
	const callers = 32
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			reader.Close()
		}()
	}
	close(start)
	wg.Wait()
}

func TestStreamingReaderCloseIdempotent(t *testing.T) {
	constructors := []struct {
		name   string
		new    func(*StreamingPutWriter) *StreamingReader
		offset int
	}{
		{"NewReader", (*StreamingPutWriter).NewReader, 0},
		{"NewReaderAt", func(sw *StreamingPutWriter) *StreamingReader { return sw.NewReaderAt(3) }, 3},
		{"NewReaderIfActive", (*StreamingPutWriter).NewReaderIfActive, 0},
	}
	for _, constructor := range constructors {
		for _, mode := range []string{"single", "repeated", "concurrent", "abort-repeated"} {
			t.Run(constructor.name+"/"+mode, func(t *testing.T) {
				sw := newCloseTestWriter(t)
				want := []byte("shared audio bytes")
				if _, err := sw.Write(want); err != nil {
					t.Fatal(err)
				}
				a, b := constructor.new(sw), constructor.new(sw)
				if a == nil || b == nil {
					t.Fatal("active writer did not create both readers")
				}
				checkCloseReferences(t, sw, 3) // writer + A + B
				if err := sw.Commit(); err != nil {
					t.Fatal(err)
				}
				checkCloseReferences(t, sw, 2) // A + B
				if mode == "abort-repeated" {
					a.Abort()
					a.Abort()
					if _, err := a.Read(make([]byte, 1)); !errors.Is(err, ErrReaderAborted) {
						t.Errorf("aborted reader error = %v", err)
					}
					checkCloseReferences(t, sw, 2) // Abort does not release ownership.
				}
				switch mode {
				case "single":
					a.Close()
				case "concurrent":
					closeConcurrently(a)
				default:
					a.Close()
					a.Close()
				}
				checkCloseReferences(t, sw, 1) // only B
				got, err := io.ReadAll(b)
				if err != nil || !bytes.Equal(got, want[constructor.offset:]) {
					t.Errorf("B lost its live reference: got %q err=%v", got, err)
				}
				b.Close()
				checkCloseReferences(t, sw, 0)
				persisted, err := os.ReadFile(sw.finalPath)
				if err != nil || !bytes.Equal(persisted, want) {
					t.Errorf("Close changed committed cache: got %q err=%v", persisted, err)
				}
			})
		}
	}
}

func TestStreamingReaderCloseKeepsWriterReference(t *testing.T) {
	for _, terminal := range []string{"Commit", "Discard"} {
		t.Run(terminal, func(t *testing.T) {
			sw := newCloseTestWriter(t)
			a, b := sw.NewReader(), sw.NewReader()
			a.Close()
			a.Close()
			checkCloseReferences(t, sw, 2) // writer + B
			b.Close()
			checkCloseReferences(t, sw, 1) // writer still owns the descriptor.
			want := []byte("writer remains usable after readers close")
			if _, err := sw.Write(want); err != nil {
				t.Errorf("reader closed writer's descriptor: %v", err)
			}
			if terminal == "Commit" {
				if err := sw.Commit(); err != nil {
					t.Fatal(err)
				}
				got, err := os.ReadFile(sw.finalPath)
				if err != nil || !bytes.Equal(got, want) {
					t.Errorf("committed data = %q err=%v", got, err)
				}
			} else {
				sw.Discard()
				if _, err := os.Stat(sw.file.Name()); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("discarded temp file remains: %v", err)
				}
			}
			checkCloseReferences(t, sw, 0)
		})
	}
}

func TestStreamingReaderClosePreservesDiscardError(t *testing.T) {
	sw := newCloseTestWriter(t)
	want := []byte("partial audio")
	if _, err := sw.Write(want); err != nil {
		t.Fatal(err)
	}
	a, b := sw.NewReader(), sw.NewReader()
	sw.Discard()
	checkCloseReferences(t, sw, 2)
	a.Close()
	a.Close()
	checkCloseReferences(t, sw, 1)
	got, err := io.ReadAll(b)
	if !bytes.Equal(got, want) || !errors.Is(err, sw.writeErr) {
		t.Errorf("B must receive partial bytes and original Discard error: got %q err=%v", got, err)
	}
	b.Close()
	checkCloseReferences(t, sw, 0)
}

func TestStreamingReaderCloseCommittedWriterRelease(t *testing.T) {
	for _, order := range []string{"writer-first", "writer-last"} {
		t.Run(order, func(t *testing.T) {
			cache, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			want := []byte("already cached audio")
			path := filepath.Join(cache.dir, cache.filename("cached", "alac"))
			if err := os.WriteFile(path, want, 0o600); err != nil {
				t.Fatal(err)
			}
			sw, err := cache.NewFromCommitted("cached", "alac")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { sw.file.Close() })
			a, b := sw.NewReader(), sw.NewReaderAt(0)
			checkCloseReferences(t, sw, 3)
			if order == "writer-first" {
				sw.Release() // exactly one release of the writer's separate reference.
				checkCloseReferences(t, sw, 2)
			}
			a.Close()
			a.Close()
			remaining := int32(2)
			if order == "writer-first" {
				remaining = 1
			}
			checkCloseReferences(t, sw, remaining)
			got, err := io.ReadAll(b)
			if err != nil || !bytes.Equal(got, want) {
				t.Errorf("B lost committed source: got %q err=%v", got, err)
			}
			b.Close()
			checkCloseReferences(t, sw, remaining-1)
			if order == "writer-last" {
				sw.Release()
				checkCloseReferences(t, sw, 0)
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, want) {
				t.Errorf("Release must retain the cached file: got %q err=%v", got, err)
			}
		})
	}
}
