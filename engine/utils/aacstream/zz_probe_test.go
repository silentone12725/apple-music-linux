package aacstream

import (
	"encoding/binary"
	"fmt"
	"os"
	"testing"
)

func TestZZProbeSeekFile(t *testing.T) {
	p := os.Getenv("PROBE_FILE")
	if p == "" {
		t.Skip()
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	ix := NewMVLiveIndex()
	for i := 0; i < len(data); i += 7919 {
		e := i + 7919
		if e > len(data) {
			e = len(data)
		}
		ix.Write(data[i:e])
	}
	ix.Finalize(int64(len(data)))
	n := ix.FragCount()
	fmt.Println("frags", n, "bytes", len(data))
	var prevT float64
	for i := 0; i < n; i++ {
		off, _ := ix.FragOffByIndex(i)
		lim, ok := ix.FragLimitByIndex(i)
		end, eok := ix.FragEndByIndex(i)
		typ := string(data[off+4 : off+8])
		mdatAt := int64(-1)
		moofSz := int64(binary.BigEndian.Uint32(data[off : off+4]))
		if off+moofSz+8 <= int64(len(data)) {
			mdatAt = off + moofSz
		}
		bad := ""
		if typ != "moof" {
			bad += " NOT-MOOF"
		}
		if !ok || !eok || lim != end {
			bad += fmt.Sprintf(" limit=%d(ok=%v) end=%d(ok=%v)", lim, ok, end, eok)
		}
		if mdatAt >= 0 && string(data[mdatAt+4:mdatAt+8]) != "mdat" {
			bad += " NO-MDAT-AFTER-MOOF"
		}
		timings := ix.AllFragTimings()
		tt := timings[i].T
		if i > 0 && tt <= prevT {
			bad += fmt.Sprintf(" NON-MONOTONIC-T %.3f<=%.3f", tt, prevT)
		}
		prevT = tt
		if bad != "" || (i >= 33 && i <= 38) {
			fmt.Printf("n=%d T=%.3f off=%d lim=%d len=%d%s\n", i, tt, off, lim, lim-off, bad)
		}
	}
}
