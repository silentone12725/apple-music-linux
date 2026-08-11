package export

import (
	"fmt"
	"os"
	"os/exec"
)

// muxVideoAudio combines a video-only fMP4 and an audio-only fMP4 into a
// single MP4 with -c copy.  Used for music-video exports where the session
// returns separate video and audio streams.
func muxVideoAudio(ffmpegPath, videoPath, audioPath, outPath string) error {
	if _, err := exec.LookPath(ffmpegPath); err != nil {
		return errFFmpegUnavailable
	}
	cmd := exec.Command(ffmpegPath,
		"-i", videoPath,
		"-i", audioPath,
		"-map", "0:v",
		"-map", "1:a",
		"-c:v", "copy",
		"-c:a", "copy",
		"-movflags", "+faststart",
		"-y",
		outPath,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg mux: %w", err)
	}
	return nil
}

// runFFmpeg invokes ffmpeg to transcode src → dst (ALAC .m4a → FLAC).
// artPath is an optional path to a cover image file; when non-empty it is
// passed as a second -i input so ffmpeg embeds it as a METADATA_BLOCK_PICTURE,
// which is more reliable than trying to copy the covr MP4 box across formats.
// The caller is responsible for cleaning up dst on failure.
func runFFmpeg(ffmpegPath, src, artPath, dst string) error {
	if _, err := exec.LookPath(ffmpegPath); err != nil {
		return errFFmpegUnavailable
	}
	args := []string{"-i", src}
	if artPath != "" {
		args = append(args,
			"-i", artPath,
			"-map", "0:a",
			"-map", "1:v",
			"-c:a", "flac",
			"-c:v", "copy",
			"-disposition:v", "attached_pic",
		)
	} else {
		args = append(args, "-map", "0:a", "-c:a", "flac")
	}
	args = append(args,
		"-compression_level", "8",
		"-map_metadata", "0",
		"-y",
		dst,
	)
	cmd := exec.Command(ffmpegPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg exited: %w", err)
	}
	return nil
}
