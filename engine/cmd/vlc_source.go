package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"engine/core/diskcache"
)

// A transient source buffers only this playback, not a persistent cache entry.
// Reuse StreamingReader so VLC retains byte seeks even before download finishes.
type transientVLCSource struct {
	*diskcache.StreamingReader
	cancel  context.CancelFunc
	release func()
	once    sync.Once
	done    chan struct{}
	writer  *transientWriter
}

func newTransientVLCSource(parent context.Context, produce func(context.Context, io.Writer) error) (*transientVLCSource, error) {
	var w *diskcache.StreamingPutWriter
	var finish func(error)
	cleanup := func() {}
	if runtime.GOOS == "linux" {
		f, err := openAnonymousVLCFile(os.TempDir())
		if err != nil {
			return nil, err
		}
		w = diskcache.NewStreamingFile(f)
		finish = w.FinishFile
	} else {
		// Preserve the existing named-spool behavior on non-Linux platforms.
		dir, err := os.MkdirTemp("", "adam-vlc-")
		if err != nil {
			return nil, err
		}
		cache, err := diskcache.New(dir)
		if err != nil {
			cleanupTransientDir(dir, os.RemoveAll)
			return nil, err
		}
		w, err = cache.BeginStreamingPut("audio", "transient")
		if err != nil {
			cleanupTransientDir(dir, os.RemoveAll)
			return nil, err
		}
		cleanup = func() { cleanupTransientDir(dir, os.RemoveAll) }
		finish = func(err error) {
			if err != nil {
				w.Discard()
			} else {
				_ = w.Commit()
			}
		}
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Minute)
	var owners atomic.Int32
	owners.Store(2) // producer and VLC reader; remove only after both close
	release := func() {
		if owners.Add(-1) == 0 {
			cleanup()
		}
	}
	writer := &transientWriter{ctx: ctx, cancel: cancel, dst: w}
	src := &transientVLCSource{StreamingReader: w.NewReader(), cancel: cancel, release: release, done: make(chan struct{}), writer: writer}
	go func() {
		defer close(src.done)
		defer release()
		defer cancel()
		err := produce(ctx, writer)
		writer.mu.Lock()
		if writer.err != nil {
			err = writer.err
		} else if err == nil {
			err = ctx.Err()
		}
		writer.mu.Unlock()
		finish(err)
	}()
	return src, nil
}

func (s *transientVLCSource) Abort() {
	s.cancel()
	s.StreamingReader.Abort()
	// Wait for an in-flight write, then latch cancellation without replacing
	// an earlier disk error. Later writes must keep returning that first error.
	s.writer.mu.Lock()
	if s.writer.err == nil {
		s.writer.err = s.writer.ctx.Err()
	}
	s.writer.mu.Unlock()
}

// No audio is written while this file has a directory entry. Root pins the
// temporary directory, O_EXCL rejects symlinks/collisions, and Remove only
// unlinks this newly-created leaf. We never scan or recursively delete /tmp.
func openAnonymousVLCFile(dir string) (*os.File, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("open VLC spool directory: %w", err)
	}
	defer root.Close()
	name := "adam-vlc-" + rand.Text()
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create VLC spool: %w", err)
	}
	if err := root.Remove(name); err != nil {
		f.Close()
		// This file is still empty; do not start a producer or retry deletion
		// through an unpinned pathname if unlinking could not be completed.
		log.Printf("[vlc] temporary spool unlink failed before playback: %v", err)
		return nil, fmt.Errorf("unlink VLC spool before playback: %w", err)
	}
	// Verify the opened inode itself: a replaced directory entry must not
	// leave the real file linked under another name before audio is written.
	if err := validateAnonymousVLCFile(f); err != nil {
		f.Close()
		log.Printf("[vlc] temporary spool validation failed before playback: %v", err)
		return nil, err
	}
	return f, nil
}

func cleanupTransientDir(dir string, removeAll func(string) error) {
	if err := removeAll(dir); err != nil {
		log.Printf("[vlc] temporary source cleanup failed: %v", err)
	}
}

// The producer is a single writer. Serialize it with Abort, latch the first
// I/O error (including a short write), and reject every subsequent write even
// if the upstream producer ignores that error or cancellation.
type transientWriter struct {
	mu     sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	dst    io.Writer
	err    error
}

func (w *transientWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return 0, w.err
	}
	if err := w.ctx.Err(); err != nil {
		w.err = err
		return 0, err
	}
	n, err := w.dst.Write(p)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	if err != nil {
		w.err = err
		w.cancel()
	}
	return n, err
}

func (s *transientVLCSource) Close() {
	s.once.Do(func() {
		s.Abort()
		s.StreamingReader.Close()
		s.release()
	})
}
