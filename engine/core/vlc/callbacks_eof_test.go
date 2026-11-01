//go:build cgo

package vlc

import (
	"bytes"
	"errors"
	"testing"
)

// errSource fails every read, like a download that broke or a reader that was aborted.
type errSource struct{ memSource }

func (errSource) Read([]byte) (int, error) { return 0, errors.New("download failed") }

// libvlc reaching its end only means the track's data ended when the source said so with a clean EOF. A failed read
// must not look like an end, and a seek must clear it.
func TestCallbackMediaTellsDataEndFromReadFailure(t *testing.T) {
	cm := newCallbackMedia(memSource{bytes.NewReader([]byte("abcd"))})
	defer cm.release()
	buf := make([]byte, 8)
	if n := cm.read(buf); n != 4 {
		t.Fatalf("first read = %d, want 4", n)
	}
	if cm.eof.Load() {
		t.Fatal("eof set before the data was exhausted")
	}
	if n := cm.read(buf); n != 0 || !cm.eof.Load() {
		t.Fatalf("read at the end = %d, eof=%v; want 0, true", n, cm.eof.Load())
	}
	if cm.seekTo(0) != 0 || cm.eof.Load() {
		t.Fatalf("a seek must clear eof (eof=%v)", cm.eof.Load())
	}
	if n := cm.read(buf); n != 4 {
		t.Fatalf("read after seek = %d, want 4", n)
	}

	bad := newCallbackMedia(errSource{memSource{bytes.NewReader(nil)}})
	defer bad.release()
	if n := bad.read(buf); n != -1 || bad.eof.Load() {
		t.Fatalf("failed read = %d, eof=%v; want -1, false", n, bad.eof.Load())
	}
}
