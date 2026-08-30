package export

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func lookFFmpeg(p string) error {
	if _, err := exec.LookPath(p); err != nil {
		return errFFmpegUnavailable
	}
	return nil
}

// findVLC returns the first VLC binary found on PATH: tries the explicit path,
// then "cvlc" (headless), then "vlc".
func findVLC(explicit string) (string, bool) {
	for _, candidate := range []string{explicit, "cvlc", "vlc"} {
		if candidate == "" {
			continue
		}
		if _, err := exec.LookPath(candidate); err == nil {
			return candidate, true
		}
	}
	return "", false
}

// runVLCToFLAC uses VLC to decode a lossless ALAC .m4a to a raw FLAC file.
// VLC's native MP4 demuxer correctly processes Apple's identical-tfdt fMP4
// without dropping fragments, unlike ffmpeg's mov demuxer.
// The output FLAC has correct audio data but STREAMINFO.total_samples=0
// (VLC streaming mode); tagFLAC re-encodes it to fix that.
func runVLCToFLAC(vlcPath, src, dst string) error {
	sout := fmt.Sprintf("#transcode{acodec=flac,channels=2}:std{access=file,mux=raw,dst=%s}",
		strings.ReplaceAll(dst, "}", "\\}"))
	cmd := exec.Command(vlcPath,
		"--intf", "dummy",
		"--no-video",
		"--sout", sout,
		"--play-and-exit",
		"-q",
		src,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("vlc transcode: %w", err)
	}
	return nil
}

// extractArtwork extracts the cover image from an .m4a (covr atom) to a
// standalone image file.  Returns an error if the m4a has no video stream.
func extractArtwork(ffmpegPath, m4aPath, outPath string) error {
	if err := lookFFmpeg(ffmpegPath); err != nil {
		return err
	}
	cmd := exec.Command(ffmpegPath,
		"-i", m4aPath,
		"-an",            // no audio
		"-vcodec", "copy",
		"-y", outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("extract artwork: %w\n%s", err, out)
	}
	return nil
}

// tagFLAC encodes src (WAV or raw FLAC from VLC) to FLAC with ffmpeg, embeds
// metadata tags, and optionally embeds a cover image from artPath.
// Re-encoding (not -c copy) is required because the source may be WAV PCM and
// ensures ffmpeg writes correct STREAMINFO.total_samples (fixes Duration: N/A).
func tagFLAC(ffmpegPath, src, artPath, dst string, meta TrackMeta) error {
	if err := lookFFmpeg(ffmpegPath); err != nil {
		return err
	}
	args := []string{"-i", src}
	if artPath != "" {
		args = append(args,
			"-i", artPath,
			"-map", "0:a",
			"-map", "1:v",
			"-c:a", "flac",
			"-compression_level", "8",
			"-c:v", "copy",
			"-disposition:v", "attached_pic",
		)
	} else {
		args = append(args,
			"-map", "0:a",
			"-c:a", "flac",
			"-compression_level", "8",
		)
	}
	args = append(args, "-map_metadata", "-1")

	if meta.Title != ""      { args = append(args, "-metadata", "title="+meta.Title) }
	if meta.ArtistName != "" { args = append(args, "-metadata", "artist="+meta.ArtistName) }
	if meta.AlbumArtist != "" { args = append(args, "-metadata", "album_artist="+meta.AlbumArtist) }
	if meta.AlbumName != ""  { args = append(args, "-metadata", "album="+meta.AlbumName) }
	if meta.TrackNumber > 0 {
		track := fmt.Sprintf("%d", meta.TrackNumber)
		if meta.TrackTotal > 0 { track += fmt.Sprintf("/%d", meta.TrackTotal) }
		args = append(args, "-metadata", "track="+track)
	}
	if meta.DiscNumber > 0 {
		disc := fmt.Sprintf("%d", meta.DiscNumber)
		if meta.DiscTotal > 0 { disc += fmt.Sprintf("/%d", meta.DiscTotal) }
		args = append(args, "-metadata", "disc="+disc)
	}
	if meta.ReleaseDate != "" { args = append(args, "-metadata", "date="+meta.ReleaseDate) }
	if meta.Genre != ""      { args = append(args, "-metadata", "genre="+meta.Genre) }
	if meta.Composer != ""   { args = append(args, "-metadata", "composer="+meta.Composer) }
	if meta.Copyright != ""  { args = append(args, "-metadata", "copyright="+meta.Copyright) }
	if meta.RecordLabel != "" { args = append(args, "-metadata", "publisher="+meta.RecordLabel) }
	if meta.Isrc != ""       { args = append(args, "-metadata", "isrc="+meta.Isrc) }
	if meta.UPC != ""        { args = append(args, "-metadata", "barcode="+meta.UPC) }

	args = append(args, "-f", "flac", "-y", dst)
	cmd := exec.Command(ffmpegPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg tag flac: %w", err)
	}
	return nil
}

// muxVideoAudio combines a video-only fMP4 and an audio-only fMP4 into a
// single MP4 with -c copy.  Used for music-video exports where the session
// returns separate video and audio streams.
func muxVideoAudio(ffmpegPath, videoPath, audioPath, outPath string) error {
	if err := lookFFmpeg(ffmpegPath); err != nil {
		return err
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

// addSubtitleTrack adds an SRT subtitle track to an existing MP4 in-place.
// Runs a second ffmpeg pass and atomically replaces inPath on success.
func addSubtitleTrack(ffmpegPath, inPath, srtPath string) error {
	if err := lookFFmpeg(ffmpegPath); err != nil {
		return err
	}
	tmp := inPath + ".sub.mp4"
	cmd := exec.Command(ffmpegPath,
		"-i", inPath,
		"-i", srtPath,
		"-map", "0:v", "-map", "0:a", "-map", "1:s",
		"-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
		"-metadata:s:s:0", "language=eng",
		"-movflags", "+faststart",
		"-f", "mp4", "-y", tmp,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("ffmpeg add subtitles: %w", err)
	}
	if err := os.Rename(tmp, inPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename subtitle output: %w", err)
	}
	return nil
}

// runFFmpeg invokes ffmpeg to transcode src → dst (ALAC .m4a → FLAC).
// artPath is an optional path to a cover image file; when non-empty it is
// passed as a second -i input so ffmpeg embeds it as a METADATA_BLOCK_PICTURE,
// which is more reliable than trying to copy the covr MP4 box across formats.
// The caller is responsible for cleaning up dst on failure.
func runFFmpeg(ffmpegPath, src, artPath, dst string, meta TrackMeta) error {
	if err := lookFFmpeg(ffmpegPath); err != nil {
		return err
	}
	args := []string{"-i", src}
	if artPath != "" {
		// Explicit artwork file supplied: use it as a second input.
		args = append(args,
			"-i", artPath,
			"-map", "0:a",
			"-map", "1:v",
			"-c:a", "flac",
			"-c:v", "copy",
			"-disposition:v", "attached_pic",
		)
	} else {
		// No separate artwork file: copy any artwork TagFile already embedded
		// in the source m4a (covr atom → video stream). The '?' makes the map
		// optional so ffmpeg does not fail when the source has no artwork.
		args = append(args,
			"-map", "0:a",
			"-map", "0:v?",
			"-c:a", "flac",
			"-c:v", "copy",
			"-disposition:v", "attached_pic",
		)
	}
	args = append(args,
		"-compression_level", "8",
		"-map_metadata", "-1", // start clean; explicit -metadata flags below set what we need
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
