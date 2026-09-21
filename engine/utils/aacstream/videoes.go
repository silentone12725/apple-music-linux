package aacstream

// WebCodecs MV video path (spike): demux a single-track H.264 fMP4 into an
// elementary-stream of access units for the renderer's VideoDecoder — bypassing
// Chromium's MSE ChunkDemuxer (the source of CHUNK_DEMUXER_ERROR_APPEND_FAILED /
// "code=3"). We do the demux here with mp4ff and feed Chromium's *decoder*
// directly via WebCodecs, so the browser demuxer is never involved.
//
// Wire format (big-endian), consumed by the renderer's ES parser:
//
//   Header:
//     magic   [4]byte  = "AME1"
//     codecLen uint16, codec  bytes   (e.g. "avc1.640028")
//     cfgLen   uint16, avcC   bytes   (AVCDecoderConfigurationRecord — VideoDecoder `description`)
//   Then, repeated until EOF, one record per access unit:
//     flags    uint8            (bit0: keyframe)
//     ptsUs    int64            (presentation time, microseconds)
//     durUs    uint32           (duration, microseconds)
//     dataLen  uint32
//     data     [dataLen]byte    (length-prefixed AVCC NAL units)

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/itouakirai/mp4ff/mp4"
)

const esMagic = "AME1"

// var dbgSampleN int // limits [video-es-raw] sample logging (diagnostic)

// DemuxFMP4ToES reads a single-track H.264 fragmented MP4 from r (the FFmpeg
// video remux output) and writes the elementary-stream framing above to w.
func DemuxFMP4ToES(ctx context.Context, r io.Reader, w io.Writer) error {
	br := bufio.NewReaderSize(r, 1<<20)
	bw := bufio.NewWriterSize(w, 1<<16)
	defer bw.Flush()

	// ── Init segment: read boxes until moov, extract the video track config. ──
	var moov *mp4.MoovBox
	var offset uint64
	for i := 0; i < 64 && moov == nil; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		box, err := mp4.DecodeBox(offset, br)
		if err != nil {
			return fmt.Errorf("init box %d: %w", i, err)
		}
		offset += box.Size()
		if mb, ok := box.(*mp4.MoovBox); ok {
			moov = mb
		}
	}
	if moov == nil {
		return errors.New("videoes: no moov in init segment")
	}

	var vtrak *mp4.TrakBox
	for _, t := range moov.Traks {
		if t.Mdia != nil && t.Mdia.Hdlr != nil && t.Mdia.Hdlr.HandlerType == "vide" {
			vtrak = t
			break
		}
	}
	if vtrak == nil || vtrak.Mdia.Mdhd == nil {
		return errors.New("videoes: no video track")
	}
	videoTrackID := vtrak.Tkhd.TrackID
	timescale := uint64(vtrak.Mdia.Mdhd.Timescale)
	if timescale == 0 {
		return errors.New("videoes: zero timescale")
	}
	stsd := vtrak.Mdia.Minf.Stbl.Stsd
	if stsd == nil || stsd.AvcX == nil || stsd.AvcX.AvcC == nil {
		return errors.New("videoes: no avcC (not H.264?)")
	}

	// AVCDecoderConfigurationRecord = avcC box contents without its 8-byte header.
	cfg, err := encodeBoxPayload(stsd.AvcX.AvcC)
	if err != nil {
		return err
	}
	if len(cfg) < 4 {
		return errors.New("videoes: short avcC")
	}
	// codec string from the config record: [1]=profile [2]=compat [3]=level.
	codec := fmt.Sprintf("avc1.%02x%02x%02x", cfg[1], cfg[2], cfg[3])

	// NAL length prefix size from avcC[4] (lengthSizeMinusOne, low 2 bits) — needed
	// to scan access units for IDR slices as a keyframe fallback (see below).
	nalLenSize := 4
	if len(cfg) > 4 {
		nalLenSize = int(cfg[4]&0x03) + 1
	}

	// Default sample params (durations/flags) come from trex when trun omits them.
	// Use the trex for the video track specifically so multi-track input is handled correctly.
	var trex *mp4.TrexBox
	if moov.Mvex != nil {
		if tx, ok := moov.Mvex.GetTrex(videoTrackID); ok {
			trex = tx
		} else if moov.Mvex.Trex != nil {
			trex = moov.Mvex.Trex
		} else if len(moov.Mvex.Trexs) > 0 {
			trex = moov.Mvex.Trexs[0]
		}
	}

	// ── ES header ──
	if _, err := bw.WriteString(esMagic); err != nil {
		return err
	}
	if err := writeLenPrefixed16(bw, []byte(codec)); err != nil {
		return err
	}
	if err := writeLenPrefixed16(bw, cfg); err != nil {
		return err
	}

	// ── Fragment loop: moof + mdat → access units. ──
	var pendingMoof *mp4.MoofBox
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		box, err := mp4.DecodeBox(offset, br)
		if err == io.EOF {
			return bw.Flush()
		}
		if err != nil {
			// A truncated final box on a clean end-of-stream is not an error worth failing on.
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return bw.Flush()
			}
			return fmt.Errorf("fragment box: %w", err)
		}
		offset += box.Size()

		switch b := box.(type) {
		case *mp4.MoofBox:
			// For multi-track fMP4 input (e.g. raw CBCS-decrypted stream with audio+video+subtitle
			// trafs), keep only the video traf so GetFullSamples returns only video access units.
			if len(b.Trafs) > 1 {
				var videoTrafs []*mp4.TrafBox
				for _, traf := range b.Trafs {
					if traf.Tfhd != nil && traf.Tfhd.TrackID == videoTrackID {
						videoTrafs = append(videoTrafs, traf)
					}
				}
				if len(videoTrafs) > 0 {
					b.Trafs = videoTrafs
					b.Traf = videoTrafs[0]
				}
			}
			pendingMoof = b
		case *mp4.MdatBox:
			if pendingMoof == nil {
				continue
			}
			frag := &mp4.Fragment{Moof: pendingMoof, Mdat: b, Children: []mp4.Box{pendingMoof, b}}
			samples, err := frag.GetFullSamples(trex)
			pendingMoof = nil
			if err != nil {
				fmt.Printf("[video-es] skipping unreadable fragment: %v\n", err)
				continue
			}
			for i := range samples {
				s := &samples[i]
				pts := s.PresentationTime() // DecodeTime + CompositionTimeOffset (ticks)
				if pts < 0 {
					pts = 0
				}
				ptsUs := int64(uint64(pts) * 1_000_000 / timescale)
				// if dbgSampleN < 4 {
				// 	dbgSampleN++
				// 	log.Printf("[video-es-raw] sample#%d pts=%d ptsUs=%d dur=%d ts=%d", dbgSampleN, pts, ptsUs, s.Dur, timescale)
				// }
				durUs := uint32(uint64(s.Dur) * 1_000_000 / timescale)
				// Keyframe = container sync flag OR an IDR slice in the access unit.
				// Apple's CBCS-decrypted fMP4 on the direct path does not set the
				// sample_is_non_sync_sample flags mp4ff's IsSync() reads, so IsSync()
				// is false for every sample and the renderer's ES parser (which drops
				// deltas until the first key) never starts decoding. Scanning for a
				// NAL type-5 slice recovers the keyframe regardless of container flags.
				key := s.IsSync() || avcHasIDR(s.Data, nalLenSize)
				if err := writeESSample(bw, key, ptsUs, durUs, s.Data); err != nil {
					return err
				}
			}
		}
	}
}

// encodeBoxPayload encodes an mp4 box and strips its 8-byte size+type header,
// returning just the box contents (for avcC → AVCDecoderConfigurationRecord).
func encodeBoxPayload(b mp4.Box) ([]byte, error) {
	var buf writerBuf
	if err := b.Encode(&buf); err != nil {
		return nil, err
	}
	if len(buf.b) < 8 {
		return nil, errors.New("videoes: box too small")
	}
	return buf.b[8:], nil
}

type writerBuf struct{ b []byte }

func (w *writerBuf) Write(p []byte) (int, error) { w.b = append(w.b, p...); return len(p), nil }

func writeLenPrefixed16(w io.Writer, p []byte) error {
	var hdr [2]byte
	binary.BigEndian.PutUint16(hdr[:], uint16(len(p)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(p)
	return err
}

// avcHasIDR reports whether an AVCC (length-prefixed) access unit contains a
// coded slice of an IDR picture (NAL unit type 5) — i.e. a keyframe. Used as a
// fallback when container sync-sample flags are unreliable. nalLenSize is the
// NAL length prefix width from avcC (1..4, normally 4).
func avcHasIDR(data []byte, nalLenSize int) bool {
	if nalLenSize < 1 || nalLenSize > 4 {
		nalLenSize = 4
	}
	for i := 0; i+nalLenSize <= len(data); {
		n := 0
		for k := 0; k < nalLenSize; k++ {
			n = n<<8 | int(data[i+k])
		}
		i += nalLenSize
		if n <= 0 || i+n > len(data) {
			break
		}
		if data[i]&0x1F == 5 { // nal_unit_type 5 = IDR slice
			return true
		}
		i += n
	}
	return false
}

func writeESSample(w io.Writer, key bool, ptsUs int64, durUs uint32, data []byte) error {
	var hdr [17]byte
	if key {
		hdr[0] = 1
	}
	binary.BigEndian.PutUint64(hdr[1:9], uint64(ptsUs))
	binary.BigEndian.PutUint32(hdr[9:13], durUs)
	binary.BigEndian.PutUint32(hdr[13:17], uint32(len(data)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(data)
	return err
}
