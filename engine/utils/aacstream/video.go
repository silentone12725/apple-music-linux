package aacstream

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"

	"github.com/itouakirai/mp4ff/mp4"
)

// StripAudioAndPassthrough strips all non-video tracks from the CMAF fMP4 init
// segment, strips non-video traf boxes from each fragment, and upgrades each
// fragment's TFDT to Version 1 (8-byte BaseMediaDecodeTime).
//
// Strips: soun (audio), clcp (CEA-608 closed captions), text, subt — anything
// whose handler type is not "vide". Chromium MSE rejects mixed-track init
// segments appended to a video-only SourceBuffer, and non-video traf boxes
// in fragment moofs cause CHUNK_DEMUXER_ERROR_APPEND_FAILED.
//
// TFDT handling: Apple's video fMP4 already carries valid, monotonically-
// increasing TFDT values that align with the edit list (ELST) in the moov.
// We preserve those values unchanged and only upgrade Version 0 → 1 so that
// high-timescale values (e.g. 90 kHz tracks) never overflow uint32. The
// DataOffset in each trun is corrected for the net moof size change caused by
// the traf strip and TFDT version upgrade.
func StripAudioAndPassthrough(ctx context.Context, src func(io.Writer) error, dst io.Writer) error {
	pr, pw := io.Pipe()

	srcErrCh := make(chan error, 1)
	go func() {
		err := src(pw)
		pw.CloseWithError(err)
		srcErrCh <- err
	}()

	br := bufio.NewReaderSize(pr, 1<<20)
	init, _, err := readInitSegment(br)
	if err != nil {
		return fmt.Errorf("video init segment: %w", err)
	}

	videoTrackIDs := stripNonVideoTracks(init.Moov)

	if err := init.Encode(dst); err != nil {
		return fmt.Errorf("write video init: %w", err)
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}

	var offset uint64
	for {
		if ctx.Err() != nil {
			break
		}
		frag, err := readNextFragment(br, &offset)
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			return fmt.Errorf("video fragment: %w", err)
		}
		patchVideoFragment(frag, videoTrackIDs)
		if frag.Moof != nil && frag.Moof.Traf != nil {
			traf := frag.Moof.Traf
			var tfdt uint64
			if traf.Tfdt != nil {
				tfdt = traf.Tfdt.BaseMediaDecodeTime()
			}
			var mdatSz uint64
			if frag.Mdat != nil {
				mdatSz = uint64(len(frag.Mdat.Data))
			}
			log.Printf("[video-strip] moof#%d tfdt=%d mdatSz=%dB",
				frag.Moof.Mfhd.SequenceNumber, tfdt, mdatSz)
		}
		if err := frag.Encode(dst); err != nil {
			if ctx.Err() != nil {
				break
			}
			return fmt.Errorf("write video fragment: %w", err)
		}
	}

	srcErr := <-srcErrCh
	if srcErr != nil && ctx.Err() == nil {
		return fmt.Errorf("video source: %w", srcErr)
	}
	return nil
}

// patchVideoFragment strips non-video traf boxes from frag.Moof, upgrades the
// TFDT box to Version 1 (so large TFDT values fit in uint64), and corrects
// trun DataOffset for any moof size change caused by stripping or the version
// upgrade. Apple's original TFDT values are preserved unchanged: they are
// already monotonically increasing and aligned with the edit list in the moov.
func patchVideoFragment(frag *mp4.Fragment, videoTrackIDs map[uint32]struct{}) {
	if frag.Moof == nil {
		return
	}

	// ── Step 1: strip non-video trafs ────────────────────────────────────────
	oldSize := frag.Moof.Size()
	trafsBefore := len(frag.Moof.Trafs)

	if len(frag.Moof.Trafs) > 1 {
		keepTrafs := frag.Moof.Trafs[:0]
		dropSet := make(map[*mp4.TrafBox]struct{})
		for _, traf := range frag.Moof.Trafs {
			if traf.Tfhd != nil {
				if _, ok := videoTrackIDs[traf.Tfhd.TrackID]; ok {
					keepTrafs = append(keepTrafs, traf)
					continue
				}
			}
			dropSet[traf] = struct{}{}
		}
		if len(dropSet) > 0 {
			frag.Moof.Trafs = keepTrafs
			if len(keepTrafs) > 0 {
				frag.Moof.Traf = keepTrafs[0]
			} else {
				frag.Moof.Traf = nil
			}
			newChildren := frag.Moof.Children[:0]
			for _, child := range frag.Moof.Children {
				if t, ok := child.(*mp4.TrafBox); ok {
					if _, drop := dropSet[t]; drop {
						continue
					}
				}
				newChildren = append(newChildren, child)
			}
			frag.Moof.Children = newChildren
		}
	}

	if frag.Moof.Traf == nil {
		return
	}
	traf := frag.Moof.Traf

	// ── Step 2: ensure TFDT box exists and is Version 1 ──────────────────────
	// Apple's TFDTs are already valid and monotonically increasing; we leave
	// the value unchanged so the ELST media_time alignment in the moov is
	// preserved. We upgrade to Version 1 (8-byte BMDT) so high-timescale
	// values (e.g. 90 kHz tracks) never overflow uint32.
	tfdtVersion := uint8(255) // sentinel: no TFDT box
	if traf.Tfdt != nil {
		tfdtVersion = traf.Tfdt.Version
		traf.Tfdt.Version = 1
	} else {
		tfdt := mp4.CreateTfdt(0)
		tfdt.Version = 1
		traf.Tfdt = tfdt
		tfdtVersion = 0 // was absent, treated as V0
		var newChildren []mp4.Box
		for _, child := range traf.Children {
			if child.Type() == "trun" {
				newChildren = append(newChildren, tfdt)
			}
			newChildren = append(newChildren, child)
		}
		traf.Children = newChildren
	}

	// ── Step 3: fix trun DataOffset by net moof size delta ───────────────────
	// DataOffset = bytes from start of moof to start of this trun's samples in
	// mdat. Any moof size change (dropped trafs, TFDT version 0→1 upgrade)
	// shifts this offset and must be corrected.
	sizeAfterStrip := frag.Moof.Size()
	newSize := sizeAfterStrip
	sizeDiff := int32(newSize) - int32(oldSize)

	var origDataOff int32
	hasOrig := false
	if len(traf.Truns) > 0 && traf.Truns[0].HasDataOffset() {
		origDataOff = traf.Truns[0].DataOffset
		hasOrig = true
	}

	// Assign DataOffset directly from newMoof size — do NOT use a delta from
	// Apple's original DataOffset. Apple's masters sometimes ship moofs where
	// the original DataOffset != oldMoof+8 (a pre-existing encoder bug). A
	// delta-based correction would propagate that error, placing the byte
	// cursor in the wrong position inside mdat and causing FFmpeg to report
	// "Invalid NAL unit size" → CHUNK_DEMUXER_ERROR_APPEND_FAILED.
	// DataOffset = newMoofSize + 8 (8 = mdat box header: 4-byte size + "mdat").
	for _, t := range traf.Truns {
		if t.HasDataOffset() {
			t.DataOffset = int32(newSize) + 8
		}
	}

	// Diagnostic: log patch internals so DataOffset bugs are immediately visible.
	// expected = newSize+8 because DataOffset is relative to moof start, and mdat
	// data begins at moof_size + 8-byte mdat box header.
	var finalDataOff int32
	if hasOrig {
		finalDataOff = int32(newSize) + 8
	}
	seq := frag.Moof.Mfhd.SequenceNumber
	expected := int32(newSize) + 8
	ok := !hasOrig || finalDataOff == expected
	log.Printf("[vpatch] moof#%d trafs=%d→%d oldMoof=%dB newMoof=%dB tfdtUpgraded=%v sizeDiff=%d origDataOff=%d finalDataOff=%d expected=%d OK=%v",
		seq, trafsBefore, len(frag.Moof.Trafs),
		oldSize, newSize,
		tfdtVersion < 1,
		sizeDiff,
		origDataOff, finalDataOff, expected, ok,
	)

}

// stripNonVideoTracks removes all trak boxes whose handler type is not "vide"
// (soun, clcp, text, subt, hint, …) and their corresponding trex entries from
// the moov box in-place. Returns the set of remaining video track IDs.
func stripNonVideoTracks(moov *mp4.MoovBox) map[uint32]struct{} {
	videoIDs := make(map[uint32]struct{})
	dropIDs := make(map[uint32]struct{})

	for _, trak := range moov.Traks {
		if trak.Mdia != nil && trak.Mdia.Hdlr != nil && trak.Mdia.Hdlr.HandlerType == "vide" {
			videoIDs[trak.Tkhd.TrackID] = struct{}{}
		} else {
			dropIDs[trak.Tkhd.TrackID] = struct{}{}
		}
	}

	if len(dropIDs) == 0 {
		return videoIDs
	}

	keepTraks := moov.Traks[:0]
	for _, t := range moov.Traks {
		if _, drop := dropIDs[t.Tkhd.TrackID]; !drop {
			keepTraks = append(keepTraks, t)
		}
	}
	moov.Traks = keepTraks
	if len(keepTraks) > 0 {
		moov.Trak = keepTraks[0]
	} else {
		moov.Trak = nil
	}

	newChildren := moov.Children[:0]
	for _, child := range moov.Children {
		if child.Type() == "trak" {
			if _, drop := dropIDs[child.(*mp4.TrakBox).Tkhd.TrackID]; drop {
				continue
			}
		}
		newChildren = append(newChildren, child)
	}
	moov.Children = newChildren

	if moov.Mvex == nil {
		return videoIDs
	}
	keepTrexs := moov.Mvex.Trexs[:0]
	newMvex := moov.Mvex.Children[:0]
	for _, child := range moov.Mvex.Children {
		if child.Type() == "trex" {
			trex := child.(*mp4.TrexBox)
			if _, drop := dropIDs[trex.TrackID]; drop {
				continue
			}
			keepTrexs = append(keepTrexs, trex)
		}
		newMvex = append(newMvex, child)
	}
	moov.Mvex.Children = newMvex
	moov.Mvex.Trexs = keepTrexs
	if len(keepTrexs) > 0 {
		moov.Mvex.Trex = keepTrexs[0]
	} else {
		moov.Mvex.Trex = nil
	}

	return videoIDs
}
