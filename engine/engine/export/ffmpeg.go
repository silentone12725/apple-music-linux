package export

import (
	"fmt"
	"os"
	"os/exec"
)

// runFFmpeg invokes ffmpeg to transcode src → dst.
// Used for ALAC (.m4a) → FLAC conversion.
// The caller is responsible for cleaning up dst on failure.
func runFFmpeg(ffmpegPath, src, dst string) error {
	if _, err := exec.LookPath(ffmpegPath); err != nil {
		return errFFmpegUnavailable
	}
	cmd := exec.Command(ffmpegPath,
		"-i", src,
		"-c:a", "flac",
		"-compression_level", "8",
		"-map_metadata", "0",
		"-y", // overwrite dst if it exists (we control the tmp name)
		dst,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg exited: %w", err)
	}
	return nil
}
