//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

type abortWriteBoundary struct {
	entered chan struct{}
	resume  chan struct{}
	err     error
	short   bool
	calls   int
}

func (w *abortWriteBoundary) Write(p []byte) (int, error) {
	w.calls++
	close(w.entered)
	<-w.resume
	if w.short {
		return len(p) - 1, nil
	}
	if w.err != nil {
		return 0, w.err
	}
	return len(p), nil
}

func TestTransientVLCSourceAbortWaitsForInFlightWrite(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		short bool
	}{
		{"successful write", nil, false},
		{"ENOSPC", syscall.ENOSPC, false},
		{"EIO", syscall.EIO, false},
		{"short write", io.ErrShortWrite, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dst := &abortWriteBoundary{entered: make(chan struct{}), resume: make(chan struct{}), err: tc.err, short: tc.short}
			writeDone := make(chan error, 1)
			src, err := newTransientVLCSource(t.Context(), func(_ context.Context, writer io.Writer) error {
				writer.(*transientWriter).dst = dst
				_, err := writer.Write([]byte("audio"))
				writeDone <- err
				return nil // ignored errors must still reach the reader
			})
			if err != nil {
				t.Fatal(err)
			}
			// Also unblock the fake disk on an assertion failure, before Close waits.
			defer src.Close()
			defer func() {
				select {
				case <-dst.resume:
				default:
					close(dst.resume)
				}
			}()
			<-dst.entered // the actual Write holds the mutex inside the disk call
			aborted := make(chan struct{})
			go func() { src.Abort(); close(aborted) }()
			<-src.writer.ctx.Done() // Abort has begun cancellation
			select {
			case <-aborted:
				t.Fatal("Abort returned while the disk Write was still blocked")
			case <-time.After(50 * time.Millisecond): // negative assertion, not a scheduling sleep
			}
			close(dst.resume)
			select {
			case <-aborted:
			case <-time.After(time.Second):
				t.Fatal("Abort did not return after the disk Write left its critical section")
			}
			if err := <-writeDone; !errors.Is(err, tc.err) {
				t.Fatalf("in-flight Write error = %v, want %v", err, tc.err)
			}
			<-src.done
			want := tc.err
			if want == nil {
				want = context.Canceled
			}
			src.writer.mu.Lock()
			latched := src.writer.err
			src.writer.mu.Unlock()
			if !errors.Is(latched, want) {
				t.Fatalf("latched error = %v, want %v", latched, want)
			}
			if n, err := src.writer.Write([]byte("late")); n != 0 || !errors.Is(err, want) || dst.calls != 1 {
				t.Fatalf("write after Abort = %d, %v; disk calls=%d", n, err, dst.calls)
			}
			// Observe producer completion independently of the aborted reader.
			reader := src.StreamingReader.Writer().NewReader()
			defer reader.Close()
			if _, err := io.ReadAll(reader); !errors.Is(err, want) {
				t.Fatalf("producer completion lost the original error: %v", err)
			}
		})
	}
}

func TestAnonymousVLCFileOwnershipAndUnlink(t *testing.T) {
	dir := t.TempDir()
	f, err := openAnonymousVLCFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 0 || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("spool is not a private unlinked file: uid=%d links=%d mode=%o", stat.Uid, stat.Nlink, info.Mode().Perm())
	}
	if _, err := f.WriteString("synthetic audio"); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("visible audio remains: %v, %v", entries, err)
	}
}

func TestAnonymousVLCFileRejectsRenamedLinkedInode(t *testing.T) {
	dir := t.TempDir()
	f, err := os.CreateTemp(dir, "owned-")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	renamed := filepath.Join(dir, "moved-before-unlink")
	if err := os.Rename(f.Name(), renamed); err != nil {
		t.Fatal(err)
	}
	if err := validateAnonymousVLCFile(f); err == nil {
		t.Fatal("accepted an inode still linked under a different pathname")
	}
	if err := os.Remove(renamed); err != nil {
		t.Fatal(err)
	}
	if err := validateAnonymousVLCFile(f); err != nil {
		t.Fatal(err)
	}
}

type transientFailWriter struct {
	err   error
	calls int
	short bool
}

func (w *transientFailWriter) Write(p []byte) (int, error) {
	w.calls++
	if w.short {
		return len(p) - 1, nil
	}
	return 0, w.err
}

func TestTransientVLCSourceLatchesDiskError(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		short bool
	}{
		{"ENOSPC", syscall.ENOSPC, false}, {"EIO", syscall.EIO, false}, {"short write", io.ErrShortWrite, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dst := &transientFailWriter{err: tc.err, short: tc.short}
			src, err := newTransientVLCSource(t.Context(), func(ctx context.Context, writer io.Writer) error {
				writer.(*transientWriter).dst = dst // inject the actual disk-write boundary
				for range 2 {
					if _, err := writer.Write([]byte("audio")); !errors.Is(err, tc.err) {
						t.Errorf("write error = %v", err)
					}
				}
				if ctx.Err() == nil {
					t.Error("disk error did not cancel producer context")
				}
				return nil // even an upstream producer ignoring errors cannot turn this into EOF
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = io.ReadAll(src)
			if !errors.Is(err, tc.err) {
				t.Fatalf("reader lost original disk error: %v", err)
			}
			src.Close()
			<-src.done
			if dst.calls != 1 {
				t.Fatalf("disk writes continued after failure: %d", dst.calls)
			}
		})
	}
}

func TestTransientVLCSourceCancellationCannotBecomeEOF(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	src, err := newTransientVLCSource(ctx, func(ctx context.Context, w io.Writer) error {
		<-ctx.Done()
		if n, err := w.Write([]byte("late")); n != 0 || !errors.Is(err, context.Canceled) {
			t.Errorf("write after cancellation = %d, %v", n, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	cancel()
	if b, err := io.ReadAll(src); len(b) != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation became EOF or wrote bytes: %q, %v", b, err)
	}
	<-src.done
}

func TestTransientVLCSourceCrashLeavesNoAudioPath(t *testing.T) {
	if os.Getenv("ADAM_TRANSIENT_CRASH_TEST") == "1" {
		started := make(chan struct{})
		src, err := newTransientVLCSource(context.Background(), func(ctx context.Context, w io.Writer) error {
			if _, err := io.WriteString(w, "synthetic decrypted audio"); err != nil {
				return err
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		})
		if err != nil {
			t.Fatal(err)
		}
		<-started
		fmt.Fprintln(os.Stdout, "ready")
		<-src.done // parent kills the process, bypassing Close and all defers
		return
	}
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	live, err := newTransientVLCSource(t.Context(), func(_ context.Context, w io.Writer) error {
		_, err := io.WriteString(w, "other live source")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	<-live.done // its reader still owns the audio while the child is killed
	legacy := filepath.Join(root, "adam-vlc-legacy")
	if err := os.Mkdir(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(legacy, "untouched")
	if err := os.WriteFile(sentinel, []byte("other instance or legacy data"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "adam-vlc-symlink")); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestTransientVLCSourceCrashLeavesNoAudioPath$")
	cmd.Env = append(os.Environ(), "ADAM_TRANSIENT_CRASH_TEST=1", "TMPDIR="+root)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatalf("child did not prepare audio: %s", stderr.String())
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("child unexpectedly exited normally")
	}
	if b, err := io.ReadAll(live); err != nil || string(b) != "other live source" {
		t.Fatalf("other live source affected by child exit: %q, %v", b, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatalf("crash left an audio pathname: %v, %v", entries, err)
	}
	if b, err := os.ReadFile(sentinel); err != nil || string(b) != "other instance or legacy data" {
		t.Fatalf("unrelated data modified: %q, %v", b, err)
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("symlink target modified: %v, %v", entries, err)
	}
}
