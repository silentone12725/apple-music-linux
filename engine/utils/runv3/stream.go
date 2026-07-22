package runv3

// stream.go — fragment-by-fragment streaming decryption pipeline.
//
// DecryptMP4Streaming decrypts an fMP4 stream one fragment at a time,
// writing each decrypted fragment to w immediately without buffering the full
// file.  This lets downstream consumers (HTTP server, named pipe, file) start
// reading before the upload is complete.
//
// StreamMvData combines parallel HLS segment download with streaming
// decryption via an io.Pipe so playback can start before all segments arrive.
//
// Robustness notes:
//   - Init segment: Apple emits ftyp + moov, but pssh boxes can follow moov
//     in some variants.  We consume boxes until we have a moov, then stop.
//   - Fragment structure: moof (+ optional emsg/prft) + mdat.  Unknown top-
//     level boxes between fragments are silently skipped.
//   - "no senc box in traf" is treated as an unencrypted fragment and passed
//     through unchanged.
//   - ctx cancellation exits the loop cleanly after the current fragment.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"

	"encoding/hex"

	"apple-music-cli/engine/pipeline"
	"github.com/itouakirai/mp4ff/mp4"
)

// audioTimescale extracts the timescale from the first audio track in an init
// segment. Falls back to 44100 (standard AAC) if not found.
func audioTimescale(init *mp4.InitSegment) uint64 {
	if init.Moov != nil {
		for _, trak := range init.Moov.Traks {
			if trak.Mdia != nil && trak.Mdia.Mdhd != nil && trak.Mdia.Mdhd.Timescale > 0 {
				return uint64(trak.Mdia.Mdhd.Timescale)
			}
		}
	}
	return 44100
}

// fragDurationTicks returns the total duration of frag in timescale ticks.
// It reads DefaultSampleDuration from tfhd (the correct source per ISO 14496-12)
// rather than using the stream timescale, which Trun.Duration takes as its
// fallback parameter. Apple Music AAC segments carry tfhd.DefaultSampleDuration=1024
// (one AAC-LC frame) and no per-sample durations in trun, so passing timescale
// (44100) would yield 44100×sampleCount ≈ 430 seconds instead of ~10 seconds.
func fragDurationTicks(frag *mp4.Fragment) uint64 {
	if frag.Moof == nil || frag.Moof.Traf == nil || frag.Moof.Traf.Trun == nil {
		return 0
	}
	var defaultSampleDuration uint32 = 1024 // AAC-LC: 1024 PCM samples per frame
	if frag.Moof.Traf.Tfhd != nil && frag.Moof.Traf.Tfhd.HasDefaultSampleDuration() {
		if d := frag.Moof.Traf.Tfhd.DefaultSampleDuration; d > 0 {
			defaultSampleDuration = d
		}
	}
	return frag.Moof.Traf.Trun.Duration(defaultSampleDuration)
}

// patchFragTfdt patches the tfdt box of frag to accumulatedTfdt, updates
// TrackID and SampleDescriptionIndex (matching ALAC behaviour), adjusts
// trun.DataOffset for any moof size change, and returns the new accumulated
// value for the next fragment. Mirrors cbcsSource.streamAttempt exactly.
func patchFragTfdt(frag *mp4.Fragment, accumulatedTfdt, timescale uint64) uint64 {
	if frag.Moof == nil || frag.Moof.Traf == nil {
		return accumulatedTfdt
	}

	oldSize := frag.Moof.Size()

	if frag.Moof.Traf.Tfdt != nil {
		frag.Moof.Traf.Tfdt.SetBaseMediaDecodeTime(accumulatedTfdt)
		frag.Moof.Traf.Tfdt.Version = 1
	} else {
		tfdt := mp4.CreateTfdt(accumulatedTfdt)
		tfdt.Version = 1
		frag.Moof.Traf.Tfdt = tfdt
		var newChildren []mp4.Box
		for _, child := range frag.Moof.Traf.Children {
			if child.Type() == "trun" {
				newChildren = append(newChildren, tfdt)
			}
			newChildren = append(newChildren, child)
		}
		frag.Moof.Traf.Children = newChildren
	}

	if frag.Moof.Traf.Tfhd != nil {
		frag.Moof.Traf.Tfhd.TrackID = 1
		if frag.Moof.Traf.Tfhd.HasSampleDescriptionIndex() {
			frag.Moof.Traf.Tfhd.SampleDescriptionIndex = 1
		}
	}

	newSize := frag.Moof.Size()
	sizeDiff := int32(newSize) - int32(oldSize)
	if sizeDiff != 0 && frag.Moof.Traf.Trun != nil && frag.Moof.Traf.Trun.HasDataOffset() {
		frag.Moof.Traf.Trun.DataOffset += sizeDiff
	}

	accumulatedTfdt += fragDurationTicks(frag)
	return accumulatedTfdt
}

// readInitSegment reads boxes from r until it finds a moov box, returning a
// populated InitSegment.  Only ftyp and moov are added to the init segment —
// pssh and other top-level boxes are consumed but discarded.  This mirrors
// mp4.DecodeFile, which builds f.Init with only ftyp + moov, so both decrypt
// paths produce byte-identical init segments and mpv can render the output.
// Returns the offset after all consumed boxes.
func readInitSegment(r io.Reader) (*mp4.InitSegment, uint64, error) {
	init := mp4.NewMP4Init()
	var offset uint64
	hasMoov := false
	// Apple emits at most a small number of boxes before moov; limit loops
	// to avoid spinning forever on a malformed or truncated stream.
	for i := 0; i < 64 && !hasMoov; i++ {
		box, err := mp4.DecodeBox(offset, r)
		if err != nil {
			return nil, offset, fmt.Errorf("init box %d: %w", i, err)
		}
		offset += box.Size()
		// Mirror mp4.DecodeFile: only ftyp and moov enter the InitSegment.
		// pssh and other boxes are consumed (to advance the reader) but not
		// written to the output, eliminating the DRM-signalling pssh that
		// would otherwise cause mpv to refuse to render the video track.
		switch box.Type() {
		case "ftyp", "moov":
			init.AddChild(box)
		}
		if box.Type() == "moov" {
			hasMoov = true
		}
	}
	if !hasMoov {
		return nil, offset, fmt.Errorf("no moov box found in init segment")
	}
	return init, offset, nil
}

// readNextFragment reads one logical fragment (moof + optional emsg/prft +
// mdat) from r, advancing *offset.
// Returns (nil, io.EOF) when the stream ends cleanly after a fragment boundary.
// Unknown top-level boxes (e.g. styp, sidx) are skipped so the caller is
// not confused by CMAF-style segment headers.
func readNextFragment(r io.Reader, offset *uint64) (*mp4.Fragment, error) {
	frag := mp4.NewFragment()
	hasMoof := false
	for {
		box, err := mp4.DecodeBox(*offset, r)
		if err != nil {
			if !hasMoof && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)) {
				return nil, io.EOF // clean end between fragments
			}
			return nil, err
		}
		*offset += box.Size()
		switch box.Type() {
		case "moof", "emsg", "prft":
			frag.AddChild(box)
			hasMoof = true
		case "mdat":
			if !hasMoof {
				// mdat without moof — skip (shouldn't happen in valid fMP4).
				continue
			}
			frag.AddChild(box)
			return frag, nil
		case "styp", "sidx", "ssix":
			// CMAF segment-level boxes between fragments — skip.
		default:
			if hasMoof {
				// Unexpected box inside a fragment; include to be safe.
				frag.AddChild(box)
			}
			// Before moof: ignore unknown boxes.
		}
	}
}

// DecryptMP4Streaming decrypts an fMP4 stream fragment by fragment, writing
// each decrypted fragment to w immediately.
//
// It handles the full Apple Music fragment layout:
//   - Variable number of init boxes (ftyp, pssh, moov)
//   - Optional CMAF styp/sidx between segments
//   - CBCS and CENC encryption schemes
//   - Unencrypted fragments ("no senc box in traf")
func DecryptMP4Streaming(ctx context.Context, r io.Reader, key []byte, w io.Writer) error {
	br := bufio.NewReaderSize(r, 1<<20) // 1 MiB read-ahead

	init, offset, err := readInitSegment(br)
	if err != nil {
		return fmt.Errorf("init segment: %w", err)
	}

	decryptInfo, err := mp4.DecryptInit(init)
	if err != nil {
		return fmt.Errorf("decrypt init: %w", err)
	}
	if err := init.Encode(w); err != nil {
		return fmt.Errorf("write init: %w", err)
	}

	// Patch tfdt to be monotonically increasing (same fix as ALAC).
	// Seed from the first fragment's actual tfdt so VLC reports the correct
	// absolute playback position — identical approach works for both initial
	// play and seek (Apple HLS segments carry absolute decode timestamps).
	timescale := audioTimescale(init)
	var (
		accumulatedTfdt uint64
		tfdtSeeded      bool
	)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		frag, err := readNextFragment(br, &offset)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read fragment: %w", err)
		}

		if !tfdtSeeded {
			if frag.Moof != nil && frag.Moof.Traf != nil && frag.Moof.Traf.Tfdt != nil {
				accumulatedTfdt = frag.Moof.Traf.Tfdt.BaseMediaDecodeTime()
			}
			tfdtSeeded = true
		}
		accumulatedTfdt = patchFragTfdt(frag, accumulatedTfdt, timescale)

		decErr := mp4.DecryptFragment(frag, decryptInfo, key)
		if decErr != nil && !isNoSencBox(decErr) {
			return fmt.Errorf("decrypt fragment: %w", decErr)
		}
		// "no senc box in traf" → unencrypted fragment, pass through as-is.

		if err := frag.Encode(w); err != nil {
			return fmt.Errorf("write fragment: %w", err)
		}
	}
}

// PassthroughStreaming reads an fMP4 stream, strips the PSSH box from the init
// segment, and copies all fragments to w unchanged. Use for AAC content that
// Apple Music serves without content-level encryption (URL-based access control
// only). The PSSH strip is required so Chromium's MSE does not attempt to
// initialise a CDM for clear content and block playback.
func PassthroughStreaming(ctx context.Context, r io.Reader, w io.Writer) error {
	br := bufio.NewReaderSize(r, 1<<20)

	init, _, err := readInitSegment(br)
	if err != nil {
		return fmt.Errorf("init segment: %w", err)
	}
	if err := init.Encode(w); err != nil {
		return fmt.Errorf("write init: %w", err)
	}

	timescale := audioTimescale(init)
	var (
		accumulatedTfdt uint64
		tfdtSeeded      bool
	)

	// On the seek path, seed tfdt accumulator from actualStart so the trimming
	// loop can track absolute position from the segment boundary.
	if actualStart, ok := pipeline.ActualStartFromContext(ctx); ok && actualStart > 0 {
		accumulatedTfdt = uint64(actualStart * float64(timescale))
		tfdtSeeded = true
	}

	// seekTarget is the exact user-requested position. We skip leading fragments
	// until the accumulated time reaches seekTarget so audio starts within one
	// fragment of where the user clicked. We compare fragment END times
	// (accumulatedTfdt + fragDuration) so the first fragment whose end exceeds
	// seekTarget is the one we output — it contains the seek point.
	// Apple Music AAC segments have no native tfdts (patchFragTfdt inserts them),
	// so we rely entirely on the accumulated position from actualStart.
	seekTarget, hasSeekTarget := pipeline.SeekTargetFromContext(ctx)
	seekTargetTicks := uint64(seekTarget * float64(timescale))

	var offset uint64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		frag, err := readNextFragment(br, &offset)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read fragment: %w", err)
		}

		if hasSeekTarget {
			dur := fragDurationTicks(frag)
			log.Printf("[passthrough] trim check: dur=%d accTfdt=%d seekTicks=%d hasTrun=%v",
				dur, accumulatedTfdt, seekTargetTicks, frag.Moof != nil && frag.Moof.Traf != nil && frag.Moof.Traf.Trun != nil)
			if dur > 0 && accumulatedTfdt+dur <= seekTargetTicks {
				// Fragment ends at or before seekTarget — drop it.
				accumulatedTfdt += dur
				continue
			}
			// dur==0 means we can't determine duration — output to avoid skipping all.
			log.Printf("[passthrough] seek trim: first output at %.3fs (target=%.3fs dur=%d)",
				float64(accumulatedTfdt)/float64(timescale), seekTarget, dur)
			hasSeekTarget = false
		}

		if !tfdtSeeded {
			if frag.Moof != nil && frag.Moof.Traf != nil && frag.Moof.Traf.Tfdt != nil {
				accumulatedTfdt = frag.Moof.Traf.Tfdt.BaseMediaDecodeTime()
			}
			tfdtSeeded = true
		}
		accumulatedTfdt = patchFragTfdt(frag, accumulatedTfdt, timescale)
		if err := frag.Encode(w); err != nil {
			return fmt.Errorf("write fragment: %w", err)
		}
	}
}

// StreamMvData downloads HLS segments in parallel, assembles them in order
// through an io.Pipe, and streams the assembled data through
// DecryptMP4Streaming into w.  The first decrypted data reaches w as soon as
// the init segment and first media fragment arrive — well before all segments
// are downloaded.
func StreamMvData(ctx context.Context, keyAndUrls string, w io.Writer) error {
	parts := strings.SplitN(keyAndUrls, ";", 2)
	if len(parts) < 2 {
		return fmt.Errorf("invalid keyAndUrls")
	}
	keyParts := strings.SplitN(parts[0], ":", 2)
	if len(keyParts) < 2 {
		return fmt.Errorf("invalid key format")
	}
	keyBytes, err := hex.DecodeString(keyParts[1])
	if err != nil {
		return fmt.Errorf("key decode: %w", err)
	}
	urlList := strings.Split(parts[1], ";")

	// pipe: download goroutine writes assembled encrypted bytes →
	//       DecryptMP4Streaming reads and decrypts them fragment by fragment.
	pr, pw := io.Pipe()

	go func() {
		limiter := newAimdLimiter(8, 2, 32)
		downloadAndAssemble(ctx, urlList, pw, limiter)
		pw.Close()
	}()

	return DecryptMP4Streaming(ctx, pr, keyBytes, w)
}
