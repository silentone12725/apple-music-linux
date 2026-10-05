//go:build native_backend && itunlive

package main

import (
	"context"
	"encoding/binary"
	"io"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/itouakirai/mp4ff/mp4"
)

// Live check of the itun progressive-MV path against Apple, with the DRM session on disk.
// Opt-in: go test -tags "native_backend itunlive" -run TestItunLive ./cmd
// ITUN_ADAM selects the music video; ITUN_DRM_DIR the drm directory (holds files/).
func TestItunLive(t *testing.T) {
	adamStr := os.Getenv("ITUN_ADAM")
	drmDir := os.Getenv("ITUN_DRM_DIR")
	if adamStr == "" || drmDir == "" {
		t.Skip("ITUN_ADAM / ITUN_DRM_DIR not set")
	}
	adam, err := strconv.ParseUint(adamStr, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	s := NewAPIServer(0, ServerConfig{DRMBinaryPath: drmDir, DRMBaseDir: drmDir + "/files"})
	if s.dm == nil {
		t.Fatal("no DRM manager (native_backend tag?)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()

	t0 := time.Now()
	cdnURL, dk, err := s.dm.GetProgressiveMVURL(ctx, adam)
	if err != nil {
		t.Fatalf("GetProgressiveMVURL: %v", err)
	}
	u, perr := url.Parse(cdnURL)
	if perr != nil {
		t.Fatalf("progressive URL does not parse: %v", perr)
	}
	// Host and path only: the query carries signed access parameters.
	t.Logf("progressive URL in %s: host=%s path=%s queryLen=%d downloadKeyLen=%d",
		time.Since(t0).Truncate(time.Millisecond), u.Host, u.Path, len(u.RawQuery), len(dk))

	enc, err := downloadToTemp(ctx, cdnURL)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer os.Remove(enc.Name())
	defer enc.Close()
	fi, _ := enc.Stat()
	t.Logf("downloaded %d bytes (%.1f MiB)", fi.Size(), float64(fi.Size())/(1<<20))

	// Inspect the file as delivered: sample-entry types, and whether the video is
	// already well-formed H.264 (i.e. not encrypted at all).
	if keep := os.Getenv("ITUN_KEEP"); keep != "" {
		if _, err := enc.Seek(0, io.SeekStart); err == nil {
			if out, err := os.Create(keep); err == nil {
				io.Copy(out, enc)
				out.Close()
				t.Logf("kept encrypted download at %s", keep)
			}
		}
	}
	logTracks(t, enc)
	good0, checked0 := sampleVideoAVCC(t, enc)
	t.Logf("BEFORE decrypt: AVCC structure valid in %d/%d sampled video samples", good0, checked0)

	t1 := time.Now()
	if err := itunDecryptInPlace(ctx, s, enc, adam); err != nil {
		t.Fatalf("decrypt in place: %v", err)
	}
	t.Logf("decrypted in %s", time.Since(t1).Truncate(time.Millisecond))

	good, checked := sampleVideoAVCC(t, enc)
	t.Logf("AFTER decrypt: AVCC structure valid in %d/%d sampled video samples", good, checked)
	if checked == 0 || good*10 < checked*9 {
		t.Fatalf("decrypted video does not look like H.264 (%d/%d samples valid)", good, checked)
	}
}

func logTracks(t *testing.T, f *os.File) {
	t.Helper()
	f.Seek(0, io.SeekStart)
	parsed, err := mp4.DecodeFile(f, mp4.WithDecodeMode(mp4.DecModeLazyMdat))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for i, trak := range parsed.Moov.Traks {
		h := ""
		if trak.Mdia != nil && trak.Mdia.Hdlr != nil {
			h = trak.Mdia.Hdlr.HandlerType
		}
		var entries []string
		if stsd := trak.Mdia.Minf.Stbl.Stsd; stsd != nil {
			for _, c := range stsd.Children {
				entries = append(entries, c.Type())
			}
		}
		t.Logf("track %d handler=%s samples=%d sampleEntries=%v", i, h, trak.Mdia.Minf.Stbl.Stsz.GetNrSamples(), entries)
	}
}

// sampleVideoAVCC checks up to 200 evenly spaced video samples for valid AVCC structure.
func sampleVideoAVCC(t *testing.T, f *os.File) (good, checked int) {
	t.Helper()
	f.Seek(0, io.SeekStart)
	parsed, err := mp4.DecodeFile(f, mp4.WithDecodeMode(mp4.DecModeLazyMdat))
	if err != nil {
		t.Fatal(err)
	}
	for _, trak := range parsed.Moov.Traks {
		if trak.Mdia == nil || trak.Mdia.Hdlr == nil || trak.Mdia.Hdlr.HandlerType != "vide" {
			continue
		}
		stbl := trak.Mdia.Minf.Stbl
		n := stbl.Stsz.GetNrSamples()
		for sn := uint32(1); sn <= n && checked < 200; sn += max(1, n/200) {
			chunkNr, first, err := stbl.Stsc.ChunkNrFromSampleNr(int(sn))
			if err != nil {
				t.Fatal(err)
			}
			var off uint64
			if stbl.Stco != nil {
				off, _ = stbl.Stco.GetOffset(chunkNr)
			} else {
				off, _ = stbl.Co64.GetOffset(chunkNr)
			}
			for p := first; p < int(sn); p++ {
				off += uint64(stbl.Stsz.GetSampleSize(p))
			}
			buf := make([]byte, stbl.Stsz.GetSampleSize(int(sn)))
			if _, err := f.ReadAt(buf, int64(off)); err != nil {
				t.Fatal(err)
			}
			checked++
			if avccValid(buf) {
				good++
			}
		}
	}
	return good, checked
}

// avccValid reports whether buf is a chain of 4-byte-length-prefixed NAL units covering it
// exactly, each with forbidden_zero_bit clear and a defined NAL type.
func avccValid(buf []byte) bool {
	pos := 0
	for pos < len(buf) {
		if pos+4 > len(buf) {
			return false
		}
		n := int(binary.BigEndian.Uint32(buf[pos:]))
		pos += 4
		if n <= 0 || pos+n > len(buf) {
			return false
		}
		h := buf[pos]
		if h&0x80 != 0 {
			return false
		}
		if typ := h & 0x1f; typ == 0 || typ > 23 {
			return false
		}
		pos += n
	}
	return true
}
