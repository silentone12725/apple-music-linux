//go:build cgo && integration

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"engine/core/playback"
	"engine/core/vlc"
)

func sharedGateWAV() []byte {
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+192000))
	b.WriteString("WAVEfmt ")
	for _, n := range []any{uint32(16), uint16(1), uint16(2), uint32(48000), uint32(192000), uint16(4), uint16(16)} {
		binary.Write(&b, binary.LittleEndian, n)
	}
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(192000))
	b.Write(make([]byte, 192000))
	return b.Bytes()
}

func TestPlayback02SharedWriterThroughVLCHandler(t *testing.T) {
	for _, mode := range []string{"commit", "discard", "cancel", "buffered", "completed"} {
		t.Run(mode, func(t *testing.T) {
			wav := sharedGateWAV()
			started, resume := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			s, a, cancel := playback02Server(t, playback02Source(func(ctx context.Context, w io.Writer) error {
				calls.Add(1)
				head := wav[:44]
				if mode == "buffered" {
					head = append(append([]byte{}, wav...), make([]byte, alacStartBytes)...)
				}
				if _, err := w.Write(head); err != nil {
					return err
				}
				close(started)
				select {
				case <-resume:
				case <-ctx.Done():
					return ctx.Err()
				}
				if mode == "discard" {
					return fmt.Errorf("offline producer failed")
				}
				if mode == "buffered" {
					return nil
				}
				_, err := w.Write(wav[44:])
				return err
			}), true)
			p, err := vlc.New()
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			p.SetVolume(0)
			s.vlcPlayer = p
			r := httptest.NewRequest(http.MethodPost, "/precache", nil)
			r.SetPathValue("id", a.ID)
			rec := httptest.NewRecorder()
			s.handlePlaybackPrecache(rec, r)
			if rec.Code != http.StatusAccepted {
				t.Fatal(rec.Code)
			}
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("producer did not start")
			}
			writer := s.diskCache.GetStreaming(a.AssetID, a.Codec)
			if writer == nil {
				t.Fatal("writer missing")
			}
			pin := writer.NewReader()
			defer pin.Close()
			data := make(chan struct {
				b   []byte
				err error
			}, 1)
			go func() {
				b, err := io.ReadAll(pin)
				data <- struct {
					b   []byte
					err error
				}{b, err}
			}()
			if mode == "completed" {
				close(resume)
				result := <-data
				if result.err != nil {
					t.Fatal(result.err)
				}
			}
			s.pm.Release(a.ID)
			s.pm.Release(a.ID)
			b, err := s.pm.Open(t.Context(), playback.OpenRequest{AssetID: a.AssetID, Lossless: true})
			if err != nil || b.ID == a.ID {
				t.Fatalf("new Session: %v", err)
			}
			defer s.pm.Release(b.ID)
			load := httptest.NewRecorder()
			s.handleVLCLoad(load, httptest.NewRequest(http.MethodPost, "/vlc/load", bytes.NewBufferString(fmt.Sprintf(`{"sessionId":%q}`, b.ID))))
			if load.Code != http.StatusOK {
				t.Fatalf("load=%d %s", load.Code, load.Body.String())
			}
			if mode == "completed" || mode == "buffered" {
				s.alac.mu.Lock()
				held := s.alac.held
				s.alac.mu.Unlock()
				if held {
					t.Fatal("already buffered/completed source held background downloads")
				}
			}
			if mode == "cancel" {
				cancel()
			} else if mode != "completed" {
				close(resume)
			}
			if mode != "completed" {
				select {
				case result := <-data:
					failed := mode == "cancel" || mode == "discard"
					if (result.err != nil) != failed {
						t.Fatalf("reader error=%v", result.err)
					}
					if !failed && mode != "buffered" && !bytes.Equal(result.b, wav) {
						t.Fatal("incorrect shared audio")
					}
				case <-time.After(3 * time.Second):
					t.Fatal("shared producer parked; must not wait for 15 second gate cap")
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("duplicate downloads: %d", calls.Load())
			}
			if mode != "buffered" {
				deadline := time.Now().Add(3 * time.Second)
				for !p.SourceEnded() && !p.SourceFailed() && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond) // observe libVLC's asynchronous callback result
				}
				failed := mode == "cancel" || mode == "discard"
				if p.SourceFailed() != failed || p.SourceEnded() == failed {
					t.Fatalf("native reader eof=%v failed=%v", p.SourceEnded(), p.SourceFailed())
				}
			}
			p.Stop()
			pin.Close()
		})
	}
}
