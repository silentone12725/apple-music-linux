package fairplay

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/itouakirai/mp4ff/mp4"

	"engine/core/tracer"
	"engine/core/hls"
	"engine/core/pipeline"
	"engine/utils/alacstream"
)

// DialerFromAddr returns a CBCSDialer that dials the given TCP address directly.
// Intended for tests and legacy callers that hold a raw address string.
func DialerFromAddr(addr string) CBCSDialer { return addrDialer(addr) }

type addrDialer string

func (a addrDialer) DialCBCS(ctx context.Context) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", string(a))
	if err != nil {
		return nil, fmt.Errorf("cbcs dial %s: %w", string(a), err)
	}
	return conn, nil
}

// cbcsPrefetchKey is the generic FairPlay key URI used by all Apple Music
// catalog enhanced-HLS variants.  The TCP socket treats it specially — the
// caller must send "0" as the adamID instead of the real track ID.
const cbcsPrefetchKey = "skd://itunes.apple.com/P000000000/s1/e1"

// cbcsHTTPClient is modeled after alacstream.alacClient: fields copied by code
// inspection (DisableCompression, MaxIdleConns=8, MaxIdleConnsPerHost=4,
// IdleConnTimeout=90s, 30s dial/keepalive).  Not runtime-compared against
// legacy.  Using http.DefaultClient here risks hanging on a stalled CDN.
var cbcsHTTPClient = &http.Client{
	Transport: &http.Transport{
		DisableCompression:  true,
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		// Force IPv4: Apple CDN AAAA records may resolve but be unreachable.
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp4", addr)
		},
	},
}

// cbcsStallTimeout is how long a Read from the fMP4 response body may stall
// (i.e. return 0 bytes) before the download is considered hung and aborted.
// Mirrors the 30s stall timeout in alacstream.runAttempt.
const cbcsStallTimeout = 30 * time.Second

// stallDetector wraps an io.Reader and cancels ctx if no progress (≥ threshold
// bytes read) is made within the configured timeout.  Modeled after
// TimedResponseBody in runv2, which guards against Apple Music CDN connections
// that stay open but stop delivering bytes.
//
// Timer-on-EOF: the timer is NOT stopped when Read returns EOF.  runv2 has the
// same behavior — TimedResponseBody.Read returns early on any error without
// resetting or stopping the timer.  In both implementations the deferred
// cancel(nil) cancels the context before the 30s timer fires, so the late
// cancel(ErrTimeout) is a no-op.  Investigate before changing either path.
type stallDetector struct {
	body      io.Reader
	timer     *time.Timer
	timeout   time.Duration
	threshold int
	cancel    context.CancelCauseFunc
}

func newStallDetector(body io.Reader, timeout time.Duration, cancel context.CancelCauseFunc) *stallDetector {
	sd := &stallDetector{
		body:      body,
		timeout:   timeout,
		threshold: 256,
		cancel:    cancel,
	}
	sd.timer = time.AfterFunc(timeout, func() {
		cancel(alacstream.ErrTimeout)
	})
	return sd
}

func (sd *stallDetector) Read(p []byte) (int, error) {
	n, err := sd.body.Read(p)
	if n >= sd.threshold {
		sd.timer.Reset(sd.timeout)
	}
	return n, err
}

// CBCSDialer is the minimal interface CBCSSource requires to open a
// FairPlay decryption connection. DRMManager implements this for Phase 1
// (subprocess backend, TCP socket). In Phase 2 (EmbeddedBackend), the same
// interface is implemented via an in-process net.Conn backed by CGO calls.
//
// Defined here (not in engine/drm) so that engine/fairplay does not import
// engine/drm, preserving the one-way dependency: drm → fairplay is forbidden.
type CBCSDialer interface {
	// DialCBCS opens one decryption session. The caller owns the connection
	// and speaks the runv2 FairPlay wire protocol (sendString + DecryptFragment).
	// The connection must be closed after the last fragment is sent.
	DialCBCS(ctx context.Context) (net.Conn, error)
}

// CBCSSource returns a pipeline.Source that downloads and decrypts a FairPlay
// CBCS-encrypted Apple Music track using the wrapper's TCP socket protocol.
//
// The entire encrypted fMP4 is downloaded as a single file (Apple Music CBCS
// playlists are byterange playlists pointing at one file).  Each fragment is
// sent through the TCP socket opened by dialer for in-place decryption.
//
// Parameters:
//   - adamID:     Apple Music track ID — sent to the socket for key lookup
//   - dialer:     opens a FairPlay decryption connection (DRMManager in production)
//   - fileURL:    URL of the single encrypted fMP4 file
//   - keyURIs:    one per playlist segment; sent to the socket before each fragment
//   - durationMs: total track duration in milliseconds (from catalog metadata);
//     used to patch mvhd.Duration so players (mpv, VLC) know the
//     correct playback length.  Pass 0 to leave the moov unchanged.
func CBCSSource(adamID string, dialer CBCSDialer, fileURL string, keyURIs []string, durationMs int) pipeline.Source {
	return &cbcsSource{
		adamID:     adamID,
		dialer:     dialer,
		fileURL:    fileURL,
		keyURIs:    keyURIs,
		durationMs: durationMs,
	}
}

type cbcsSource struct {
	adamID     string
	dialer     CBCSDialer
	fileURL    string
	keyURIs    []string
	durationMs int // 0 = leave moov duration unchanged
}

// Stream implements pipeline.Source.  It wraps streamAttempt in a retry loop
// derived from alacstream.Run by code inspection: up to 3 attempts, exponential
// backoff (1s, 2s), retrying the full download+decrypt cycle on any error.
//
// Behavioral difference from legacy: the backoff sleep here uses a select on
// ctx.Done() so cancellation interrupts the wait.  alacstream.Run uses time.Sleep,
// which cannot be cancelled.  Neither path has been runtime-compared; this
// difference is a design choice, not a verified improvement.
// Stream implements pipeline.Source.  Retry logic derived from alacstream.Run:
// up to 3 attempts, exponential backoff (1s, 2s).
//
// Retry safety: retries are only allowed before any bytes have been written to
// w.  Once bytes have been committed (e.g. HTTP response headers flushed with
// the init segment), retrying would write a second init segment into the
// already-open HTTP response, producing invalid fMP4.  In that case the error
// is returned immediately without retry so the caller can log and close.
//
// Behavioral note: alacstream.Run uses time.Sleep for the retry backoff, which
// cannot be cancelled.  This implementation uses a select on ctx.Done() so
// cancellation interrupts the wait.  This is a deliberate adaptation — not
// proven to be equivalent in all scenarios.
func (s *cbcsSource) Stream(ctx context.Context, w io.Writer) error {
	const maxRetries = 3
	// Track whether any bytes reached w. Retrying after a partial write
	// would corrupt the output stream (D7 in behavioral-parity-audit.md).
	tw := &writeTracker{w: w}
	var err error
	tr := tracer.FromContext(ctx)
	for attempt := range maxRetries {
		err = s.streamAttempt(ctx, tw)
		if err == nil {
			return nil
		}
		if tw.wrote > 0 {
			// Bytes already sent — cannot retry cleanly.
			fmt.Printf("cbcs: attempt %d failed after %d bytes written — not retrying: %v\n",
				attempt+1, tw.wrote, err)
			return err
		}
		if attempt < maxRetries-1 {
			tr.RecordRetry()
			wait := time.Duration(1<<attempt) * time.Second
			fmt.Printf("cbcs: attempt %d failed (%v), retrying in %v…\n", attempt+1, err, wait)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
		}
	}
	return err
}

// writeTracker counts bytes written so Stream can detect partial writes.
type writeTracker struct {
	w     io.Writer
	wrote int64
}

func (t *writeTracker) Write(p []byte) (int, error) {
	n, err := t.w.Write(p)
	t.wrote += int64(n)
	return n, err
}

// CBCSSeekableSource returns a pipeline.SeekableSource for a FairPlay CBCS
// stream.  On SourceFrom it computes the start fragment from segment durations
// and returns a cbcsSkipSource that downloads the full fMP4 but discards the
// fragments before the seek point — no byte-range tricks needed.
func CBCSSeekableSource(adamID string, dialer CBCSDialer, media *hls.CBCSMedia, durationMs int) pipeline.SeekableSource {
	return &cbcsSeekableSource{
		adamID:     adamID,
		dialer:     dialer,
		media:      media,
		durationMs: durationMs,
	}
}

type cbcsSeekableSource struct {
	adamID     string
	dialer     CBCSDialer
	media      *hls.CBCSMedia
	durationMs int
}

func (s *cbcsSeekableSource) Stream(ctx context.Context, w io.Writer) error {
	src := &cbcsSource{
		adamID:     s.adamID,
		dialer:     s.dialer,
		fileURL:    s.media.FileURL,
		keyURIs:    s.media.KeyURIs,
		durationMs: s.durationMs,
	}
	return src.Stream(ctx, w)
}

func (s *cbcsSeekableSource) SourceFrom(startSec float64) (pipeline.Source, float64) {
	durs := s.media.SegmentDurations
	if startSec <= 0 || len(durs) == 0 {
		return s, 0
	}
	var acc float64
	startFrag := len(durs) - 1 // default: clamp to last segment
	actualStart := acc
	for i, d := range durs {
		if acc+d > startSec {
			startFrag = i
			actualStart = acc
			break
		}
		acc += d
	}
	// Find the effective key URI at startFrag (last non-empty at or before startFrag).
	startKey := ""
	for i := 0; i <= startFrag && i < len(s.media.KeyURIs); i++ {
		if s.media.KeyURIs[i] != "" {
			startKey = s.media.KeyURIs[i]
		}
	}
	return &cbcsSkipSource{
		adamID:     s.adamID,
		dialer:     s.dialer,
		fileURL:    s.media.FileURL,
		keyURIs:    s.media.KeyURIs,
		durationMs: s.durationMs,
		startFrag:  startFrag,
		startKey:   startKey,
	}, actualStart
}

// cbcsSkipSource downloads the full fMP4 but skips (reads+discards) the first
// startFrag fragments, outputting only init + fragments[startFrag:].
// The tfdt accumulation is carried through skipped fragments so timestamps are
// correct for MSE even though the stream starts mid-file.
type cbcsSkipSource struct {
	adamID     string
	dialer     CBCSDialer
	fileURL    string
	keyURIs    []string
	durationMs int
	startFrag  int
	startKey   string
}

func (s *cbcsSkipSource) Stream(ctx context.Context, w io.Writer) error {
	tw := &writeTracker{w: w}
	tr := tracer.FromContext(ctx)
	var err error
	for attempt := range 3 {
		err = s.streamAttemptSkip(ctx, tw)
		if err == nil {
			return nil
		}
		if tw.wrote > 0 {
			return err
		}
		if attempt < 2 {
			tr.RecordRetry()
			wait := time.Duration(1<<attempt) * time.Second
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
		}
	}
	return err
}

// patchMoovDuration fixes mvhd/tkhd/mdhd duration fields so that players
// display the correct total length. Apple Music CMAF stores duration=0 in
// the moov box (CMAF convention); without this patch mpv stops after the
// first fragment.
func patchMoovDuration(init *mp4.InitSegment, durationMs int) {
	if durationMs <= 0 || init.Moov == nil || init.Moov.Mvhd == nil {
		return
	}
	ts := uint64(init.Moov.Mvhd.Timescale)
	if ts == 0 {
		ts = 1000
	}
	totalDur := uint64(durationMs) * ts / 1000
	init.Moov.Mvhd.Duration = totalDur
	for _, trak := range init.Moov.Traks {
		if trak.Tkhd != nil {
			trak.Tkhd.Duration = totalDur
		}
		if trak.Mdia != nil && trak.Mdia.Mdhd != nil {
			mdhd := trak.Mdia.Mdhd
			mdhd.Duration = uint64(durationMs) * uint64(mdhd.Timescale) / 1000
		}
	}
}

// skipFragTfdtDelta returns the total decode-time covered by frag without
// modifying it. Used to keep accumulatedTfdt in sync while discarding leading
// fragments during a seek.
func skipFragTfdtDelta(frag *mp4.Fragment) uint64 {
	if frag.Moof == nil || frag.Moof.Traf == nil {
		return 0
	}
	traf := frag.Moof.Traf
	dur := uint32(4096)
	if traf.Tfhd != nil && traf.Tfhd.HasDefaultSampleDuration() {
		if d := traf.Tfhd.DefaultSampleDuration; d > 0 {
			dur = d
		}
	}
	var total uint64
	for _, t := range traf.Truns {
		total += t.Duration(dur)
	}
	return total
}

// patchAlacFragment patches tfdt, tfhd, and data offsets in frag and returns
// the updated accumulated decode time for the next fragment. No-op if frag has
// no moof or traf.
//
// ALAC-specific: accumulates using ALL Truns (ALAC moofs carry 11 truns).
// Using only the first trun produces a 65536-sample step instead of 659456,
// causing VLC to report "Fragment sequence discontinuity" at ~28s.
func patchAlacFragment(frag *mp4.Fragment, accumulatedTfdt uint64) uint64 {
	if frag.Moof == nil || frag.Moof.Traf == nil {
		return accumulatedTfdt
	}
	traf := frag.Moof.Traf
	oldSize := frag.Moof.Size()

	if traf.Tfdt != nil {
		traf.Tfdt.SetBaseMediaDecodeTime(accumulatedTfdt)
		traf.Tfdt.Version = 1
	} else {
		// ISOBMFF requires tfdt to be placed BEFORE trun.
		tfdt := mp4.CreateTfdt(accumulatedTfdt)
		tfdt.Version = 1
		traf.Tfdt = tfdt
		var newChildren []mp4.Box
		for _, child := range traf.Children {
			if child.Type() == "trun" {
				newChildren = append(newChildren, tfdt)
			}
			newChildren = append(newChildren, child)
		}
		traf.Children = newChildren
	}

	// Apple's CDN sometimes mutates TrackID and SampleDescriptionIndex in
	// subsequent fragments, causing ffmpeg to silently skip the trun box.
	dur := uint32(4096)
	if traf.Tfhd != nil {
		traf.Tfhd.TrackID = 1
		if traf.Tfhd.HasSampleDescriptionIndex() {
			traf.Tfhd.SampleDescriptionIndex = 1
		}
		if traf.Tfhd.HasDefaultSampleDuration() {
			if d := traf.Tfhd.DefaultSampleDuration; d > 0 {
				dur = d
			}
		}
	}

	newSize := frag.Moof.Size()
	sizeDiff := int32(newSize) - int32(oldSize)
	if sizeDiff != 0 {
		for _, t := range traf.Truns {
			if t.HasDataOffset() {
				t.DataOffset += sizeDiff
			}
		}
	}

	for _, t := range traf.Truns {
		accumulatedTfdt += t.Duration(dur)
	}
	return accumulatedTfdt
}

// patchAlacFragmentSeq is like patchAlacFragment but also patches
// mfhd.SequenceNumber to seqNum. Apple's fMP4 starts at 1 (ISOBMFF-legal)
// but VLC's mp4 demuxer tracks from 0 and reports "Fragment sequence
// discontinuity" on the first fragment if it sees 1.
func patchAlacFragmentSeq(frag *mp4.Fragment, seqNum int, accumulatedTfdt uint64) uint64 {
	if frag.Moof != nil && frag.Moof.Mfhd != nil {
		frag.Moof.Mfhd.SequenceNumber = uint32(seqNum)
	}
	return patchAlacFragment(frag, accumulatedTfdt)
}

// sendInitialKey sends the seek start key to the decryption socket before the
// first kept fragment is decrypted.
func (s *cbcsSkipSource) sendInitialKey(rw *bufio.ReadWriter) error {
	if s.startKey == "" {
		return nil
	}
	if err := alacstream.SendString(rw, s.adamID); err != nil {
		return fmt.Errorf("cbcs seek: send adamID: %w", err)
	}
	if err := alacstream.SendString(rw, s.startKey); err != nil {
		return fmt.Errorf("cbcs seek: send startKey: %w", err)
	}
	return nil
}

// sendSeekFragKey switches decryption keys at fragment i when a new key URI is
// present in the kept region (not the first kept fragment, which was set by
// sendInitialKey).
func (s *cbcsSkipSource) sendSeekFragKey(i int, rw *bufio.ReadWriter) error {
	if i <= s.startFrag || i >= len(s.keyURIs) || s.keyURIs[i] == "" {
		return nil
	}
	if err := alacstream.SwitchKeys(rw); err != nil {
		return fmt.Errorf("cbcs seek: switch keys at %d: %w", i, err)
	}
	if err := alacstream.SendString(rw, s.adamID); err != nil {
		return fmt.Errorf("cbcs seek: send adamID %d: %w", i, err)
	}
	if err := alacstream.SendString(rw, s.keyURIs[i]); err != nil {
		return fmt.Errorf("cbcs seek: send key %d: %w", i, err)
	}
	return nil
}

// sendFragKey sends the key URI for fragment i to the decryption socket.
// Errors are intentionally ignored — key delivery is best-effort and a
// failure here manifests as a decrypt error on the next fragment.
func (s *cbcsSource) sendFragKey(i int, rw *bufio.ReadWriter) {
	if i >= len(s.keyURIs) || s.keyURIs[i] == "" {
		return
	}
	if i != 0 {
		alacstream.SwitchKeys(rw)
	}
	if s.keyURIs[i] == cbcsPrefetchKey {
		alacstream.SendString(rw, "0")
	} else {
		alacstream.SendString(rw, s.adamID)
	}
	alacstream.SendString(rw, s.keyURIs[i])
}

// skipStartFragments reads and discards startFrag fragments, accumulating
// the total TFDT delta needed so subsequent fragments have correct timestamps.
func skipStartFragments(inBuf *bufio.Reader, startOffset uint64, startFrag int) (accTfdt, finalOffset uint64, err error) {
	finalOffset = startOffset
	for i := range startFrag {
		frag, newOffset, ferr := alacstream.ReadNextFragment(inBuf, finalOffset)
		if ferr != nil {
			return 0, 0, fmt.Errorf("cbcs seek: skip fragment %d: %w", i, ferr)
		}
		if frag == nil {
			return 0, 0, fmt.Errorf("cbcs seek: EOF before startFrag %d (at %d)", startFrag, i)
		}
		finalOffset = newOffset
		accTfdt += skipFragTfdtDelta(frag)
	}
	return accTfdt, finalOffset, nil
}

// streamKeptFragment patches, decrypts, and writes one kept fragment; returns
// the updated accumulated TFDT.
func (s *cbcsSkipSource) streamKeptFragment(ctx context.Context, i int, frag *mp4.Fragment, accTfdt uint64,
	rw *bufio.ReadWriter, outBuf *bufio.Writer, tracks map[uint32]mp4.DecryptTrackInfo, tr *tracer.Tracer,
) (uint64, error) {
	accTfdt = patchAlacFragment(frag, accTfdt)
	if err := s.sendSeekFragKey(i, rw); err != nil {
		return accTfdt, err
	}
	if err := alacstream.DecryptFragment(frag, tracks, rw); err != nil {
		return accTfdt, fmt.Errorf("cbcs seek: decrypt fragment %d: %w", i, err)
	}
	if err := frag.Encode(outBuf); err != nil {
		return accTfdt, fmt.Errorf("cbcs seek: encode fragment %d: %w", i, err)
	}
	if err := outBuf.Flush(); err != nil {
		return accTfdt, fmt.Errorf("cbcs seek: flush fragment %d: %w", i, err)
	}
	if i == s.startFrag {
		tr.RecordPlaybackReady()
	}
	return accTfdt, nil
}

func (s *cbcsSkipSource) streamAttemptSkip(ctx context.Context, w io.Writer) error {
	dlCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	tr := tracer.FromContext(ctx)

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, s.fileURL, nil)
	if err != nil {
		return fmt.Errorf("cbcs seek: build request: %w", err)
	}
	tr.RecordCBCSDownloadStart()
	resp, err := cbcsHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("cbcs seek: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cbcs seek: download: HTTP %d", resp.StatusCode)
	}

	stalled := newStallDetector(resp.Body, cbcsStallTimeout, cancel)

	tr.RecordCBCSDialStart()
	conn, err := s.dialer.DialCBCS(ctx)
	if err != nil {
		return fmt.Errorf("cbcs seek: dial: %w", err)
	}
	tr.RecordCBCSDialConnected()
	defer alacstream.Close(conn)

	rw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	inBuf := bufio.NewReader(stalled)
	outBuf := bufio.NewWriter(w)

	init, offset, err := alacstream.ReadInitSegment(inBuf)
	if err != nil {
		return fmt.Errorf("cbcs seek: read init: %w", err)
	}
	if init == nil {
		return fmt.Errorf("cbcs seek: no init segment")
	}
	tracks, err := alacstream.TransformInit(init)
	if err != nil {
		return fmt.Errorf("cbcs seek: transform init: %w", err)
	}
	if err := alacstream.SanitizeInit(init); err != nil {
		fmt.Printf("cbcs seek: warning: sanitize init: %v\n", err)
	}
	patchMoovDuration(init, s.durationMs)
	if err := init.Encode(outBuf); err != nil {
		return fmt.Errorf("cbcs seek: encode init: %w", err)
	}
	if err := outBuf.Flush(); err != nil {
		return fmt.Errorf("cbcs seek: flush init: %w", err)
	}

	// Skip startFrag fragments: read+discard, accumulate tfdt for correct continuation.
	accumulatedTfdt, offset, err := skipStartFragments(inBuf, offset, s.startFrag)
	if err != nil {
		return err
	}

	if err := s.sendInitialKey(rw); err != nil {
		return err
	}

	for i := s.startFrag; ; i++ {
		frag, newOffset, err := alacstream.ReadNextFragment(inBuf, offset)
		if err != nil {
			return fmt.Errorf("cbcs seek: read fragment %d: %w", i, err)
		}
		if frag == nil {
			break
		}
		offset = newOffset
		accumulatedTfdt, err = s.streamKeptFragment(ctx, i, frag, accumulatedTfdt, rw, outBuf, tracks, tr)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *cbcsSource) streamAttempt(ctx context.Context, w io.Writer) error {
	dlCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	tr := tracer.FromContext(ctx)

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, s.fileURL, nil)
	if err != nil {
		return fmt.Errorf("cbcs: build request: %w", err)
	}
	tr.RecordCBCSDownloadStart()
	resp, err := cbcsHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("cbcs: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cbcs: download: HTTP %d", resp.StatusCode)
	}
	if hw, ok := w.(pipeline.HeaderWriter); ok && resp.ContentLength > 0 {
		hw.SetHeader("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}

	stalled := newStallDetector(resp.Body, cbcsStallTimeout, cancel)

	tr.RecordCBCSDialStart()
	conn, err := s.dialer.DialCBCS(ctx)
	if err != nil {
		return fmt.Errorf("cbcs: dial: %w", err)
	}
	tr.RecordCBCSDialConnected()
	defer alacstream.Close(conn)

	rw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	inBuf := bufio.NewReader(stalled)
	outBuf := bufio.NewWriter(w)

	init, offset, err := alacstream.ReadInitSegment(inBuf)
	if err != nil {
		return fmt.Errorf("cbcs: read init: %w", err)
	}
	if init == nil {
		return fmt.Errorf("cbcs: no init segment in file")
	}
	tracks, err := alacstream.TransformInit(init)
	if err != nil {
		return fmt.Errorf("cbcs: transform init: %w", err)
	}
	if err := alacstream.SanitizeInit(init); err != nil {
		fmt.Printf("cbcs: warning: sanitize init: %v\n", err)
	}
	patchMoovDuration(init, s.durationMs)
	if err := init.Encode(outBuf); err != nil {
		return fmt.Errorf("cbcs: encode init: %w", err)
	}
	if err := outBuf.Flush(); err != nil {
		return fmt.Errorf("cbcs: flush init: %w", err)
	}

	var accumulatedTfdt uint64
	for i := 0; ; i++ {
		frag, newOffset, err := alacstream.ReadNextFragment(inBuf, offset)
		if err != nil {
			return fmt.Errorf("cbcs: read fragment %d: %w", i, err)
		}
		if frag == nil {
			break
		}
		offset = newOffset

		accumulatedTfdt = patchAlacFragmentSeq(frag, i, accumulatedTfdt)
		s.sendFragKey(i, rw)

		if err := alacstream.DecryptFragment(frag, tracks, rw); err != nil {
			return fmt.Errorf("cbcs: decrypt fragment %d: %w", i, err)
		}
		if err := frag.Encode(outBuf); err != nil {
			return fmt.Errorf("cbcs: encode fragment %d: %w", i, err)
		}
		if err := outBuf.Flush(); err != nil {
			return fmt.Errorf("cbcs: flush fragment %d: %w", i, err)
		}
		if i == 0 {
			tr.RecordPlaybackReady()
		}
	}

	return nil
}
