package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"engine/core/diskcache"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
)

func TestInvalidateALACCacheRemovesOnlyALACFilesOnce(t *testing.T) {
	dir := t.TempDir()
	keep := []string{"123-aac.m4a", "456.mp4", "notes.txt"}
	drop := []string{"123-alac.m4a", "789-alac.m4a"}
	for _, n := range append(append([]string{}, keep...), drop...) {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600)
	}
	os.WriteFile(filepath.Join(dir, "in-progress-alac.m4a.tmp"), []byte("x"), 0o600)

	invalidateALACCacheIfStale(dir)

	for _, n := range drop {
		if _, err := os.Stat(filepath.Join(dir, n)); !os.IsNotExist(err) {
			t.Errorf("%s from an older decrypt path must be deleted", n)
		}
	}
	for _, n := range append(keep, "in-progress-alac.m4a.tmp") {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%s must be kept: %v", n, err)
		}
	}
	ver, _ := os.ReadFile(filepath.Join(dir, ".alac_ver"))
	if strings.TrimSpace(string(ver)) != alacCacheVersion {
		t.Fatalf("version marker = %q, want %q", ver, alacCacheVersion)
	}

	// Files committed after the migration survive later startups.
	fresh := filepath.Join(dir, "999-alac.m4a")
	os.WriteFile(fresh, []byte("x"), 0o600)
	invalidateALACCacheIfStale(dir)
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a current-version cache file was deleted on the next start: %v", err)
	}
}

type playback02Provider struct{ source pipeline.Source }

func (p playback02Provider) Open(context.Context, media.OpenRequest) (*media.Session, error) {
	return &media.Session{Kind: "song", Metadata: media.Metadata{DurationMs: 200000}, Tracks: []media.Track{{
		Kind: pipeline.KindAudio, Codec: pipeline.CodecALAC,
		Open: func(context.Context) (*pipeline.Stream, error) {
			return &pipeline.Stream{Source: p.source, Kind: pipeline.KindAudio, Codec: pipeline.CodecALAC}, nil
		},
	}}}, nil
}

type playback02Source func(context.Context, io.Writer) error

func (f playback02Source) Stream(ctx context.Context, w io.Writer) error { return f(ctx, w) }

func playback02Server(t *testing.T, source pipeline.Source, cached bool) (*APIServer, *playback.Session, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	s := &APIServer{shutdownCtx: ctx, alac: newALACGate(), pm: playback.NewWithProvider(playback02Provider{source})}
	s.installReleaseHook()
	if cached {
		var err error
		s.diskCache, err = diskcache.New(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
	}
	sess, err := s.pm.Open(ctx, playback.OpenRequest{AssetID: "offline-alac", Lossless: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.pm.Release(sess.ID) })
	return s, sess, cancel
}

func TestPlayback02PrecacheSharedReader(t *testing.T) {
	for _, name := range []string{"in progress", "completed", "failed", "canceled", "session released"} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			started, finish := make(chan struct{}), make(chan struct{})
			source := playback02Source(func(ctx context.Context, w io.Writer) error {
				calls.Add(1)
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) < 9*time.Minute || time.Until(deadline) > 10*time.Minute {
					t.Error("precache lost its original 10 minute timeout")
				}
				if _, err := io.WriteString(w, "head"); err != nil {
					return err
				}
				close(started)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-finish:
				}
				if name == "failed" {
					return errors.New("offline decrypt failure")
				}
				_, err := io.WriteString(w, "tail")
				return err
			})
			s, sess, cancel := playback02Server(t, source, true)
			reqCtx, reqCancel := context.WithCancel(t.Context())
			r := httptest.NewRequest(http.MethodPost, "/precache", nil).WithContext(reqCtx)
			r.SetPathValue("id", sess.ID)
			rec := httptest.NewRecorder()
			s.handlePlaybackPrecache(rec, r)
			reqCancel() // closing the initiating request must not cancel the download
			if rec.Code != http.StatusAccepted {
				t.Fatalf("precache status = %d", rec.Code)
			}
			<-started
			if s.diskCache.GetStreaming(sess.AssetID, sess.Codec) == nil {
				t.Fatal("precache writer not published")
			}
			if name == "completed" {
				w := s.diskCache.GetStreaming(sess.AssetID, sess.Codec)
				pin := w.NewReader()
				close(finish)
				if _, err := io.ReadAll(pin); err != nil {
					t.Fatal(err)
				}
				pin.Close()
			}
			src, err := s.openVLCSource(t.Context(), sess.ID, sess.AssetID, sess.Codec)
			if err != nil || src == nil {
				t.Fatalf("source = %v, %v", src, err)
			}
			defer src.Close()
			if name == "session released" {
				s.pm.Release(sess.ID)
			}
			if name == "canceled" {
				cancel()
			} else if name != "completed" {
				close(finish)
			}
			b, err := io.ReadAll(src)
			failed := name == "failed" || name == "canceled"
			if failed {
				if err == nil || errors.Is(err, io.EOF) {
					t.Fatalf("failure became EOF: %q, %v", b, err)
				}
			} else if err != nil || string(b) != "headtail" {
				t.Fatalf("read = %q, %v", b, err)
			}
			if calls.Load() != 1 {
				t.Fatalf("download count = %d", calls.Load())
			}
		})
	}
}

func TestPlayback02FirstPlayAndNoPersistentCache(t *testing.T) {
	for _, name := range []string{"enabled", "disabled", "unavailable"} {
		t.Run(name, func(t *testing.T) {
			cached := name != "disabled"
			var calls atomic.Int32
			s, sess, _ := playback02Server(t, playback02Source(func(_ context.Context, w io.Writer) error {
				calls.Add(1)
				_, err := io.WriteString(w, "offline audio")
				return err
			}), cached)
			if name == "unavailable" {
				broken := filepath.Join(t.TempDir(), "cache")
				s.diskCache, _ = diskcache.New(broken)
				if err := os.Remove(broken); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(broken, []byte("not a directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for range 3 {
				src, err := s.openVLCSource(t.Context(), sess.ID, sess.AssetID, sess.Codec)
				if err != nil || src == nil {
					t.Fatalf("open: %v", err)
				}
				b, err := io.ReadAll(src)
				if _, seekErr := src.Seek(0, io.SeekStart); seekErr != nil {
					t.Fatal(seekErr)
				}
				src.Close()
				if err != nil || string(b) != "offline audio" {
					t.Fatalf("read: %q, %v", b, err)
				}
			}
			want := int32(1)
			if name != "enabled" {
				want = 3
			}
			if calls.Load() != want {
				t.Fatalf("downloads = %d, want %d", calls.Load(), want)
			}
		})
	}
}

func TestPlayback02WriterContentionHonorsCancellation(t *testing.T) {
	s, sess, _ := playback02Server(t, playback02Source(func(context.Context, io.Writer) error {
		t.Error("started duplicate download")
		return nil
	}), true)
	w, err := s.diskCache.BeginPut(sess.AssetID, sess.Codec)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Discard()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	src, err := s.openVLCSource(ctx, sess.ID, sess.AssetID, sess.Codec)
	if src != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("source = %v, error = %v", src, err)
	}
}

func TestPlayback02WriterContentionCompletion(t *testing.T) {
	for _, name := range []string{"commit", "discard", "deadline"} {
		t.Run(name, func(t *testing.T) {
			s, sess, _ := playback02Server(t, playback02Source(func(context.Context, io.Writer) error {
				t.Error("started a second download while another writer owned the key")
				return nil
			}), true)
			synctest.Test(t, func(t *testing.T) {
				w, err := s.diskCache.BeginPut(sess.AssetID, sess.Codec)
				if err != nil {
					t.Fatal(err)
				}
				defer w.Discard()
				done := make(chan error, 1)
				go func() {
					src, err := s.openVLCSource(t.Context(), sess.ID, sess.AssetID, sess.Codec)
					if err == nil {
						defer src.Close()
						b, readErr := io.ReadAll(src)
						if readErr != nil {
							err = readErr
						} else if string(b) != "committed" {
							err = errors.New("incorrect committed bytes")
						}
					}
					done <- err
				}()
				synctest.Wait()
				select {
				case <-done:
					t.Fatal("load did not wait for the existing writer")
				default:
				}
				switch name {
				case "commit":
					_, _ = io.WriteString(w, "committed")
					if err := w.Commit(); err != nil {
						t.Fatal(err)
					}
				case "discard":
					w.Discard()
				}
				err = <-done
				if name == "commit" && err != nil {
					t.Fatal(err)
				}
				if name == "discard" && err == nil {
					t.Fatal("discard became successful playback")
				}
				if name == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("deadline error = %v", err)
				}
			})
		})
	}
}

func TestInvalidateALACCacheToleratesMissingDir(t *testing.T) {
	invalidateALACCacheIfStale(filepath.Join(t.TempDir(), "absent"))
}

// Without libvlc every VLC endpoint must answer 503, not panic on a nil player.
func TestVLCEndpointsWithoutLibVLC(t *testing.T) {
	s := &APIServer{}
	for name, h := range map[string]http.HandlerFunc{
		"load":   s.handleVLCLoad,
		"pause":  s.handleVLCPause,
		"resume": s.handleVLCResume,
		"time":   s.handleVLCTime,
		"seek":   s.handleVLCSeek,
		"stop":   s.handleVLCStop,
		"volume": s.handleVLCVolume,
	} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/vlc/"+name, strings.NewReader(`{"volume":50}`)))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status %d, want 503", name, rec.Code)
		}
	}
}

func TestHandshakeNoiseFilterDropsOnlyEOFHandshakes(t *testing.T) {
	var buf strings.Builder
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)
	f := handshakeNoiseFilter{}
	f.Write([]byte("2026/10/13 http: TLS handshake error from 127.0.0.1:45758: EOF\n"))
	if buf.Len() != 0 {
		t.Fatalf("EOF handshake noise was logged: %q", buf.String())
	}
	f.Write([]byte("2026/10/13 http: TLS handshake error from 127.0.0.1:1: tls: bad certificate\n"))
	f.Write([]byte("2026/10/13 http: panic serving 127.0.0.1:1: boom\n"))
	if !strings.Contains(buf.String(), "bad certificate") || !strings.Contains(buf.String(), "panic serving") {
		t.Fatalf("real server errors must pass through: %q", buf.String())
	}
}
