package aacstream

// MV dec-cache fragment index (#6, write side).
//
// While the remuxed MV fMP4 is being written into the encrypted dec-cache
// (MVDecCacheWriter), we parse the plaintext box stream inline and record, per
// fragment, its start time and its byte offset. A later seekable serve
// (ServeMVDecFrom) can then emit the init segment + the fragment covering a
// requested time WITHOUT re-running FFmpeg.
//
// Design constraints (must not break MV playback or anything else):
//   - Inline + synchronous: pure byte arithmetic over data already in hand, no
//     goroutine/pipe, so it can never stall the write path.
//   - Best-effort: on ANY anomaly it disables itself; seeks then fall back to the
//     existing FFmpeg re-transcode path (current behaviour). No regression.
//   - Bounded memory: only small boxes (moov/moof, ~KB) are buffered; mdat and
//     everything else is skipped by offset arithmetic.
//
// Offsets are plaintext byte positions. The dec-cache is AES-CTR encrypted with a
// 16-byte IV header, and CTR is a 1:1 stream cipher, so the ciphertext position
// of a plaintext offset N is simply mvDecIVSize + N.

import (
	"bytes"
	"crypto/cipher"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"sync"

	"github.com/itouakirai/mp4ff/mp4"
)

// MVFragEntry is one indexed fragment: its presentation start time and the
// plaintext byte offset of its moof box. End is the plaintext offset one past the
// fragment (== the next moof's Off), so [Off,End) is the complete moof+mdat. End
// is 0 for the most recent (still-open) fragment until the next moof arrives.
type MVFragEntry struct {
	T   float64 `json:"t"`             // start time, seconds
	Off int64   `json:"off"`           // plaintext byte offset of the moof
	End int64   `json:"end,omitempty"` // plaintext offset one past the fragment (next moof's Off); 0 if unbounded
}

// MVDecIndex is the sidecar written next to a completed dec-cache file.
type MVDecIndex struct {
	Timescale uint64        `json:"timescale"`
	InitSize  int64         `json:"initSize"` // plaintext bytes [0,InitSize) = ftyp+moov init segment
	Frags     []MVFragEntry `json:"frags"`
}

const (
	mvIdxMaxBoxSize     = 512 << 20 // sanity cap: no single top-level box exceeds this
	mvIdxMaxCollectSize = 8 << 20   // moov/moof larger than this → give up (not a real header box)
	mvIdxMaxFrags       = 1 << 16   // sanity cap on fragment count
)

// mvDecIndexer parses top-level MP4 boxes across arbitrary write chunks and
// records fragment offsets/times. Feed it the exact plaintext bytes written to
// the cache; call finish() to persist the index.
type mvDecIndexer struct {
	// mu guards the fields read concurrently by the live seek path (frags,
	// initSize/initSet, timescale). The dec-cache write path is single-threaded so
	// the lock is uncontended there; the growing-file path feeds from the producer
	// goroutine while seek requests call lookup()/initSizeLive() concurrently.
	mu sync.RWMutex

	disabled bool

	pos      int64 // running total of plaintext bytes fed
	boxStart int64 // plaintext offset where the current box began

	hdr     []byte // accumulates the box header (8 or 16 bytes)
	hdrNeed int    // header bytes needed (8, then possibly 16 for largesize)

	boxType   string
	remaining int64  // body bytes left to consume for the current box
	collect   bool   // buffer this box's body (moov/moof) for decoding
	body      []byte // buffered full box (header+body) when collect

	timescale    uint64
	videoTrackID uint32 // track to index times from (raw input is multi-track: audio+video+subs)
	initSize     int64
	initSet      bool
	frags        []MVFragEntry
	// Apple MV fMP4 tfdt encodes absolute media time (first fragment ≈10s, not 0s).
	// We normalize to a 0-based timeline so Lookup() uses the same clock as mkAudio.currentTime.
	baseTime    float64
	baseTimeSet bool
	dbgN        int // limits per-fragment/skip diagnostic logging
	dbgBoxN     int // limits per-box scanner diagnostic logging
}

func newMVDecIndexer() *mvDecIndexer {
	return &mvDecIndexer{hdrNeed: 8}
}

// feed advances the parser over p (the plaintext just written to the cache).
// It never errors and never blocks; on trouble it sets disabled and returns.
func (ix *mvDecIndexer) feed(p []byte) {
	if ix == nil || ix.disabled {
		return
	}
	defer func() {
		// A malformed stream must never take down the write path.
		if r := recover(); r != nil {
			ix.disabled = true
		}
	}()

	for len(p) > 0 {
		if ix.remaining == 0 && ix.hdrNeed > 0 {
			// Reading a box header.
			if len(ix.hdr) == 0 {
				ix.boxStart = ix.pos
			}
			take := ix.hdrNeed - len(ix.hdr)
			if take > len(p) {
				take = len(p)
			}
			ix.hdr = append(ix.hdr, p[:take]...)
			ix.pos += int64(take)
			p = p[take:]

			if len(ix.hdr) < ix.hdrNeed {
				return // need more header bytes
			}
			if ix.hdrNeed == 8 {
				size32 := binary.BigEndian.Uint32(ix.hdr[0:4])
				if size32 == 1 {
					ix.hdrNeed = 16 // 64-bit largesize follows
					continue
				}
				if !ix.startBox(int64(size32), string(ix.hdr[4:8])) {
					return
				}
			} else { // 16-byte largesize header
				size64 := binary.BigEndian.Uint64(ix.hdr[8:16])
				if !ix.startBox(int64(size64), string(ix.hdr[4:8])) {
					return
				}
			}
			continue
		}

		// Consuming a box body.
		take := ix.remaining
		if take > int64(len(p)) {
			take = int64(len(p))
		}
		if ix.collect {
			ix.body = append(ix.body, p[:take]...)
			if len(ix.body) > mvIdxMaxCollectSize {
				log.Printf("[mv-idx] disabled: %s box body exceeded %dB (misread size?)", ix.boxType, mvIdxMaxCollectSize)
				ix.disabled = true
				return
			}
		}
		ix.remaining -= take
		ix.pos += take
		p = p[take:]

		if ix.remaining == 0 {
			ix.finishBox()
			// Reset for the next header.
			ix.hdr = ix.hdr[:0]
			ix.hdrNeed = 8
			ix.body = nil
			ix.collect = false
		}
	}
}

// startBox is called once a box header is fully read. Returns false if the
// indexer disabled itself.
func (ix *mvDecIndexer) startBox(size int64, typ string) bool {
	// if ix.dbgBoxN < 24 {
	// 	ix.dbgBoxN++
	// 	log.Printf("[mv-idx] box off=%d type=%q size=%d", ix.boxStart, typ, size)
	// }
	// size==0 means "to EOF" (a trailing mdat); nothing more to index.
	if size == 0 {
		log.Printf("[mv-idx] disabled: box %q size=0 (to-EOF) at off=%d", typ, ix.boxStart)
		ix.disabled = true
		return false
	}
	hdrLen := int64(len(ix.hdr))
	if size < hdrLen || size > mvIdxMaxBoxSize {
		log.Printf("[mv-idx] disabled: box %q bad size=%d at off=%d", typ, size, ix.boxStart)
		ix.disabled = true
		return false
	}
	ix.boxType = typ
	ix.remaining = size - hdrLen
	ix.collect = typ == "moov" || typ == "moof"
	if ix.collect {
		ix.body = append(ix.body[:0], ix.hdr...) // seed body with the header
	}
	// First moof marks the end of the init segment.
	if typ == "moof" && !ix.initSet {
		ix.mu.Lock()
		ix.initSize = ix.boxStart
		ix.initSet = true
		ix.mu.Unlock()
	}
	return true
}

// finishBox is called once a collected box's bytes are fully buffered.
func (ix *mvDecIndexer) finishBox() {
	if !ix.collect || len(ix.body) == 0 {
		return
	}
	box, err := mp4.DecodeBox(0, bytes.NewReader(ix.body))
	if err != nil || box == nil {
		if ix.dbgN < 8 {
			ix.dbgN++
			log.Printf("[mv-idx] DecodeBox(%s, %dB) failed: %v", ix.boxType, len(ix.body), err)
		}
		return // skip this box; keep indexing others
	}
	switch b := box.(type) {
	case *mp4.MoovBox:
		// Index times from the VIDEO track: the raw CBCS input is multi-track
		// (audio+video+subs), so the first trak/traf is often audio with a
		// different timescale — using it yields wrong fragment times. Mirror
		// DemuxFMP4ToES's video-track selection.
		var vTrackID uint32
		var vTimescale uint64
		for _, trak := range b.Traks {
			if trak.Mdia != nil && trak.Mdia.Hdlr != nil && trak.Mdia.Hdlr.HandlerType == "vide" &&
				trak.Mdia.Mdhd != nil && trak.Mdia.Mdhd.Timescale > 0 {
				vTrackID = trak.Tkhd.TrackID
				vTimescale = uint64(trak.Mdia.Mdhd.Timescale)
				break
			}
		}
		if vTimescale == 0 { // single-track / no handler: fall back to first track with a timescale
			for _, trak := range b.Traks {
				if trak.Mdia != nil && trak.Mdia.Mdhd != nil && trak.Mdia.Mdhd.Timescale > 0 {
					vTimescale = uint64(trak.Mdia.Mdhd.Timescale)
					if trak.Tkhd != nil {
						vTrackID = trak.Tkhd.TrackID
					}
					break
				}
			}
		}
		if vTimescale > 0 {
			ix.mu.Lock()
			ix.timescale = vTimescale
			ix.videoTrackID = vTrackID
			ix.mu.Unlock()
		}
		// log.Printf("[mv-idx] moov nTraks=%d vTrackID=%d vTimescale=%d", len(b.Traks), vTrackID, vTimescale)
	case *mp4.MoofBox:
		if ix.timescale == 0 {
			if ix.dbgN < 8 {
				ix.dbgN++
				log.Printf("[mv-idx] moof skipped: timescale==0 (moov not indexed)")
			}
			return
		}
		// Pick the video traf (by track ID) from a multi-track moof; fall back to
		// the first traf for single-track input.
		var vtraf *mp4.TrafBox
		for _, traf := range b.Trafs {
			if traf.Tfhd != nil && ix.videoTrackID != 0 && traf.Tfhd.TrackID == ix.videoTrackID {
				vtraf = traf
				break
			}
		}
		if vtraf == nil {
			vtraf = b.Traf
		}
		if vtraf == nil || vtraf.Tfdt == nil {
			if ix.dbgN < 8 {
				ix.dbgN++
				log.Printf("[mv-idx] moof skipped: nTrafs=%d vtraf=%v tfdt=%v", len(b.Trafs), vtraf != nil, vtraf != nil && vtraf.Tfdt != nil)
			}
			return
		}
		if len(ix.frags) >= mvIdxMaxFrags {
			ix.disabled = true
			return
		}
		t := float64(vtraf.Tfdt.BaseMediaDecodeTime()) / float64(ix.timescale)
		// Normalize to 0-based: Apple's raw tfdt encodes absolute media time (first
		// fragment ≈10s). Subtract the first fragment's time so the index matches
		// mkAudio.currentTime which is 0-based.
		if !ix.baseTimeSet {
			ix.baseTime = t
			ix.baseTimeSet = true
		}
		t -= ix.baseTime
		ix.mu.Lock()
		// This moof begins where the previous fragment ends: bound the prior entry.
		if n := len(ix.frags); n > 0 {
			ix.frags[n-1].End = ix.boxStart
		}
		ix.frags = append(ix.frags, MVFragEntry{T: t, Off: ix.boxStart})
		ix.mu.Unlock()
		// if ix.dbgN < 8 {
		// 	ix.dbgN++
		// 	n := len(ix.frags)
		// 	log.Printf("[mv-idx] frag#%d T=%.3f off=%d (tfdt=%d ts=%d)", n, t, ix.boxStart, vtraf.Tfdt.BaseMediaDecodeTime(), ix.timescale)
		// }
	}
}

// finish persists the index next to the committed dec-cache file. It is a no-op
// (writes nothing) if the indexer was disabled or produced an unusable index, so
// the seek path cleanly falls back to FFmpeg re-transcode.
func (ix *mvDecIndexer) finish(decPath string) {
	if ix == nil || ix.disabled || !ix.initSet || ix.timescale == 0 || len(ix.frags) == 0 {
		return
	}
	idx := MVDecIndex{Timescale: ix.timescale, InitSize: ix.initSize, Frags: ix.frags}
	data, err := json.Marshal(idx)
	if err != nil {
		return
	}
	tmp := decPath + ".idx.tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, decPath+".idx") // atomic; best-effort
}

// lookup returns the latest fragment whose start time is <= t, as a value copy
// (never a pointer into frags — the writer may reallocate it). ok is false if no
// fragment at/before t exists yet.
func (ix *mvDecIndexer) lookup(t float64) (MVFragEntry, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	best := -1
	for i := range ix.frags {
		if ix.frags[i].T <= t {
			best = i
		} else {
			break // frags are in ascending decode-time order
		}
	}
	if best < 0 {
		return MVFragEntry{}, false
	}
	return ix.frags[best], true
}

// initSizeLive returns the init-segment size (ftyp+moov) once the first moof has
// been seen, else (0,false).
func (ix *mvDecIndexer) initSizeLive() (int64, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if !ix.initSet {
		return 0, false
	}
	return ix.initSize, true
}

// MVLiveIndex is a concurrency-safe, incrementally-fed fragment index for the
// growing-file /video-es path. It is an io.Writer so it can sit in an
// io.MultiWriter beside the growing cache file; Lookup/InitSize are safe to call
// from other goroutines while it is being fed.
type MVLiveIndex struct{ ix *mvDecIndexer }

// NewMVLiveIndex creates an empty live fragment index.
func NewMVLiveIndex() *MVLiveIndex { return &MVLiveIndex{ix: newMVDecIndexer()} }

// Write feeds plaintext fMP4 bytes to the indexer. It never errors and never
// blocks (best-effort; disables itself on any anomaly), so it is safe to place in
// an io.MultiWriter beside the growing cache file.
func (m *MVLiveIndex) Write(p []byte) (int, error) { m.ix.feed(p); return len(p), nil }

// Lookup returns the latest fragment whose start <= t. Callers must still verify
// the fragment is complete and available (frag.End > 0 && frag.End <= bytesWritten)
// before serving it from the growing file.
func (m *MVLiveIndex) Lookup(t float64) (MVFragEntry, bool) { return m.ix.lookup(t) }

// LookupComplete returns the latest fragment that is both at or before t AND
// fully written to the growing file (End > 0 && End <= written). If the exact
// fragment covering t is not yet complete, it falls back to an earlier complete
// one. This guarantees the returned fragment's bytes are already on disk so the
// growing reader delivers the first chunk immediately, preventing the 8 s hang
// timeout from firing during a seek.
func (m *MVLiveIndex) LookupComplete(t float64, written int64) (MVFragEntry, bool) {
	m.ix.mu.RLock()
	defer m.ix.mu.RUnlock()
	best := -1
	for i := range m.ix.frags {
		f := &m.ix.frags[i]
		if f.T > t {
			break
		}
		if f.End > 0 && f.End <= written {
			best = i
		}
	}
	if best < 0 {
		return MVFragEntry{}, false
	}
	return m.ix.frags[best], true
}

// InitSize returns the init-segment byte size (ftyp+moov) once known.
func (m *MVLiveIndex) InitSize() (int64, bool) { return m.ix.initSizeLive() }

// ReadMVDecIndex loads the sidecar index for a dec-cache file, or (nil,false) if
// none exists / is unreadable.
func ReadMVDecIndex(assetID string, maxHeight int) (*MVDecIndex, bool) {
	data, err := os.ReadFile(mvDecFilePath(assetID, maxHeight) + ".idx")
	if err != nil {
		return nil, false
	}
	var idx MVDecIndex
	if err := json.Unmarshal(data, &idx); err != nil || idx.Timescale == 0 || len(idx.Frags) == 0 {
		return nil, false
	}
	return &idx, true
}

// MVDecIndexExists reports whether a usable fragment index exists for the cached
// track. Callers check this BEFORE serving so a missing/unusable index cleanly
// falls through to the FFmpeg seek path instead of erroring mid-stream.
func MVDecIndexExists(assetID string, maxHeight int) bool {
	_, ok := ReadMVDecIndex(assetID, maxHeight)
	return ok
}

// addToCounter returns iv + add as a big-endian 128-bit counter, for seeking an
// AES-CTR keystream to an arbitrary block without re-decrypting the prefix.
func addToCounter(iv []byte, add uint64) []byte {
	out := make([]byte, len(iv))
	copy(out, iv)
	for i := len(out) - 1; i >= 0 && add > 0; i-- {
		add += uint64(out[i])
		out[i] = byte(add & 0xff)
		add >>= 8
	}
	return out
}

// ServeMVDecFrom serves the cached remuxed track starting at the fragment that
// covers seekSec: it emits the init segment (ftyp+moov) followed by every
// fragment from the last moof whose start time <= seekSec. This lets a backward
// seek replay from the dec-cache WITHOUT re-running FFmpeg.
//
// AES-CTR is a 1:1 stream cipher, so the tail is decrypted by seeking the file to
// the fragment's ciphertext offset (mvDecIVSize + blockStart) and advancing the
// CTR counter to the matching block — the prefix is never read or decrypted.
func ServeMVDecFrom(assetID string, maxHeight int, seekSec float64, dst io.Writer) error {
	initMVDecKey()
	idx, ok := ReadMVDecIndex(assetID, maxHeight)
	if !ok {
		return fmt.Errorf("no MV index for %s@%dp", assetID, maxHeight)
	}

	// Target = last fragment starting at or before seekSec (so seekSec is covered);
	// fall back to the first fragment when seeking before it.
	target := idx.Frags[0]
	for _, f := range idx.Frags {
		if f.T <= seekSec {
			target = f
		} else {
			break
		}
	}

	decPath := mvDecFilePath(assetID, maxHeight)
	f, err := os.Open(decPath)
	if err != nil {
		return err
	}
	defer f.Close()

	// Guard against a cache file shorter than the index claims (truncation/
	// corruption): the offsets would read past EOF. Drop the stale index so the
	// next seek falls back to FFmpeg and re-caches, and fail this request cleanly.
	if fi, statErr := f.Stat(); statErr == nil {
		plainLen := fi.Size() - mvDecIVSize
		if plainLen < idx.InitSize || plainLen <= target.Off {
			os.Remove(decPath + ".idx")
			return fmt.Errorf("mv dec-cache truncated (%s@%dp): plainLen=%d initSize=%d targetOff=%d",
				assetID, maxHeight, plainLen, idx.InitSize, target.Off)
		}
	}

	var iv [mvDecIVSize]byte
	if _, err := io.ReadFull(f, iv[:]); err != nil {
		return err
	}

	// 1) Init segment: decrypt [0, InitSize) from the start of the ciphertext.
	initStream, err := newAESCTR(iv[:])
	if err != nil {
		return err
	}
	if _, err := f.Seek(mvDecIVSize, io.SeekStart); err != nil {
		return err
	}
	if _, err := io.CopyN(dst, &cipher.StreamReader{S: initStream, R: f}, idx.InitSize); err != nil {
		return err
	}

	// 2) Tail from the target fragment via a seeked CTR keystream.
	off := target.Off
	block := uint64(off) / mvDecIVSize
	lead := uint64(off) % mvDecIVSize // bytes to discard so output starts exactly at off
	tailStream, err := newAESCTR(addToCounter(iv[:], block))
	if err != nil {
		return err
	}
	if _, err := f.Seek(mvDecIVSize+int64(block)*mvDecIVSize, io.SeekStart); err != nil {
		return err
	}
	sr := &cipher.StreamReader{S: tailStream, R: f}
	if lead > 0 {
		if _, err := io.CopyN(io.Discard, sr, int64(lead)); err != nil {
			return err
		}
	}
	_, err = io.Copy(dst, sr)
	return err
}
