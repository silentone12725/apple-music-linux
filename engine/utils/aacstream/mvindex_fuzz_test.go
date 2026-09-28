package aacstream

import (
	"encoding/binary"
	"testing"
	"time"
)

func fzBox(typ string, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	copy(b[4:], typ)
	copy(b[8:], payload)
	return b
}

// FuzzMVLiveIndex feeds arbitrary bytes (as FFmpeg output would arrive, split
// at arbitrary points) and exercises every query; none may panic.
func FuzzMVLiveIndex(f *testing.F) {
	seed := append(fzBox("ftyp", []byte("isom\x00\x00\x02\x00")), fzBox("moov", nil)...)
	seed = append(seed, fzBox("moof", fzBox("traf", nil))...)
	seed = append(seed, fzBox("mdat", make([]byte, 32))...)
	f.Add(seed, uint8(7))
	f.Add([]byte{0, 0, 0, 1, 'm', 'o', 'o', 'f', 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, uint8(3))
	f.Fuzz(func(t *testing.T, data []byte, split uint8) {
		ix := NewMVLiveIndex()
		step := int(split)%64 + 1
		for i := 0; i < len(data); i += step {
			end := min(i+step, len(data))
			ix.Write(data[i:end])
		}
		w := int64(len(data))
		ix.InitSize()
		ix.Lookup(1.5)
		ix.LookupComplete(1.5, w)
		ix.FragByIndex(0, w)
		ix.FragByIndex(-1, w)
		ix.FragOffByIndex(0)
		ix.FragEndByIndex(0)
		ix.FragIndexForTime(1.5, w)
		ix.AllFragTimings()
		ix.Finalize(w)
		ix.FragCount()
		ix.Timescale()
	})
}

// An empty (header-only) box must be consumed, not re-read forever.
func TestMVLiveIndexEmptyBoxTerminates(t *testing.T) {
	done := make(chan struct{})
	go func() {
		ix := NewMVLiveIndex()
		ix.Write(fzBox("free", nil))
		ix.Write(append(fzBox("moov", nil), fzBox("moof", nil)...))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("indexer spun forever on a header-only box")
	}
}
