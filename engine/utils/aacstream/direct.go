package aacstream

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/itouakirai/mp4ff/mp4"
)

// Fragment-level seek ("direct" path).
//
// An HLS video segment is a flat sequence of moof+mdat fragments, each starting on a
// sync sample and carrying its own senc, so a fragment decrypts independently of the
// ones before it. A seek therefore only needs the fragment that holds the target and
// everything after it — not the bytes of the segment that precede it. PlanDirectSeek
// maps the segment with small range reads (no sidx exists); DirectPlan.Stream then
// emits [init][fragments from the target][following segments] as one raw, still
// encrypted fMP4 stream, which the normal decrypt stage turns into clear output.

// ErrDirectUnsupported means the segment layout can't be seeked at fragment level
// (byte-range playlist entries, unexpected boxes, no Range support). Callers fall
// back to the whole-segment path.
var ErrDirectUnsupported = errors.New("fragment-level seek unsupported for this segment")

const (
	directProbeWindow = 16 << 10 // moof headers are a few KiB; mdat is only peeked at (8 bytes)
	directTargetSlack = 0.05     // seconds a fragment may start after the target and still be chosen
	directMaxFrags    = 512      // sanity bound on fragments mapped in one segment
)

// DirectPlan is the result of mapping the segment that contains a seek target.
type DirectPlan struct {
	initBytes []byte
	segURL    string
	segCached []byte // non-nil when the whole segment was already in the MV cache
	segSize   int64
	fragOff   int64    // byte offset of the first fragment to emit
	rest      []string // whole segments that follow, streamed by DownloadMVSegmentsStreaming

	// RawFragStart is the first emitted fragment's tfdt in seconds on the raw
	// timeline; RawSegStart is the same for the segment's first fragment. Their
	// difference from the playlist time is the constant HLS timeline offset.
	RawFragStart float64
	RawSegStart  float64
	Probes       int // range requests spent on mapping, for logging
}

// PlanDirectSeek maps segURL and picks the fragment holding the target, given as
// seconds into the segment (target minus the segment's playlist start). The raw tfdt
// timeline sits at a constant offset from the playlist's, so the target is resolved
// against the segment's own first fragment rather than assuming that offset. initURL
// and rest come from the HLS playlist: rest are the segments after segURL.
func PlanDirectSeek(ctx context.Context, initURL, segURL string, rest []string, offsetInSeg float64) (*DirectPlan, error) {
	if strings.Contains(segURL, "#bytes=") || strings.Contains(initURL, "#bytes=") {
		return nil, ErrDirectUnsupported
	}
	initBytes, err := fetchWholeMV(ctx, initURL)
	if err != nil {
		return nil, fmt.Errorf("init: %w", err)
	}
	initSeg, _, err := readInitSegment(bytes.NewReader(initBytes))
	if err != nil {
		return nil, fmt.Errorf("init parse: %w", err)
	}
	ts := videoTimescale(initSeg)
	if ts == 0 {
		return nil, fmt.Errorf("%w: no video timescale", ErrDirectUnsupported)
	}

	p := &DirectPlan{initBytes: initBytes, segURL: segURL, rest: rest}
	var rng rangeReader
	if cached, ok := GetCachedMVSegment(stableCacheKey(segURL)); ok {
		p.segCached = cached
		rng = memRange(cached)
	} else {
		rng = func(ctx context.Context, off, end int64) ([]byte, int64, error) {
			p.Probes++
			return fetchRange(ctx, segURL, off, end)
		}
	}
	if err := p.mapFragments(ctx, rng, ts, offsetInSeg); err != nil {
		return nil, err
	}
	return p, nil
}

type rangeReader func(ctx context.Context, off, end int64) (data []byte, total int64, err error)

func memRange(b []byte) rangeReader {
	return func(_ context.Context, off, end int64) ([]byte, int64, error) {
		total := int64(len(b))
		if off >= total {
			return nil, total, io.EOF
		}
		if end >= total {
			end = total - 1
		}
		return b[off : end+1], total, nil
	}
}

func videoTimescale(init *mp4.InitSegment) uint64 {
	if init == nil || init.Moov == nil {
		return 0
	}
	for _, trak := range init.Moov.Traks {
		if trak.Mdia != nil && trak.Mdia.Mdhd != nil {
			return uint64(trak.Mdia.Mdhd.Timescale)
		}
	}
	return 0
}

// mapFragments walks the segment's moof/mdat chain, reading only box headers, until
// it passes the target. Everything after the chosen fragment is streamed as one range,
// so later fragments need no mapping.
func (p *DirectPlan) mapFragments(ctx context.Context, rng rangeReader, ts uint64, offsetInSeg float64) error {
	if offsetInSeg < 0 {
		offsetInSeg = 0
	}
	var off, total int64
	chosen := int64(-1)
	for i := 0; i < directMaxFrags; i++ {
		end := off + directProbeWindow - 1
		hdr, tot, err := rng(ctx, off, end)
		if err != nil {
			if errors.Is(err, io.EOF) && chosen >= 0 {
				break
			}
			return fmt.Errorf("probe fragment %d: %w", i, err)
		}
		total = tot
		if len(hdr) < 16 {
			return fmt.Errorf("%w: short header at %d", ErrDirectUnsupported, off)
		}
		moofSize := int64(binary.BigEndian.Uint32(hdr[:4]))
		if string(hdr[4:8]) != "moof" || moofSize < 16 {
			return fmt.Errorf("%w: expected moof at %d, got %q", ErrDirectUnsupported, off, hdr[4:8])
		}
		if moofSize+16 > int64(len(hdr)) { // moof larger than the window: fetch it whole
			hdr, _, err = rng(ctx, off, off+moofSize+15)
			if err != nil || int64(len(hdr)) < moofSize+8 {
				return fmt.Errorf("%w: moof at %d unreadable", ErrDirectUnsupported, off)
			}
		}
		tfdt, err := moofTfdt(hdr[:moofSize])
		if err != nil {
			return fmt.Errorf("%w: %v", ErrDirectUnsupported, err)
		}
		mh := hdr[moofSize:]
		if len(mh) < 8 {
			mh, _, err = rng(ctx, off+moofSize, off+moofSize+15)
			if err != nil || len(mh) < 8 {
				return fmt.Errorf("%w: mdat header at %d unreadable", ErrDirectUnsupported, off+moofSize)
			}
		}
		if string(mh[4:8]) != "mdat" {
			return fmt.Errorf("%w: expected mdat after moof at %d", ErrDirectUnsupported, off)
		}
		mdatSize := int64(binary.BigEndian.Uint32(mh[:4]))
		if mdatSize == 1 { // 64-bit largesize
			if len(mh) < 16 {
				return fmt.Errorf("%w: truncated largesize mdat", ErrDirectUnsupported)
			}
			mdatSize = int64(binary.BigEndian.Uint64(mh[8:16]))
		}
		if mdatSize < 8 {
			return fmt.Errorf("%w: bad mdat size %d", ErrDirectUnsupported, mdatSize)
		}

		start := float64(tfdt) / float64(ts)
		if i == 0 {
			p.RawSegStart = start
		}
		if start <= p.RawSegStart+offsetInSeg+directTargetSlack || chosen < 0 {
			chosen = off
			p.RawFragStart = start
		} else {
			break
		}
		off += moofSize + mdatSize
		if off >= total {
			break
		}
	}
	if chosen < 0 {
		return fmt.Errorf("%w: no fragment found", ErrDirectUnsupported)
	}
	p.fragOff, p.segSize = chosen, total
	return nil
}

func moofTfdt(moofBytes []byte) (uint64, error) {
	box, err := mp4.DecodeBox(0, bytes.NewReader(moofBytes))
	if err != nil {
		return 0, fmt.Errorf("decode moof: %w", err)
	}
	moof, ok := box.(*mp4.MoofBox)
	if !ok || moof.Traf == nil || moof.Traf.Tfdt == nil {
		return 0, errors.New("moof without traf/tfdt")
	}
	return moof.Traf.Tfdt.BaseMediaDecodeTime(), nil
}

// Stream writes the raw (encrypted) stream: init, the target fragment onward within
// the mapped segment, then the following whole segments.
func (p *DirectPlan) Stream(ctx context.Context, w io.Writer) error {
	if _, err := w.Write(p.initBytes); err != nil {
		return err
	}
	if p.segCached != nil {
		if _, err := w.Write(p.segCached[p.fragOff:]); err != nil {
			return err
		}
	} else if err := streamRange(ctx, p.segURL, p.fragOff, p.segSize-1, w); err != nil {
		return fmt.Errorf("segment tail: %w", err)
	}
	if len(p.rest) == 0 {
		return nil
	}
	log.Printf("[direct] target segment tail done (%d probes, from byte %d of %d); continuing with %d segments",
		p.Probes, p.fragOff, p.segSize, len(p.rest))
	return DownloadMVSegmentsStreaming(ctx, p.rest, w, 5)
}

// fetchWholeMV returns a small file (the init segment), through the MV cache.
func fetchWholeMV(ctx context.Context, url string) ([]byte, error) {
	return fetchMVSegment(ctx, url)
}

// fetchRange reads bytes [off,end] of url and the resource's total size. The reply
// must be 206; a 200 means Range was ignored and is reported as unsupported.
func fetchRange(ctx context.Context, url string, off, end int64) ([]byte, int64, error) {
	hdr := "bytes=" + strconv.FormatInt(off, 10) + "-" + strconv.FormatInt(end, 10)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Range", hdr)
	resp, err := mvHTTPClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
	case http.StatusRequestedRangeNotSatisfiable:
		return nil, 0, io.EOF
	case http.StatusOK:
		return nil, 0, fmt.Errorf("%w: server ignored Range", ErrDirectUnsupported)
	default:
		return nil, 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	total, err := totalFromContentRange(resp.Header.Get("Content-Range"))
	if err != nil {
		return nil, 0, fmt.Errorf("%w: %v", ErrDirectUnsupported, err)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, end-off+1))
	if err != nil {
		return nil, 0, fmt.Errorf("read: %w", err)
	}
	return data, total, nil
}

func totalFromContentRange(cr string) (int64, error) {
	i := strings.LastIndexByte(cr, '/')
	if i < 0 {
		return 0, fmt.Errorf("bad Content-Range %q", cr)
	}
	n, err := strconv.ParseInt(cr[i+1:], 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("bad Content-Range total %q", cr)
	}
	return n, nil
}

// streamRange pipes bytes [off,end] of url to w as they arrive. It never retries once
// bytes have been written (a retry would duplicate them), and it is paused by
// HoldBackground like any other background download.
func streamRange(ctx context.Context, url string, off, end int64, w io.Writer) error {
	hdr := "bytes=" + strconv.FormatInt(off, 10) + "-" + strconv.FormatInt(end, 10)
	const maxRetries = 3
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Range", hdr)
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			if !mvRetry(ctx, attempt, maxRetries) {
				return fmt.Errorf("fetch: %w", err)
			}
			continue
		}
		if err := segmentStatusErr(resp, hdr); err != nil {
			resp.Body.Close()
			if !mvRetry(ctx, attempt, maxRetries) {
				return err
			}
			continue
		}
		n, copyErr := io.Copy(w, gate(ctx, resp.Body))
		resp.Body.Close()
		if copyErr != nil {
			return fmt.Errorf("stream body: %w", copyErr)
		}
		if want := end - off + 1; n != want {
			return fmt.Errorf("short range body: %d of %d bytes", n, want)
		}
		return nil
	}
	return fmt.Errorf("all retries exhausted")
}
