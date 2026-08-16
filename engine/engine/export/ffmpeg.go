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
		"-f", "mp4",
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
func runFFmpeg(ffmpegPath, src, artPath, dst string, meta TrackMeta) error {
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
	)

	if meta.Title != "" { args = append(args, "-metadata", "title="+meta.Title) }
	if meta.ArtistName != "" { args = append(args, "-metadata", "artist="+meta.ArtistName) }
	if meta.AlbumArtist != "" { args = append(args, "-metadata", "album_artist="+meta.AlbumArtist) }
	if meta.AlbumName != "" { args = append(args, "-metadata", "album="+meta.AlbumName) }
	if meta.TrackNumber > 0 {
		track := fmt.Sprintf("%d", meta.TrackNumber)
		if meta.TrackTotal > 0 {
			track += fmt.Sprintf("/%d", meta.TrackTotal)
		}
		args = append(args, "-metadata", "track="+track)
	}
	if meta.DiscNumber > 0 {
		disc := fmt.Sprintf("%d", meta.DiscNumber)
		if meta.DiscTotal > 0 {
			disc += fmt.Sprintf("/%d", meta.DiscTotal)
		}
		args = append(args, "-metadata", "disc="+disc)
	}
	if meta.ReleaseDate != "" { args = append(args, "-metadata", "date="+meta.ReleaseDate) }
	if meta.Genre != "" { args = append(args, "-metadata", "genre="+meta.Genre) }
	if meta.Composer != "" { args = append(args, "-metadata", "composer="+meta.Composer) }
	if meta.Copyright != "" { args = append(args, "-metadata", "copyright="+meta.Copyright) }
	if meta.RecordLabel != "" { args = append(args, "-metadata", "publisher="+meta.RecordLabel) }
	if meta.Isrc != "" { args = append(args, "-metadata", "isrc="+meta.Isrc) }
	if meta.UPC != "" { args = append(args, "-metadata", "barcode="+meta.UPC) }

	args = append(args, "-y", dst)
	cmd := exec.Command(ffmpegPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg exited: %w", err)
	}
	return nil
}
