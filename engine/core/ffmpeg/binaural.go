// Package ffmpeg provides audio transcoding stages built on the system ffmpeg binary.
//
// Binaural rendering pipeline — Linux equivalent of DTS Sound Unbound's I3DA
// HRTF renderer (DtsHrtfEnc.dll) and Dolby DAA headphone virtualizer:
//
//   Windows DTS Sound Unbound          │  This implementation
//   ──────────────────────────────────│──────────────────────────────────────
//   DTSXDecoder.dll (DTS:X JOC decode)│  ffmpeg EC-3/DTS decoder
//   ISpatialAudioMetadataClient        │  ffmpeg filter graph
//   DtsHrtfEnc::ProcessSingleBlock     │  ffmpeg headphone HRTF filter
//   DtsHrtfEnc::MixChannelBed         │  headphone accumulation
//   SPAC.crypt FIR filter bank        │  MIT KEMAR SOFA HRTF dataset
//
// Two render modes are supported, selected automatically at startup:
//
//   HRTF mode (preferred)
//     Requires /usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa (libmysofa)
//     and python3 + h5py.  Each of the 7.1 bed channels is convolved with
//     its speaker-position HRTF impulse response (FL=30°L, FR=30°R,
//     FC=0°, BL=110°L, BR=110°R, SL=90°L, SR=90°R, LFE=0°), then summed
//     to binaural stereo.  This directly mirrors DtsHrtfEnc::ProcessSingleBlock
//     using the MIT KEMAR HRTF dataset instead of DTS's proprietary SPAC files.
//
//   Crossfeed mode (fallback)
//     ITU-R BS.775-3 7.1→stereo pan matrix followed by Bauer stereophonic-
//     to-binaural (bs2b) crossfeed, matching the existing bed-channel path.
package ffmpeg

import (
	"context"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"

	"engine/core/autoeq"
	"engine/core/pipeline"
)

// BinauralSource wraps an audio source and transcodes it to binaural stereo
// AAC using FFmpeg.
//
// Surround mode (default): EC-3 7.1 input → HRTF convolution (MIT KEMAR SOFA
// headphone filter) or ITU-R BS.775 pan + bs2b crossfeed fallback → AAC fMP4.
//
// Stereo mode: stereo PCM/ALAC input → bs2b crossfeed + 48 kHz resample →
// AAC fMP4.  HRTF is not applied in stereo mode since the headphone filter
// requires multichannel input.
//
// Output is fragmented MP4 containing AAC LC at 256 kbps, suitable for MSE.
type BinauralSource struct {
	inner    pipeline.Source
	isStereo bool
}

// NewBinauralSource returns a BinauralSource for a multichannel (EC-3 7.1)
// source. HRTF convolution is attempted first; crossfeed is the fallback.
func NewBinauralSource(inner pipeline.Source) *BinauralSource {
	return &BinauralSource{inner: inner}
}

// NewBinauralStereoSource returns a BinauralSource for a stereo source (e.g.
// ALAC). Only bs2b crossfeed is applied — no pan matrix, no HRTF.
func NewBinauralStereoSource(inner pipeline.Source) *BinauralSource {
	return &BinauralSource{inner: inner, isStereo: true}
}

// crossfeedFilter is the fallback ffmpeg -af value for multichannel input
// (ITU-R BS.775 downmix + bs2b crossfeed + 48 kHz resample).
const crossfeedFilter = "pan=stereo|" +
	"FL<FL+0.707*FC+0.707*BL+0.707*SL+0.1*LFE|" +
	"FR<FR+0.707*FC+0.707*BR+0.707*SR+0.1*LFE," +
	"bs2b=profile=default," +
	"aresample=48000"

// stereoFilter is the ffmpeg -af value for stereo input (bs2b crossfeed only).
const stereoFilter = "bs2b=profile=default,aresample=48000"

// Stream transcodes the inner source to binaural stereo AAC and writes
// fragmented MP4 to w.
func (b *BinauralSource) Stream(ctx context.Context, w io.Writer) error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("binaural: ffmpeg not found in PATH: %w", err)
	}

	// Stereo input: bs2b crossfeed only — no pan matrix, no HRTF.
	if b.isStereo {
		return b.streamCrossfeedFilter(ctx, w, stereoFilter)
	}

	hrtf, err := GetHRTFSet()
	if err != nil {
		log.Printf("binaural: HRTF extraction failed (%v), using crossfeed fallback", err)
	}

	if hrtf != nil {
		return b.streamHRTF(ctx, w, hrtf)
	}
	return b.streamCrossfeedFilter(ctx, w, crossfeedFilter)
}

// eqFilterChain returns a comma-separated FFmpeg filter fragment for the
// currently saved AutoEQ settings, or "" if no EQ is configured.
func eqFilterChain() string {
	s, err := autoeq.LoadSettings()
	if err != nil || s == nil {
		return ""
	}
	return s.FFmpegChain()
}

// appendEQ appends the EQ filter chain to an existing filter string.
func appendEQ(base string) string {
	eq := eqFilterChain()
	if eq == "" {
		return base
	}
	return base + "," + eq
}

// streamHRTF renders using HRTF convolution. Two modes are supported:
//
//   - "stereo" mode (MIT KEMAR default): per-channel stereo IR WAVs,
//     FFmpeg headphone filter with hrir=stereo.
//   - "multich" mode (custom/bundled 14-ch WAV): single multichannel IR,
//     FFmpeg headphone filter with hrir=multich.
func (b *BinauralSource) streamHRTF(ctx context.Context, w io.Writer, hrtf *HRTFSet) error {
	if hrtf.Mode == "multich" {
		return b.streamHRTFMultich(ctx, w, hrtf)
	}
	return b.streamHRTFStereo(ctx, w, hrtf)
}

// streamHRTFMultich uses a single 14-channel HeSuVi WAV with hrir=multich.
func (b *BinauralSource) streamHRTFMultich(ctx context.Context, w io.Writer, hrtf *HRTFSet) error {
	af := appendEQ("aresample=48000")
	fc := fmt.Sprintf(
		"[0:a][1:a]headphone=map='FL|FC|FR|BL|BR|SL|SR':hrir=multich,loudnorm,%s",
		af,
	)
	return b.runFFmpeg(ctx, w, []string{
		"-v", "error",
		"-i", "pipe:0",
		"-i", hrtf.MultichWAV,
		"-filter_complex", fc,
		"-acodec", "aac",
		"-b:a", "256k",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	})
}

// streamHRTFStereo renders using per-channel HRTF convolution (headphone filter +
// MIT KEMAR SOFA IRs).  This is the full Linux equivalent of
// DtsHrtfEnc::ProcessSingleBlock for the 7.1 bed channels.
//
// FFmpeg filter graph:
//
//	[0:a]           – EC-3 7.1 input
//	[1:a]…[8:a]    – MIT KEMAR HRTF IR WAVs for FL FR FC BL BR SL SR LFE
//	[0:a][1:a]…[8:a]headphone=map='FL|FR|FC|BL|BR|SL|SR|LFE':hrir=stereo
//	                – convolve each channel with its HRTF IR, accumulate to
//	                  binaural stereo (L/R ear outputs)
//	loudnorm        – EBU R128 normalisation (matches DTS output level)
//	aresample=48000 – ensure 48 kHz for AAC encoder
func (b *BinauralSource) streamHRTFStereo(ctx context.Context, w io.Writer, hrtf *HRTFSet) error {
	channelOrder := []string{"FL", "FR", "FC", "BL", "BR", "SL", "SR", "LFE"}

	// Build ffmpeg argument list.
	// Input 0: the piped EC-3 bitstream.
	// Inputs 1–8: HRTF IR WAV files for each speaker.
	args := []string{
		"-v", "error",
		"-i", "pipe:0",
	}
	for _, ch := range channelOrder {
		args = append(args, "-i", hrtf.IRPaths[ch])
	}

	// Build the filter_complex string.
	// [0:a][1:a][2:a][3:a][4:a][5:a][6:a][7:a][8:a]headphone=...
	var fc strings.Builder
	for i := 0; i <= len(channelOrder); i++ {
		fmt.Fprintf(&fc, "[%d:a]", i)
	}
	af := appendEQ("aresample=48000")
	fc.WriteString("headphone=")
	fc.WriteString("map='FL|FR|FC|BL|BR|SL|SR|LFE':")
	fc.WriteString("hrir=stereo,")
	fc.WriteString("loudnorm,")
	fc.WriteString(af)

	args = append(args,
		"-filter_complex", fc.String(),
		"-acodec", "aac",
		"-b:a", "256k",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)

	return b.runFFmpeg(ctx, w, args)
}

// streamCrossfeedFilter renders with the given -af filter string.
// Used for both multichannel crossfeed fallback and stereo bs2b mode.
// AutoEQ is appended when configured.
func (b *BinauralSource) streamCrossfeedFilter(ctx context.Context, w io.Writer, af string) error {
	return b.runFFmpeg(ctx, w, []string{
		"-v", "error",
		"-i", "pipe:0",
		"-af", appendEQ(af),
		"-acodec", "aac",
		"-b:a", "256k",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	})
}

// runFFmpeg pipes the inner EC-3 source through ffmpeg with the given args.
func (b *BinauralSource) runFFmpeg(ctx context.Context, w io.Writer, args []string) error {
	pr, pw := io.Pipe()

	innerErr := make(chan error, 1)
	go func() {
		err := b.inner.Stream(ctx, pw)
		pw.CloseWithError(err)
		innerErr <- err
	}()

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdin = pr
	cmd.Stdout = w
	var ffmpegStderr strings.Builder
	cmd.Stderr = &ffmpegStderr

	if err := cmd.Run(); err != nil {
		pr.Close()
		se := strings.TrimSpace(ffmpegStderr.String())
		if se != "" {
			return fmt.Errorf("binaural: ffmpeg: %w (%s)", err, se)
		}
		return fmt.Errorf("binaural: ffmpeg: %w", err)
	}

	if err := <-innerErr; err != nil && err != io.EOF {
		return fmt.Errorf("binaural: inner source: %w", err)
	}
	return nil
}
