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
	"encoding/binary"
	"encoding/json"
	"os"

	"github.com/itouakirai/mp4ff/mp4"
)

// MVFragEntry is one indexed fragment: its presentation start time and the
// plaintext byte offset of its moof box.
type MVFragEntry struct {
	T   float64 `json:"t"`   // start time, seconds
	Off int64   `json:"off"` // plaintext byte offset of the moof
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
	disabled bool

	pos      int64 // running total of plaintext bytes fed
	boxStart int64 // plaintext offset where the current box began

	hdr     []byte // accumulates the box header (8 or 16 bytes)
	hdrNeed int    // header bytes needed (8, then possibly 16 for largesize)

	boxType   string
	remaining int64  // body bytes left to consume for the current box
	collect   bool   // buffer this box's body (moov/moof) for decoding
	body      []byte // buffered full box (header+body) when collect

	timescale uint64
	initSize  int64
	initSet   bool
	frags     []MVFragEntry
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
	// size==0 means "to EOF" (a trailing mdat); nothing more to index.
	if size == 0 {
		ix.disabled = true
		return false
	}
	hdrLen := int64(len(ix.hdr))
	if size < hdrLen || size > mvIdxMaxBoxSize {
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
		ix.initSize = ix.boxStart
		ix.initSet = true
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
		return // skip this box; keep indexing others
	}
	switch b := box.(type) {
	case *mp4.MoovBox:
		for _, trak := range b.Traks {
			if trak.Mdia != nil && trak.Mdia.Mdhd != nil && trak.Mdia.Mdhd.Timescale > 0 {
				ix.timescale = uint64(trak.Mdia.Mdhd.Timescale)
				break
			}
		}
	case *mp4.MoofBox:
		if ix.timescale == 0 || b.Traf == nil || b.Traf.Tfdt == nil {
			return
		}
		if len(ix.frags) >= mvIdxMaxFrags {
			ix.disabled = true
			return
		}
		t := float64(b.Traf.Tfdt.BaseMediaDecodeTime()) / float64(ix.timescale)
		ix.frags = append(ix.frags, MVFragEntry{T: t, Off: ix.boxStart})
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
