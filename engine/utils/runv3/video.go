package runv3

import (
	"bufio"
	"context"
	"fmt"
	"io"

	"github.com/itouakirai/mp4ff/mp4"
)

// StripAudioAndPassthrough strips the audio trak/trex from the CMAF fMP4 init
// segment and then copies all moof+mdat media fragments through verbatim.
//
// This replaces the FFmpeg -c:v copy -an remux for Apple Music MV streams.
// Overhead: ~1–3ms (init parse + encode); media segments: io.Copy only.
//
// Why needed: Apple's CMAF video segments declare an audio trak in the moov
// init box even though the HLS video playlist carries no audio samples.
// Chromium's MSE rejects mixed-track init segments appended to a video-only
// SourceBuffer on some builds.
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

	stripSounTracks(init.Moov)

	if err := init.Encode(dst); err != nil {
		return fmt.Errorf("write video init: %w", err)
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}

	if _, err := io.Copy(dst, br); err != nil && ctx.Err() != nil {
		return ctx.Err()
	}

	srcErr := <-srcErrCh
	if srcErr != nil && ctx.Err() == nil {
		return fmt.Errorf("video source: %w", srcErr)
	}
	return nil
}

// stripSounTracks removes all soun trak boxes and their corresponding trex
// entries from the moov box in-place.
func stripSounTracks(moov *mp4.MoovBox) {
	if moov == nil {
		return
	}

	// Collect audio track IDs.
	audioIDs := make(map[uint32]struct{})
	for _, trak := range moov.Traks {
		if trak.Mdia != nil && trak.Mdia.Hdlr != nil && trak.Mdia.Hdlr.HandlerType == "soun" {
			audioIDs[trak.Tkhd.TrackID] = struct{}{}
		}
	}
	if len(audioIDs) == 0 {
		return
	}

	// Rebuild Traks and Children without soun entries.
	keepTraks := moov.Traks[:0]
	for _, t := range moov.Traks {
		if _, drop := audioIDs[t.Tkhd.TrackID]; !drop {
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
			if _, drop := audioIDs[child.(*mp4.TrakBox).Tkhd.TrackID]; drop {
				continue
			}
		}
		newChildren = append(newChildren, child)
	}
	moov.Children = newChildren

	// Rebuild Mvex without soun trex entries.
	if moov.Mvex == nil {
		return
	}
	keepTrexs := moov.Mvex.Trexs[:0]
	newMvex := moov.Mvex.Children[:0]
	for _, child := range moov.Mvex.Children {
		if child.Type() == "trex" {
			trex := child.(*mp4.TrexBox)
			if _, drop := audioIDs[trex.TrackID]; drop {
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
}
