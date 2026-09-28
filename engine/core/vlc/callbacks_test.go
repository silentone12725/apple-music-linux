package vlc

import (
	"bytes"
	"encoding/binary"
	"io"
	"sync"
	"testing"
	"time"
)

type memSource struct{ *bytes.Reader }

func (m memSource) Size() int64 { return m.Reader.Size() }
func (memSource) Abort()        {}
func (memSource) Close()        {}

// blockingSource never yields data until aborted — models VLC reading ahead
// of an in-progress download.
type blockingSource struct {
	once   sync.Once
	abort  chan struct{}
	closed bool
}

func (b *blockingSource) Read([]byte) (int, error) {
	<-b.abort
	return 0, io.ErrUnexpectedEOF
}
func (b *blockingSource) Seek(off int64, _ int) (int64, error) { return off, nil }
func (b *blockingSource) Size() int64                          { return -1 }
func (b *blockingSource) Abort()                               { b.once.Do(func() { close(b.abort) }) }
func (b *blockingSource) Close()                               { b.closed = true }

func silentWAV(seconds int) []byte {
	const rate, ch, bits = 48000, 2, 16
	data := rate * ch * bits / 8 * seconds
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+data))
	buf.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(ch), uint32(rate),
		uint32(rate * ch * bits / 8), uint16(ch * bits / 8), uint16(bits)} {
		binary.Write(&buf, binary.LittleEndian, v)
	}
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(data))
	buf.Write(make([]byte, data))
	return buf.Bytes()
}

func newTestPlayer(t *testing.T) *Player {
	t.Helper()
	p, err := New()
	if err != nil {
		t.Skipf("libvlc unavailable: %v", err)
	}
	p.SetVolume(0)
	return p
}

func TestLoadSourcePlaysFromCallbacks(t *testing.T) {
	p := newTestPlayer(t)
	defer p.Close()
	if err := p.LoadSource(memSource{bytes.NewReader(silentWAV(3))}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, length, state := p.Time(); state == "playing" && length > 0 {
			if length < 2500 || length > 3500 {
				t.Fatalf("length = %dms, want ~3000ms", length)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	_, length, state := p.Time()
	t.Fatalf("never reached playing: state=%s length=%d", state, length)
}

func TestStopUnblocksPendingRead(t *testing.T) {
	p := newTestPlayer(t)
	defer p.Close()
	src := &blockingSource{abort: make(chan struct{})}
	if err := p.LoadSource(src); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // let the input thread block in Read
	stopped := make(chan struct{})
	go func() { p.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop deadlocked on a blocked read callback")
	}
	if !src.closed {
		t.Fatal("source not closed after Stop")
	}
}

func TestLoadSourceReplacesPrevious(t *testing.T) {
	p := newTestPlayer(t)
	defer p.Close()
	first := &blockingSource{abort: make(chan struct{})}
	if err := p.LoadSource(first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	done := make(chan error, 1)
	go func() { done <- p.LoadSource(memSource{bytes.NewReader(silentWAV(1))}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LoadSource deadlocked replacing a blocked source")
	}
	if !first.closed {
		t.Fatal("previous source not closed")
	}
}
