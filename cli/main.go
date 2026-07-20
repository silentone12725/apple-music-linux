package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"main/utils/alacfix"
	"main/utils/ampapi"
	"main/utils/lyrics"
	"main/utils/manifest"
	"main/utils/runv2"
	"main/utils/runv3"
	"main/utils/structs"
	"main/utils/task"

	"github.com/grafov/m3u8"
	"github.com/spf13/pflag"

	"github.com/zhaarey/go-mp4tag"
	"gopkg.in/yaml.v2"
)

var (
	forbiddenNames     = regexp.MustCompile(`[/\\<>:"|?*]`)
	dl_atmos           bool
	dl_aac             bool
	dl_select          bool
	dl_song            bool
	play_stream        bool
	stream_player      string
	save_m3u8_playlist bool
	api_port           int
	Config             structs.ConfigSet
	counter            structs.Counter
	okDict             = make(map[string][]int)
	AddedTracks        []AddedTrack
)

type AddedTrack struct {
	Path     string `json:"path"`
	Artist   string `json:"artist"`
	ArtistID string `json:"artist_id"`
	Album    string `json:"album"`
	Song     string `json:"song"`
}

func loadConfig() error {
	data, err := os.ReadFile("config.yaml")
	if err != nil {
		return err
	}
	err = yaml.Unmarshal(data, &Config)
	if err != nil {
		return err
	}
	if len(Config.Storefront) != 2 {
		Config.Storefront = "us"
	}
	return nil
}

func LimitString(s string) string {
	if len([]rune(s)) > Config.LimitMax {
		return string([]rune(s)[:Config.LimitMax])
	}
	return s
}

func isInArray(arr []int, target int) bool {
	for _, num := range arr {
		if num == target {
			return true
		}
	}
	return false
}

func fileExists(path string) (bool, error) {
	f, err := os.Stat(path)
	if err == nil {
		return !f.IsDir(), nil
	} else if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func checkUrl(url string) (string, string) {
	pat := regexp.MustCompile(`^(?:https:\/\/(?:beta\.music|music|classical\.music)\.apple\.com\/(\w{2})(?:\/album|\/album\/.+))\/(?:id)?(\d[^\D]+)(?:$|\?)`)
	matches := pat.FindAllStringSubmatch(url, -1)

	if matches == nil {
		return "", ""
	} else {
		return matches[0][1], matches[0][2]
	}
}

// resolvePlayer picks a player binary for streaming.
// Explicit --player flag wins; otherwise auto-detects mpv → vlc → ffplay.
func resolvePlayer() string {
	if stream_player != "" {
		if _, err := exec.LookPath(stream_player); err == nil {
			return stream_player
		}
		fmt.Printf("⚠ Player %q not found, falling back to auto-detect\n", stream_player)
	}
	for _, p := range []string{"mpv", "vlc", "ffplay"} {
		if _, err := exec.LookPath(p); err == nil {
			return p
		}
	}
	return ""
}

func writeCover(sanAlbumFolder, name string, url string) (string, error) {
	originalUrl := url
	var ext string
	var covPath string
	if Config.CoverFormat == "original" {
		ext = strings.Split(url, "/")[len(strings.Split(url, "/"))-2]
		ext = ext[strings.LastIndex(ext, ".")+1:]
		covPath = filepath.Join(sanAlbumFolder, name+"."+ext)
	} else {
		covPath = filepath.Join(sanAlbumFolder, name+"."+Config.CoverFormat)
	}
	exists, err := fileExists(covPath)
	if err != nil {
		fmt.Println("Failed to check if cover exists.")
		return "", err
	}
	if exists {
		_ = os.Remove(covPath)
	}
	if Config.CoverFormat == "png" {
		re := regexp.MustCompile(`\{w\}x\{h\}`)
		parts := re.Split(url, 2)
		url = parts[0] + "{w}x{h}" + strings.Replace(parts[1], ".jpg", ".png", 1)
	}
	url = strings.Replace(url, "{w}x{h}", Config.CoverSize, 1)
	if Config.CoverFormat == "original" {
		url = strings.Replace(url, "is1-ssl.mzstatic.com/image/thumb", "a5.mzstatic.com/us/r1000/0", 1)
		url = url[:strings.LastIndex(url, "/")]
	}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	do, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer do.Body.Close()
	if do.StatusCode != http.StatusOK {
		if Config.CoverFormat == "original" {
			fmt.Println("Failed to get cover, falling back to " + ext + " url.")
			splitByDot := strings.Split(originalUrl, ".")
			last := splitByDot[len(splitByDot)-1]
			fallback := originalUrl[:len(originalUrl)-len(last)] + ext
			fallback = strings.Replace(fallback, "{w}x{h}", Config.CoverSize, 1)
			fmt.Println("Fallback URL:", fallback)
			req, err = http.NewRequest("GET", fallback, nil)
			if err != nil {
				fmt.Println("Failed to create request for fallback url.")
				return "", err
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
			do, err = http.DefaultClient.Do(req)
			if err != nil {
				fmt.Println("Failed to get cover from fallback url.")
				return "", err
			}
			defer do.Body.Close()
			if do.StatusCode != http.StatusOK {
				fmt.Println(fallback)
				return "", errors.New(do.Status)
			}
		} else {
			return "", errors.New(do.Status)
		}
	}
	f, err := os.Create(covPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = io.Copy(f, do.Body)
	if err != nil {
		return "", err
	}
	return covPath, nil
}

func writeLyrics(sanAlbumFolder, filename string, lrc string) error {
	lyricspath := filepath.Join(sanAlbumFolder, filename)
	f, err := os.Create(lyricspath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(lrc)
	if err != nil {
		return err
	}
	return nil
}

func contains(slice []string, item string) bool {
	for _, v := range slice {
		if v == item {
			return true
		}
	}
	return false
}


// CONVERSION FEATURE: Determine if source codec is lossy (rough heuristic by extension/codec name).
func isLossySource(ext string, codec string) bool {
	ext = strings.ToLower(ext)
	if ext == ".m4a" && (codec == "AAC" || strings.Contains(codec, "AAC") || strings.Contains(codec, "ATMOS")) {
		return true
	}
	if ext == ".mp3" || ext == ".opus" || ext == ".ogg" {
		return true
	}
	return false
}

// CONVERSION FEATURE: Build ffmpeg arguments for desired target.
func buildFFmpegArgs(ffmpegPath, inPath, outPath, targetFmt, extraArgs string) ([]string, error) {
	args := []string{"-hwaccel", "auto", "-y", "-i", inPath, "-loglevel", "error", "-map_metadata"}
	if Config.ConvertWithMetadata {
		args = append(args, "0")
	} else {
		args = append(args, "-1")
	}
	switch targetFmt {
	case "flac":
		// Map all streams and copy the embedded cover (attached_pic) so album
		// art survives the ALAC(.m4a) -> FLAC transcode. Without -map 0 / -c:v copy
		// ffmpeg only keeps the audio stream and the artwork is silently dropped.
		args = append(args, "-map", "0", "-c:a", "flac", "-c:v", "copy", "-disposition:v", "attached_pic")
	case "mp3":
		// VBR quality 2 ~ high quality
		args = append(args, "-c:a", "libmp3lame", "-qscale:a", "2")
	case "opus":
		// Medium/high quality
		args = append(args, "-c:a", "libopus", "-b:a", "192k", "-vbr", "on")
	case "wav":
		args = append(args, "-c:a", "pcm_s16le")
	case "copy":
		// Just container copy (probably pointless for same container)
		args = append(args, "-c", "copy")
	default:
		return nil, fmt.Errorf("unsupported convert-format: %s", targetFmt)
	}
	if extraArgs != "" {
		// naive split; for complex quoting you could enhance
		args = append(args, strings.Fields(extraArgs)...)
	}
	args = append(args, outPath)
	return args, nil
}

// CONVERSION FEATURE: Perform conversion if enabled.
func convertIfNeeded(track *task.Track) {
	if !Config.ConvertAfterDownload {
		return
	}
	if Config.ConvertFormat == "" {
		return
	}
	srcPath := track.SavePath
	if srcPath == "" {
		return
	}
	ext := strings.ToLower(filepath.Ext(srcPath))
	targetFmt := strings.ToLower(Config.ConvertFormat)

	// Map extension for output
	if targetFmt == "copy" {
		fmt.Println("Convert (copy) requested; skipping because it produces no new format.")
		return
	}

	if Config.ConvertSkipIfSourceMatch {
		if ext == "."+targetFmt {
			fmt.Printf("Conversion skipped (already %s)\n", targetFmt)
			return
		}
	}

	outBase := strings.TrimSuffix(srcPath, ext)
	outPath := outBase + "." + targetFmt

	// Handle lossy -> lossless cases: optionally skip or warn
	if (targetFmt == "flac" || targetFmt == "wav") && isLossySource(ext, track.Codec) {
		if Config.ConvertSkipLossyToLossless {
			fmt.Println("Skipping conversion: source appears lossy and target is lossless; configured to skip.")
			return
		}
		if Config.ConvertWarnLossyToLossless {
			fmt.Println("Warning: Converting lossy source to lossless container will not improve quality.")
		}
	}

	if _, err := exec.LookPath(Config.FFmpegPath); err != nil {
		fmt.Printf("ffmpeg not found at '%s'; skipping conversion.\n", Config.FFmpegPath)
		return
	}

	args, err := buildFFmpegArgs(Config.FFmpegPath, srcPath, outPath, targetFmt, Config.ConvertExtraArgs)
	if err != nil {
		fmt.Println("Conversion config error:", err)
		return
	}

	fmt.Printf("Converting -> %s ...\n", targetFmt)
	cmd := exec.Command(Config.FFmpegPath, args...)
	var stderr bytes.Buffer
	if Config.ConvertCheckBadALAC {
		cmd.Stderr = &stderr
	} else {
		cmd.Stderr = nil
	}
	cmd.Stdout = nil
	start := time.Now()
	if err := cmd.Run(); err != nil {
		fmt.Println("Conversion failed:", err)
		// leave original
		return
	}
	if Config.ConvertCheckBadALAC && stderr.Len() > 0 {
		fmt.Print("Detected ALAC Error.", "\n")
		if Config.ConvertDeleteBadALAC {
			delPath := strings.TrimSuffix(srcPath, "m4a") + targetFmt
			logPath := strings.TrimSuffix(srcPath, "m4a") + "log"
			if err := os.Remove(delPath); err != nil {
				fmt.Println("Failed to remove convert:", err)
			} else {
				fmt.Println("Convert removed due to the bad ALAC.")
				log := stderr
				err = os.WriteFile(logPath, log.Bytes(), 0644)
				if err != nil {
					fmt.Println("Convert logs:", log)
				} else {
					fmt.Println("Convert logs are stored in:", logPath)
				}
			}
		}
	} else {
		fmt.Printf("Conversion completed in %s: %s\n", time.Since(start).Truncate(time.Millisecond), filepath.Base(outPath))

		if !Config.ConvertKeepOriginal {
			if err := os.Remove(srcPath); err != nil {
				fmt.Println("Failed to remove original after conversion:", err)
			} else {
				fmt.Println("Original removed.")
			}

		}
		track.SavePath = outPath
		track.SaveName = filepath.Base(outPath)
	}

}

func ripTrack(track *task.Track, token string, mediaUserToken string) {
	var err error
	counter.Total++
	fmt.Printf("Track %d of %d: %s\n", track.TaskNum, track.TaskTotal, track.Type)

	//mv dl dev
	if track.Type == "music-videos" {
		if len(mediaUserToken) <= 50 {
			fmt.Println("meida-user-token is not set, skip MV dl")
			counter.Success++
			return
		}
		_, err := mvDownloader(track.ID, track.SaveDir, token, track.Storefront, mediaUserToken, track)
		if err != nil {
			fmt.Println("\u26A0 Failed to dl MV:", err)
			counter.Error++
			return
		}
		counter.Success++
		return
	}

	needDlAacLc := false
	if dl_aac && Config.AacType == "aac-lc" {
		needDlAacLc = true
	}
	if track.WebM3u8 == "" && !needDlAacLc {
		if dl_atmos {
			fmt.Println("Unavailable")
			counter.Unavailable++
			return
		}
		fmt.Println("Unavailable, trying to dl aac-lc")
		needDlAacLc = true
	}
	needCheck := false

	if Config.GetM3u8Mode == "all" {
		needCheck = true
	} else if Config.GetM3u8Mode == "hires" && contains(track.Resp.Attributes.AudioTraits, "hi-res-lossless") {
		needCheck = true
	}
	var EnhancedHls_m3u8 string
	if needCheck && !needDlAacLc {
		EnhancedHls_m3u8, _ = checkM3u8(track.ID, "song")
		if strings.HasSuffix(EnhancedHls_m3u8, ".m3u8") {
			track.DeviceM3u8 = EnhancedHls_m3u8
			track.M3u8 = EnhancedHls_m3u8
		}
	}
	var Quality string
	if strings.Contains(Config.SongFileFormat, "Quality") {
		if dl_atmos {
			Quality = fmt.Sprintf("%dKbps", Config.AtmosMax-2000)
		} else if needDlAacLc {
			Quality = "256Kbps"
		} else {
			_, Quality, err = extractMedia(track.M3u8)
			if err != nil {
				fmt.Println("Failed to extract quality from manifest.\n", err)
				counter.Error++
				return
			}
		}
	}
	track.Quality = Quality

	stringsToJoin := []string{}
	if track.Resp.Attributes.IsAppleDigitalMaster {
		if Config.AppleMasterChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.AppleMasterChoice)
		}
	}
	if track.Resp.Attributes.ContentRating == "explicit" {
		if Config.ExplicitChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.ExplicitChoice)
		}
	}
	if track.Resp.Attributes.ContentRating == "clean" {
		if Config.CleanChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.CleanChoice)
		}
	}
	Tag_string := strings.Join(stringsToJoin, " ")

	songName := strings.NewReplacer(
		"{SongId}", track.ID,
		"{SongNumer}", fmt.Sprintf("%02d", track.TaskNum),
		"{ArtistName}", LimitString(track.Resp.Attributes.ArtistName),
		"{SongName}", LimitString(track.Resp.Attributes.Name),
		"{DiscNumber}", fmt.Sprintf("%0d", track.Resp.Attributes.DiscNumber),
		"{TrackNumber}", fmt.Sprintf("%0d", track.Resp.Attributes.TrackNumber),
		"{Quality}", Quality,
		"{Tag}", Tag_string,
		"{Codec}", track.Codec,
	).Replace(Config.SongFileFormat)
	fmt.Println(songName)
	filename := fmt.Sprintf("%s.m4a", forbiddenNames.ReplaceAllString(songName, "_"))
	track.SaveName = filename
	trackPath := filepath.Join(track.SaveDir, track.SaveName)
	lrcFilename := fmt.Sprintf("%s.%s", forbiddenNames.ReplaceAllString(songName, "_"), Config.LrcFormat)

	// Determine possible post-conversion target file (so we can skip re-download)
	var convertedPath string
	considerConverted := false
	if Config.ConvertAfterDownload &&
		Config.ConvertFormat != "" &&
		strings.ToLower(Config.ConvertFormat) != "copy" &&
		!Config.ConvertKeepOriginal {
		convertedPath = strings.TrimSuffix(trackPath, filepath.Ext(trackPath)) + "." + strings.ToLower(Config.ConvertFormat)
		considerConverted = true
	}
	// Existence check now considers converted output (if original was deleted)
	// ── STREAMING ADDITIONS ────────────────────────────────────────────────────
	if play_stream {
		var playPath string
		if res, ok := takePrefetchResult(track.ID); ok {
			if res.err != nil {
				fmt.Println("⚠ Prefetch failed, downloading...", res.err)
			} else if res.path != "" {
				playPath = saveToDiskCache(res.path, track.ID, false)
				fmt.Println("▶️  Queued from prefetch:", playPath)
				AddToStreamPlaylist(playPath, track.Resp.Attributes.AudioTraits)
				return
			}
		}
		if needDlAacLc {
			fmt.Println("\n▶️ Starting AAC stream...")
			// Check disk cache first
			if cached := checkDiskCache(track.ID, true); cached != "" {
				fmt.Println("▶️  Queued from cache:", cached)
				AddToStreamPlaylist(cached, track.Resp.Attributes.AudioTraits)
				return
			}
			pr, pw := io.Pipe()
			cachePath := streamDiskCachePath(track.ID, true)
			cacheFile, cacheErr := os.Create(cachePath)
			go func() {
				var w io.Writer = pw
				if cacheErr == nil {
					w = io.MultiWriter(pw, cacheFile)
				}
				err := runv3.RunStream(track.ID, token, mediaUserToken, w)
				if cacheErr == nil {
					cacheFile.Close()
				}
				pw.CloseWithError(err)
			}()
			var aacCmd *exec.Cmd
			switch resolvePlayer() {
			case "mpv":
				sampleRate, audioFormat := traitsToFormat(track.Resp.Attributes.AudioTraits)
				aacCmd = exec.Command("mpv",
					"--hwdec=auto",
					"--audio-device=pipewire",
					fmt.Sprintf("--audio-samplerate=%s", sampleRate),
					fmt.Sprintf("--audio-format=%s", audioFormat),
					"--no-terminal",
					"-",
				)
			case "vlc":
				aacCmd = exec.Command("vlc", "--intf", "dummy", "--play-and-exit", "-")
			case "ffplay":
				aacCmd = exec.Command("ffplay", "-i", "pipe:0", "-nodisp", "-autoexit")
			default:
				fmt.Println("Missing media player (mpv, vlc, or ffplay)")
				pr.Close()
				return
			}
			aacCmd.Stdin = pr
			aacCmd.Stdout = os.Stdout
			aacCmd.Stderr = os.Stderr
			if err := aacCmd.Run(); err != nil {
				fmt.Println("Playback error:", err)
			}
			// Note: AAC live stream can't be queued in playlist mode
			// For playlist support, use ALAC quality
			return
		}
		// Check disk cache first for ALAC
		if cached := checkDiskCache(track.ID, false); cached != "" {
			fmt.Println("▶️  Queued from cache:", cached)
			AddToStreamPlaylist(cached, track.Resp.Attributes.AudioTraits)
			return
		}
		trackM3u8Url, _, err := extractMedia(track.M3u8)
		if err != nil {
			fmt.Println("Failed to extract info from manifest:", err)
			return
		}
		tmpDir := "/dev/shm"
		if _, serr := os.Stat(tmpDir); serr != nil {
			tmpDir = os.TempDir()
		}
		tf, err := os.CreateTemp(tmpDir, "am-stream-*.m4a")
		if err != nil {
			fmt.Println("Temp file error:", err)
			return
		}
		tempPath := tf.Name()
		tf.Close()
		os.Remove(tempPath)
		if decErr := runv2.Run(track.ID, trackM3u8Url, tempPath, Config); decErr != nil {
			fmt.Println("Decrypt error:", decErr)
			os.Remove(tempPath)
			return
		}
		// MP4Box converts fMP4 → regular m4a so mpv sees the full duration.
		// Without this, mpv plays only the first fragment and stops.
		mp4boxCmd := exec.Command("MP4Box", "-noprog", "-itags", "tool=", tempPath)
		mp4boxCmd.Stderr = io.Discard
		mp4boxCmd.Stdout = io.Discard
		mp4boxCmd.Run()
		playPath = saveToDiskCache(tempPath, track.ID, false)
		fmt.Println("▶️  Queued:", playPath)
		AddToStreamPlaylist(playPath, track.Resp.Attributes.AudioTraits)
		return
	}
	// ── END STREAMING ADDITIONS ─────────────────────────────────────────────────

	existsOriginal, err := fileExists(trackPath)
	if err != nil {
		fmt.Println("Failed to check if track exists.")
	}
	if existsOriginal {
		fmt.Println("Track already exists locally.")
		counter.Success++
		okDict[track.PreID] = append(okDict[track.PreID], track.TaskNum)

		tArtistId := ""
		if len(track.Resp.Relationships.Artists.Data) > 0 {
			tArtistId = track.Resp.Relationships.Artists.Data[0].ID
		}
		AddedTracks = append(AddedTracks, AddedTrack{
			Path:     trackPath,
			Artist:   track.Resp.Attributes.ArtistName,
			ArtistID: tArtistId,
			Album:    track.Resp.Attributes.AlbumName,
			Song:     track.Resp.Attributes.Name,
		})
		return
	}
	if considerConverted {
		existsConverted, err2 := fileExists(convertedPath)
		if err2 == nil && existsConverted {
			fmt.Println("Converted track already exists locally.")
			counter.Success++
			okDict[track.PreID] = append(okDict[track.PreID], track.TaskNum)

			tArtistId := ""
			if len(track.Resp.Relationships.Artists.Data) > 0 {
				tArtistId = track.Resp.Relationships.Artists.Data[0].ID
			}
			AddedTracks = append(AddedTracks, AddedTrack{
				Path:     convertedPath,
				Artist:   track.Resp.Attributes.ArtistName,
				ArtistID: tArtistId,
				Album:    track.Resp.Attributes.AlbumName,
				Song:     track.Resp.Attributes.Name,
			})
			return
		}
	}

	// Fetch album data + lyrics in parallel with each other, then do audio download,
	// then wait for both before tagging.
	var lrc string
	// Check prefetch cache first; fall back to in-track parallel fetch.
	if meta, ok := TakeMeta(track.ID); ok {
		if meta.err == nil && (Config.EmbedLrc || Config.SaveLrcFile) {
			if Config.SaveLrcFile && meta.lrc != "" {
				writeLyrics(track.SaveDir, lrcFilename, meta.lrc)
			}
			if Config.EmbedLrc {
				lrc = meta.lrc
			}
		}
	} else {
		var metaWg sync.WaitGroup

		if track.PreType == "playlists" && Config.UseSongInfoForPlaylist {
			metaWg.Add(1)
			go func() {
				defer metaWg.Done()
				track.GetAlbumData(token)
			}()
		}

		if Config.EmbedLrc || Config.SaveLrcFile {
			metaWg.Add(1)
			go func() {
				defer metaWg.Done()
				lrcStr, err := lyrics.Get(track.Storefront, track.ID, Config.LrcType, Config.Language, Config.LrcFormat, token, mediaUserToken)
				if err != nil {
					fmt.Println(err)
					return
				}
				if Config.SaveLrcFile {
					writeLyrics(track.SaveDir, lrcFilename, lrcStr)
				}
				if Config.EmbedLrc {
					lrc = lrcStr
				}
			}()
		}

		// metaWg.Wait() deferred to after download so fetch overlaps with download.
		defer func() { metaWg.Wait() }()
	}

	if needDlAacLc {
		if len(mediaUserToken) <= 50 {
			fmt.Println("Invalid media-user-token")
			counter.Error++
			return
		}
		_, err := runv3.Run(track.ID, trackPath, token, mediaUserToken, false, "")
		if err != nil {
			fmt.Println("Failed to dl aac-lc:", err)
			if err.Error() == "Unavailable" {
				counter.Unavailable++
				return
			}
			counter.Error++
			return
		}
	} else {
		trackM3u8Url, _, err := extractMedia(track.M3u8)
		if err != nil {
			fmt.Println("\u26A0 Failed to extract info from manifest:", err)
			counter.Unavailable++
			return
		}
		//边下载边解密
		err = runv2.Run(track.ID, trackM3u8Url, trackPath, Config)
		if err != nil {
			fmt.Println("Failed to run v2:", err)
			counter.Error++
			return
		}
	}
	//这里利用MP4box将fmp4转化为mp4，并添加ilst box与cover，方便后面的mp4tag添加更多自定义标签
	tags := []string{
		"tool=",
		"artist=AppleMusic",
	}
	if Config.EmbedCover {
		if (strings.Contains(track.PreID, "pl.") || strings.Contains(track.PreID, "ra.")) && Config.DlAlbumcoverForPlaylist {
			track.CoverPath, err = writeCover(track.SaveDir, track.ID, track.Resp.Attributes.Artwork.URL)
			if err != nil {
				fmt.Println("Failed to write cover.")
			}
		}
		tags = append(tags, fmt.Sprintf("cover=%s", track.CoverPath))
	}
	tagsString := strings.Join(tags, ":")
	cmd := exec.Command("MP4Box", "-itags", tagsString, trackPath)
	if err := cmd.Run(); err != nil {
		fmt.Printf("Embed failed: %v\n", err)
		counter.Error++
		return
	}
	if (strings.Contains(track.PreID, "pl.") || strings.Contains(track.PreID, "ra.")) && Config.DlAlbumcoverForPlaylist {
		if err := os.Remove(track.CoverPath); err != nil {
			fmt.Printf("Error deleting file: %s\n", track.CoverPath)
			counter.Error++
			return
		}
	}
	track.SavePath = trackPath

	if Config.ALACFix {
		err = alacfix.Run(track.SavePath, false)
		if err != nil {
			fmt.Println("\u26A0 Failed to fix ALAC:", err)
			counter.Unavailable++
			return
		}
	}

	err = writeMP4Tags(track, lrc)
	if err != nil {
		fmt.Println("\u26A0 Failed to write tags in media:", err)
		counter.Unavailable++
		return
	}

	// CONVERSION FEATURE hook
	convertIfNeeded(track)

	tArtistId := ""
	if len(track.Resp.Relationships.Artists.Data) > 0 {
		tArtistId = track.Resp.Relationships.Artists.Data[0].ID
	}
	AddedTracks = append(AddedTracks, AddedTrack{
		Path:     track.SavePath,
		Artist:   track.Resp.Attributes.ArtistName,
		ArtistID: tArtistId,
		Album:    track.Resp.Attributes.AlbumName,
		Song:     track.Resp.Attributes.Name,
	})

	counter.Success++
	okDict[track.PreID] = append(okDict[track.PreID], track.TaskNum)
}

func ripStation(albumId string, token string, storefront string, mediaUserToken string) error {
	station := task.NewStation(storefront, albumId)
	err := station.GetResp(mediaUserToken, token, Config.Language)
	if err != nil {
		return err
	}
	fmt.Println(" -", station.Type)
	meta := station.Resp

	var Codec string
	if dl_atmos {
		Codec = "ATMOS"
	} else if dl_aac {
		Codec = "AAC"
	} else {
		Codec = "ALAC"
	}
	station.Codec = Codec
	var singerFoldername string
	if Config.ArtistFolderFormat != "" {
		singerFoldername = strings.NewReplacer(
			"{ArtistName}", "Apple Music Station",
			"{ArtistId}", "",
			"{UrlArtistName}", "Apple Music Station",
		).Replace(Config.ArtistFolderFormat)
		if strings.HasSuffix(singerFoldername, ".") {
			singerFoldername = strings.ReplaceAll(singerFoldername, ".", "")
		}
		singerFoldername = strings.TrimSpace(singerFoldername)
		fmt.Println(singerFoldername)
	}
	alacFolder := Config.AlacSaveFolder
	atmosFolder := Config.AtmosSaveFolder
	aacFolder := Config.AacSaveFolder
	if play_stream {
		alacFolder = Config.AlacStreamFolder
		atmosFolder = Config.AtmosStreamFolder
		aacFolder = Config.AacStreamFolder
	}
	singerFolder := filepath.Join(alacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	if dl_atmos {
		singerFolder = filepath.Join(atmosFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	} else if dl_aac {
		singerFolder = filepath.Join(aacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	}
	os.MkdirAll(singerFolder, os.ModePerm)
	station.SaveDir = singerFolder

	playlistFolder := strings.NewReplacer(
		"{ArtistName}", "Apple Music Station",
		"{PlaylistName}", LimitString(station.Name),
		"{PlaylistId}", station.ID,
		"{Quality}", "",
		"{Codec}", Codec,
		"{Tag}", "",
	).Replace(Config.PlaylistFolderFormat)
	if strings.HasSuffix(playlistFolder, ".") {
		playlistFolder = strings.ReplaceAll(playlistFolder, ".", "")
	}
	playlistFolder = strings.TrimSpace(playlistFolder)
	playlistFolderPath := filepath.Join(singerFolder, forbiddenNames.ReplaceAllString(playlistFolder, "_"))
	os.MkdirAll(playlistFolderPath, os.ModePerm)
	station.SaveName = playlistFolder
	fmt.Println(playlistFolder)

	covPath, err := writeCover(playlistFolderPath, "cover", meta.Data[0].Attributes.Artwork.URL)
	if err != nil {
		fmt.Println("Failed to write cover.")
	}
	station.CoverPath = covPath

	if Config.SaveAnimatedArtwork && meta.Data[0].Attributes.EditorialVideo.MotionSquare.Video != "" {
		fmt.Println("Found Animation Artwork.")

		motionvideoUrlSquare, err := extractVideo(meta.Data[0].Attributes.EditorialVideo.MotionSquare.Video)
		if err != nil {
			fmt.Println("no motion video square.\n", err)
		} else {
			exists, err := fileExists(filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"))
			if err != nil {
				fmt.Println("Failed to check if animated artwork square exists.")
			}
			if exists {
				fmt.Println("Animated artwork square already exists locally.")
			} else {
				fmt.Println("Animation Artwork Square Downloading...")
				cmd := exec.Command("ffmpeg", "-hwaccel", "auto", "-loglevel", "quiet", "-y", "-i", motionvideoUrlSquare, "-c", "copy", filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"))
				if err := cmd.Run(); err != nil {
					fmt.Printf("animated artwork square dl err: %v\n", err)
				} else {
					fmt.Println("Animation Artwork Square Downloaded")
				}
			}
		}

		if Config.EmbyAnimatedArtwork {
			cmd3 := exec.Command("ffmpeg", "-hwaccel", "auto", "-y", "-i", filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"), "-vf", "scale=440:-1", "-r", "24", "-f", "gif", filepath.Join(playlistFolderPath, "folder.jpg"))
			if err := cmd3.Run(); err != nil {
				fmt.Printf("animated artwork square to gif err: %v\n", err)
			}
		}
	}
	if station.Type == "stream" {
		counter.Total++
		if isInArray(okDict[station.ID], 1) {
			counter.Success++
			return nil
		}
		songName := strings.NewReplacer(
			"{SongId}", station.ID,
			"{SongNumer}", "01",
			"{SongName}", LimitString(station.Name),
			"{DiscNumber}", "1",
			"{TrackNumber}", "1",
			"{Quality}", "256Kbps",
			"{Tag}", "",
			"{Codec}", "AAC",
		).Replace(Config.SongFileFormat)
		fmt.Println(songName)
		trackPath := filepath.Join(playlistFolderPath, fmt.Sprintf("%s.m4a", forbiddenNames.ReplaceAllString(songName, "_")))
		exists, _ := fileExists(trackPath)
		if exists {
			counter.Success++
			okDict[station.ID] = append(okDict[station.ID], 1)

			fmt.Println("Radio already exists locally.")
			AddedTracks = append(AddedTracks, AddedTrack{
				Path:     trackPath,
				Artist:   "Apple Music Station",
				ArtistID: "",
				Album:    station.Name,
				Song:     station.Name,
			})
			return nil
		}
		assetsUrl, serverUrl, err := ampapi.GetStationAssetsUrlAndServerUrl(station.ID, mediaUserToken, token)
		if err != nil {
			fmt.Println("Failed to get station assets url.", err)
			counter.Error++
			return err
		}
		trackM3U8 := strings.ReplaceAll(assetsUrl, "index.m3u8", "256/prog_index.m3u8")
		keyAndUrls, _ := runv3.Run(station.ID, trackM3U8, token, mediaUserToken, true, serverUrl)
		err = runv3.ExtMvData(keyAndUrls, trackPath)
		if err != nil {
			fmt.Println("Failed to download station stream.", err)
			counter.Error++
			return err
		}
		tags := []string{
			"tool=",
			"disk=1/1",
			"track=1",
			"tracknum=1/1",
			fmt.Sprintf("artist=%s", "Apple Music Station"),
			fmt.Sprintf("performer=%s", "Apple Music Station"),
			fmt.Sprintf("album_artist=%s", "Apple Music Station"),
			fmt.Sprintf("album=%s", station.Name),
			fmt.Sprintf("title=%s", station.Name),
		}
		if Config.EmbedCover {
			tags = append(tags, fmt.Sprintf("cover=%s", station.CoverPath))
		}
		tagsString := strings.Join(tags, ":")
		cmd := exec.Command("MP4Box", "-itags", tagsString, trackPath)
		if err := cmd.Run(); err != nil {
			fmt.Printf("Embed failed: %v\n", err)
		}
		AddedTracks = append(AddedTracks, AddedTrack{
			Path:     trackPath,
			Artist:   "Apple Music Station",
			ArtistID: "",
			Album:    station.Name,
			Song:     station.Name,
		})
		counter.Success++
		okDict[station.ID] = append(okDict[station.ID], 1)
		return nil
	}

	for i := range station.Tracks {
		station.Tracks[i].CoverPath = covPath
		station.Tracks[i].SaveDir = playlistFolderPath
		station.Tracks[i].Codec = Codec
	}

	trackTotal := len(station.Tracks)
	arr := make([]int, trackTotal)
	for i := 0; i < trackTotal; i++ {
		arr[i] = i + 1
	}
	var selected []int

	if true {
		selected = arr
	}
	startIdx := len(AddedTracks)
	for i := range station.Tracks {
		i++
		if isInArray(selected, i) {
			ripTrack(&station.Tracks[i-1], token, mediaUserToken)
		}
	}
	if len(AddedTracks) > startIdx {
		if err := writeM3UPlaylist(playlistFolderPath, playlistFolder, AddedTracks[startIdx:]); err != nil {
			fmt.Printf("Failed to write M3U8 playlist: %v\n", err)
		}
	}
	return nil
}

func ripAlbum(albumId string, token string, storefront string, mediaUserToken string, urlArg_i string) error {
	album := task.NewAlbum(storefront, albumId)
	err := album.GetResp(token, Config.Language)
	if err != nil {
		fmt.Println("Failed to get album response.")
		return err
	}
	meta := album.Resp
	var Codec string
	if dl_atmos {
		Codec = "ATMOS"
	} else if dl_aac {
		Codec = "AAC"
	} else {
		Codec = "ALAC"
	}
	album.Codec = Codec
	var singerFoldername string
	if Config.ArtistFolderFormat != "" {
		if len(meta.Data[0].Relationships.Artists.Data) > 0 {
			singerFoldername = strings.NewReplacer(
				"{UrlArtistName}", LimitString(meta.Data[0].Attributes.ArtistName),
				"{ArtistName}", LimitString(meta.Data[0].Attributes.ArtistName),
				"{ArtistId}", meta.Data[0].Relationships.Artists.Data[0].ID,
			).Replace(Config.ArtistFolderFormat)
		} else {
			singerFoldername = strings.NewReplacer(
				"{UrlArtistName}", LimitString(meta.Data[0].Attributes.ArtistName),
				"{ArtistName}", LimitString(meta.Data[0].Attributes.ArtistName),
				"{ArtistId}", "",
			).Replace(Config.ArtistFolderFormat)
		}
		if strings.HasSuffix(singerFoldername, ".") {
			singerFoldername = strings.ReplaceAll(singerFoldername, ".", "")
		}
		singerFoldername = strings.TrimSpace(singerFoldername)
		fmt.Println(singerFoldername)
	}
	alacFolder := Config.AlacSaveFolder
	atmosFolder := Config.AtmosSaveFolder
	aacFolder := Config.AacSaveFolder
	if play_stream {
		alacFolder = Config.AlacStreamFolder
		atmosFolder = Config.AtmosStreamFolder
		aacFolder = Config.AacStreamFolder
	}
	singerFolder := filepath.Join(alacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	if dl_atmos {
		singerFolder = filepath.Join(atmosFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	} else if dl_aac {
		singerFolder = filepath.Join(aacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	}
	os.MkdirAll(singerFolder, os.ModePerm)
	album.SaveDir = singerFolder
	var Quality string
	if strings.Contains(Config.AlbumFolderFormat, "Quality") {
		if dl_atmos {
			Quality = fmt.Sprintf("%dKbps", Config.AtmosMax-2000)
		} else if dl_aac && Config.AacType == "aac-lc" {
			Quality = "256Kbps"
		} else {
			manifest1, err := ampapi.GetSongResp(storefront, meta.Data[0].Relationships.Tracks.Data[0].ID, album.Language, token)
			if err != nil {
				fmt.Println("Failed to get manifest.\n", err)
			} else {
				if manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls == "" {
					Codec = "AAC"
					Quality = "256Kbps"
				} else {
					needCheck := false

					if Config.GetM3u8Mode == "all" {
						needCheck = true
					} else if Config.GetM3u8Mode == "hires" && contains(meta.Data[0].Relationships.Tracks.Data[0].Attributes.AudioTraits, "hi-res-lossless") {
						needCheck = true
					}
					var EnhancedHls_m3u8 string
					if needCheck {
						EnhancedHls_m3u8, _ = checkM3u8(meta.Data[0].Relationships.Tracks.Data[0].ID, "album")
						if strings.HasSuffix(EnhancedHls_m3u8, ".m3u8") {
							manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls = EnhancedHls_m3u8
						}
					}
					_, Quality, err = extractMedia(manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls)
					if err != nil {
						fmt.Println("Failed to extract quality from manifest.\n", err)
					}
				}
			}
		}
	}
	stringsToJoin := []string{}
	if meta.Data[0].Attributes.IsAppleDigitalMaster || meta.Data[0].Attributes.IsMasteredForItunes {
		if Config.AppleMasterChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.AppleMasterChoice)
		}
	}
	if meta.Data[0].Attributes.ContentRating == "explicit" {
		if Config.ExplicitChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.ExplicitChoice)
		}
	}
	if meta.Data[0].Attributes.ContentRating == "clean" {
		if Config.CleanChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.CleanChoice)
		}
	}
	Tag_string := strings.Join(stringsToJoin, " ")
	var albumFolderName string
	albumFolderName = strings.NewReplacer(
		"{ReleaseDate}", meta.Data[0].Attributes.ReleaseDate,
		"{ReleaseYear}", meta.Data[0].Attributes.ReleaseDate[:4],
		"{ArtistName}", LimitString(meta.Data[0].Attributes.ArtistName),
		"{AlbumName}", LimitString(meta.Data[0].Attributes.Name),
		"{UPC}", meta.Data[0].Attributes.Upc,
		"{RecordLabel}", meta.Data[0].Attributes.RecordLabel,
		"{Copyright}", meta.Data[0].Attributes.Copyright,
		"{AlbumId}", albumId,
		"{Quality}", Quality,
		"{Codec}", Codec,
		"{Tag}", Tag_string,
	).Replace(Config.AlbumFolderFormat)

	if strings.HasSuffix(albumFolderName, ".") {
		albumFolderName = strings.ReplaceAll(albumFolderName, ".", "")
	}
	albumFolderName = strings.TrimSpace(albumFolderName)
	albumFolderPath := filepath.Join(singerFolder, forbiddenNames.ReplaceAllString(albumFolderName, "_"))
	os.MkdirAll(albumFolderPath, os.ModePerm)
	album.SaveName = albumFolderName
	fmt.Println(albumFolderName)
	if Config.SaveArtistCover && len(meta.Data[0].Relationships.Artists.Data) > 0 {
		if meta.Data[0].Relationships.Artists.Data[0].Attributes.Artwork.Url != "" {
			_, err = writeCover(singerFolder, "folder", meta.Data[0].Relationships.Artists.Data[0].Attributes.Artwork.Url)
			if err != nil {
				fmt.Println("Failed to write artist cover.")
			}
		}
	}
	covPath, err := writeCover(albumFolderPath, "cover", meta.Data[0].Attributes.Artwork.URL)
	if err != nil {
		fmt.Println("Failed to write cover.")
	}
	if Config.SaveAnimatedArtwork && meta.Data[0].Attributes.EditorialVideo.MotionDetailSquare.Video != "" {
		fmt.Println("Found Animation Artwork.")

		motionvideoUrlSquare, err := extractVideo(meta.Data[0].Attributes.EditorialVideo.MotionDetailSquare.Video)
		if err != nil {
			fmt.Println("no motion video square.\n", err)
		} else {
			exists, err := fileExists(filepath.Join(albumFolderPath, "square_animated_artwork.mp4"))
			if err != nil {
				fmt.Println("Failed to check if animated artwork square exists.")
			}
			if exists {
				fmt.Println("Animated artwork square already exists locally.")
			} else {
				fmt.Println("Animation Artwork Square Downloading...")
				cmd := exec.Command("ffmpeg", "-hwaccel", "auto", "-loglevel", "quiet", "-y", "-i", motionvideoUrlSquare, "-c", "copy", filepath.Join(albumFolderPath, "square_animated_artwork.mp4"))
				if err := cmd.Run(); err != nil {
					fmt.Printf("animated artwork square dl err: %v\n", err)
				} else {
					fmt.Println("Animation Artwork Square Downloaded")
				}
			}
		}

		if Config.EmbyAnimatedArtwork {
			cmd3 := exec.Command("ffmpeg", "-hwaccel", "auto", "-y", "-i", filepath.Join(albumFolderPath, "square_animated_artwork.mp4"), "-vf", "scale=440:-1", "-r", "24", "-f", "gif", filepath.Join(albumFolderPath, "folder.jpg"))
			if err := cmd3.Run(); err != nil {
				fmt.Printf("animated artwork square to gif err: %v\n", err)
			}
		}

		motionvideoUrlTall, err := extractVideo(meta.Data[0].Attributes.EditorialVideo.MotionDetailTall.Video)
		if err != nil {
			fmt.Println("no motion video tall.\n", err)
		} else {
			exists, err := fileExists(filepath.Join(albumFolderPath, "tall_animated_artwork.mp4"))
			if err != nil {
				fmt.Println("Failed to check if animated artwork tall exists.")
			}
			if exists {
				fmt.Println("Animated artwork tall already exists locally.")
			} else {
				fmt.Println("Animation Artwork Tall Downloading...")
				cmd := exec.Command("ffmpeg", "-hwaccel", "auto", "-loglevel", "quiet", "-y", "-i", motionvideoUrlTall, "-c", "copy", filepath.Join(albumFolderPath, "tall_animated_artwork.mp4"))
				if err := cmd.Run(); err != nil {
					fmt.Printf("animated artwork tall dl err: %v\n", err)
				} else {
					fmt.Println("Animation Artwork Tall Downloaded")
				}
			}
		}
	}
	for i := range album.Tracks {
		album.Tracks[i].CoverPath = covPath
		album.Tracks[i].SaveDir = albumFolderPath
		album.Tracks[i].Codec = Codec
	}
	trackTotal := len(meta.Data[0].Relationships.Tracks.Data)
	arr := make([]int, trackTotal)
	for i := 0; i < trackTotal; i++ {
		arr[i] = i + 1
	}

	if dl_song {
		if urlArg_i != "" {
			for i := range album.Tracks {
				if urlArg_i == album.Tracks[i].ID {
					ripTrack(&album.Tracks[i], token, mediaUserToken)
					if play_stream && len(streamPlaylistPaths) > 0 {
						fmt.Printf("\n▶️  Starting song: %d tracks\n", len(streamPlaylistPaths))
						session, err := PlayMediaPlaylist(streamPlaylistPaths, streamPlaylistTraits)
						if err != nil {
							fmt.Println("Playback error:", err)
						} else {
							session.WaitDone()
						}
						ResetStreamPlaylist()
					}
					return nil
				}
			}
		}
		return nil
	}
	var selected []int
	if !dl_select {
		selected = arr
	} else {
		selected = album.ShowSelect()
	}
	startIdx := len(AddedTracks)
	ResetStreamPlaylist()
	// Kick off metadata prefetch for the first few tracks before the loop.
	PrefetchAlbumMeta(context.Background(), album.Tracks, token, mediaUserToken)

	for i := range album.Tracks {
		i++
		if isInArray(okDict[albumId], i) {
			counter.Total++
			counter.Success++
			continue
		}
		if isInArray(selected, i) {
			// Rolling lookahead: prefetch metadata for tracks further ahead.
			lookahead := i + schedLookahead
			if lookahead <= len(album.Tracks) {
				PrefetchMeta(context.Background(), &album.Tracks[lookahead-1], token, mediaUserToken)
			}
			// Prefetch audio download for next track (ALAC stream mode).
			if play_stream && i < len(album.Tracks) && isInArray(selected, i+1) {
				startPrefetchTrack(&album.Tracks[i], token, mediaUserToken)
			}
			ripTrack(&album.Tracks[i-1], token, mediaUserToken)
		}
	}
	if play_stream && len(streamPlaylistPaths) > 0 {
		fmt.Printf("\n▶️  Starting album: %d tracks\n", len(streamPlaylistPaths))
		session, err := PlayMediaPlaylist(streamPlaylistPaths, streamPlaylistTraits)
		if err != nil {
			fmt.Println("Playback error:", err)
		} else {
			session.WaitDone()
		}
		ResetStreamPlaylist()
	}
	if len(AddedTracks) > startIdx {
		if err := writeM3UPlaylist(albumFolderPath, albumFolderName, AddedTracks[startIdx:]); err != nil {
			fmt.Printf("Failed to write M3U8 playlist: %v\n", err)
		}
	}
	return nil
}

func ripPlaylist(playlistId string, token string, storefront string, mediaUserToken string) error {
	playlist := task.NewPlaylist(storefront, playlistId)
	err := playlist.GetResp(token, Config.Language)
	if err != nil {
		fmt.Println("Failed to get playlist response.")
		return err
	}
	meta := playlist.Resp
	var Codec string
	if dl_atmos {
		Codec = "ATMOS"
	} else if dl_aac {
		Codec = "AAC"
	} else {
		Codec = "ALAC"
	}
	playlist.Codec = Codec
	var singerFoldername string
	if Config.ArtistFolderFormat != "" {
		singerFoldername = strings.NewReplacer(
			"{ArtistName}", "Apple Music",
			"{ArtistId}", "",
			"{UrlArtistName}", "Apple Music",
		).Replace(Config.ArtistFolderFormat)
		if strings.HasSuffix(singerFoldername, ".") {
			singerFoldername = strings.ReplaceAll(singerFoldername, ".", "")
		}
		singerFoldername = strings.TrimSpace(singerFoldername)
		fmt.Println(singerFoldername)
	}
	alacFolder := Config.AlacSaveFolder
	atmosFolder := Config.AtmosSaveFolder
	aacFolder := Config.AacSaveFolder
	if play_stream {
		alacFolder = Config.AlacStreamFolder
		atmosFolder = Config.AtmosStreamFolder
		aacFolder = Config.AacStreamFolder
	}
	singerFolder := filepath.Join(alacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	if dl_atmos {
		singerFolder = filepath.Join(atmosFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	} else if dl_aac {
		singerFolder = filepath.Join(aacFolder, forbiddenNames.ReplaceAllString(singerFoldername, "_"))
	}
	os.MkdirAll(singerFolder, os.ModePerm)
	playlist.SaveDir = singerFolder

	var Quality string
	if strings.Contains(Config.AlbumFolderFormat, "Quality") {
		if dl_atmos {
			Quality = fmt.Sprintf("%dKbps", Config.AtmosMax-2000)
		} else if dl_aac && Config.AacType == "aac-lc" {
			Quality = "256Kbps"
		} else {
			manifest1, err := ampapi.GetSongResp(storefront, meta.Data[0].Relationships.Tracks.Data[0].ID, playlist.Language, token)
			if err != nil {
				fmt.Println("Failed to get manifest.\n", err)
			} else {
				if manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls == "" {
					Codec = "AAC"
					Quality = "256Kbps"
				} else {
					needCheck := false

					if Config.GetM3u8Mode == "all" {
						needCheck = true
					} else if Config.GetM3u8Mode == "hires" && contains(meta.Data[0].Relationships.Tracks.Data[0].Attributes.AudioTraits, "hi-res-lossless") {
						needCheck = true
					}
					var EnhancedHls_m3u8 string
					if needCheck {
						EnhancedHls_m3u8, _ = checkM3u8(meta.Data[0].Relationships.Tracks.Data[0].ID, "album")
						if strings.HasSuffix(EnhancedHls_m3u8, ".m3u8") {
							manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls = EnhancedHls_m3u8
						}
					}
					_, Quality, err = extractMedia(manifest1.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls)
					if err != nil {
						fmt.Println("Failed to extract quality from manifest.\n", err)
					}
				}
			}
		}
	}
	stringsToJoin := []string{}
	if meta.Data[0].Attributes.IsAppleDigitalMaster || meta.Data[0].Attributes.IsMasteredForItunes {
		if Config.AppleMasterChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.AppleMasterChoice)
		}
	}
	if meta.Data[0].Attributes.ContentRating == "explicit" {
		if Config.ExplicitChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.ExplicitChoice)
		}
	}
	if meta.Data[0].Attributes.ContentRating == "clean" {
		if Config.CleanChoice != "" {
			stringsToJoin = append(stringsToJoin, Config.CleanChoice)
		}
	}
	Tag_string := strings.Join(stringsToJoin, " ")
	playlistFolder := strings.NewReplacer(
		"{ArtistName}", "Apple Music",
		"{PlaylistName}", LimitString(meta.Data[0].Attributes.Name),
		"{PlaylistId}", playlistId,
		"{Quality}", Quality,
		"{Codec}", Codec,
		"{Tag}", Tag_string,
	).Replace(Config.PlaylistFolderFormat)
	if strings.HasSuffix(playlistFolder, ".") {
		playlistFolder = strings.ReplaceAll(playlistFolder, ".", "")
	}
	playlistFolder = strings.TrimSpace(playlistFolder)
	playlistFolderPath := filepath.Join(singerFolder, forbiddenNames.ReplaceAllString(playlistFolder, "_"))
	os.MkdirAll(playlistFolderPath, os.ModePerm)
	playlist.SaveName = playlistFolder
	fmt.Println(playlistFolder)
	covPath, err := writeCover(playlistFolderPath, "cover", meta.Data[0].Attributes.Artwork.URL)
	if err != nil {
		fmt.Println("Failed to write cover.")
	}

	for i := range playlist.Tracks {
		playlist.Tracks[i].CoverPath = covPath
		playlist.Tracks[i].SaveDir = playlistFolderPath
		playlist.Tracks[i].Codec = Codec
	}

	if Config.SaveAnimatedArtwork && meta.Data[0].Attributes.EditorialVideo.MotionDetailSquare.Video != "" {
		fmt.Println("Found Animation Artwork.")

		motionvideoUrlSquare, err := extractVideo(meta.Data[0].Attributes.EditorialVideo.MotionDetailSquare.Video)
		if err != nil {
			fmt.Println("no motion video square.\n", err)
		} else {
			exists, err := fileExists(filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"))
			if err != nil {
				fmt.Println("Failed to check if animated artwork square exists.")
			}
			if exists {
				fmt.Println("Animated artwork square already exists locally.")
			} else {
				fmt.Println("Animation Artwork Square Downloading...")
				cmd := exec.Command("ffmpeg", "-hwaccel", "auto", "-loglevel", "quiet", "-y", "-i", motionvideoUrlSquare, "-c", "copy", filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"))
				if err := cmd.Run(); err != nil {
					fmt.Printf("animated artwork square dl err: %v\n", err)
				} else {
					fmt.Println("Animation Artwork Square Downloaded")
				}
			}
		}

		if Config.EmbyAnimatedArtwork {
			cmd3 := exec.Command("ffmpeg", "-hwaccel", "auto", "-y", "-i", filepath.Join(playlistFolderPath, "square_animated_artwork.mp4"), "-vf", "scale=440:-1", "-r", "24", "-f", "gif", filepath.Join(playlistFolderPath, "folder.jpg"))
			if err := cmd3.Run(); err != nil {
				fmt.Printf("animated artwork square to gif err: %v\n", err)
			}
		}

		motionvideoUrlTall, err := extractVideo(meta.Data[0].Attributes.EditorialVideo.MotionDetailTall.Video)
		if err != nil {
			fmt.Println("no motion video tall.\n", err)
		} else {
			exists, err := fileExists(filepath.Join(playlistFolderPath, "tall_animated_artwork.mp4"))
			if err != nil {
				fmt.Println("Failed to check if animated artwork tall exists.")
			}
			if exists {
				fmt.Println("Animated artwork tall already exists locally.")
			} else {
				fmt.Println("Animation Artwork Tall Downloading...")
				cmd := exec.Command("ffmpeg", "-hwaccel", "auto", "-loglevel", "quiet", "-y", "-i", motionvideoUrlTall, "-c", "copy", filepath.Join(playlistFolderPath, "tall_animated_artwork.mp4"))
				if err := cmd.Run(); err != nil {
					fmt.Printf("animated artwork tall dl err: %v\n", err)
				} else {
					fmt.Println("Animation Artwork Tall Downloaded")
				}
			}
		}
	}
	trackTotal := len(meta.Data[0].Relationships.Tracks.Data)
	arr := make([]int, trackTotal)
	for i := 0; i < trackTotal; i++ {
		arr[i] = i + 1
	}
	var selected []int

	if !dl_select {
		selected = arr
	} else {
		selected = playlist.ShowSelect()
	}
	startIdx := len(AddedTracks)
	ResetStreamPlaylist()
	PrefetchAlbumMeta(context.Background(), playlist.Tracks, token, mediaUserToken)
	for i := range playlist.Tracks {
		i++
		if isInArray(okDict[playlistId], i) {
			counter.Total++
			counter.Success++
			continue
		}
		if isInArray(selected, i) {
			if lookahead := i + schedLookahead; lookahead <= len(playlist.Tracks) {
				PrefetchMeta(context.Background(), &playlist.Tracks[lookahead-1], token, mediaUserToken)
			}
			ripTrack(&playlist.Tracks[i-1], token, mediaUserToken)
		}
	}
	if play_stream && len(streamPlaylistPaths) > 0 {
		fmt.Printf("\n▶️  Starting playlist: %d tracks\n", len(streamPlaylistPaths))
		session, err := PlayMediaPlaylist(streamPlaylistPaths, streamPlaylistTraits)
		if err != nil {
			fmt.Println("Playback error:", err)
		} else {
			session.WaitDone()
		}
		ResetStreamPlaylist()
	}
	if len(AddedTracks) > startIdx {
		if err := writeM3UPlaylist(playlistFolderPath, playlistFolder, AddedTracks[startIdx:]); err != nil {
			fmt.Printf("Failed to write M3U8 playlist: %v\n", err)
		}
	}
	return nil
}

func writeM3UPlaylist(folderPath string, name string, tracks []AddedTrack) error {
	if save_m3u8_playlist == false {
		return nil
	}
	m3uPath := filepath.Join(folderPath, forbiddenNames.ReplaceAllString(name, "_")+".m3u8")
	f, err := os.Create(m3uPath)
	if err != nil {
		return err
	}
	defer f.Close()
	fmt.Fprintln(f, "#EXTM3U")
	for _, track := range tracks {
		fmt.Fprintf(f, "#EXTINF:-1,%s - %s\n", track.Artist, track.Song)
		fmt.Fprintln(f, filepath.Base(track.Path))
	}
	return nil
}

func writeMP4Tags(track *task.Track, lrc string) error {
	t := &mp4tag.MP4Tags{
		Title:  track.Resp.Attributes.Name,
		Artist: track.Resp.Attributes.ArtistName,
		Custom: map[string]string{
			"PERFORMER":   track.Resp.Attributes.ArtistName,
			"RELEASETIME": track.Resp.Attributes.ReleaseDate,
			"ISRC":        track.Resp.Attributes.Isrc,
			"LABEL":       "",
			"UPC":         "",
		},
		Composer:    track.Resp.Attributes.ComposerName,
		CustomGenre: track.Resp.Attributes.GenreNames[0],
		Lyrics:      lrc,
		TrackNumber: int16(track.Resp.Attributes.TrackNumber),
		DiscNumber:  int16(track.Resp.Attributes.DiscNumber),
		Album:       track.Resp.Attributes.AlbumName,
	}

	if Config.TagSortOrder {
		t.TitleSort = track.Resp.Attributes.Name
		t.ArtistSort = track.Resp.Attributes.ArtistName
		t.ComposerSort = track.Resp.Attributes.ComposerName
		t.AlbumSort = track.Resp.Attributes.AlbumName
	}

	if Config.TagItunesID {
		if track.PreType == "albums" {
			albumID, err := strconv.ParseUint(track.PreID, 10, 64)
			if err != nil {
				return err
			}
			t.ItunesAlbumID = int32(albumID)
		}

		if len(track.Resp.Relationships.Artists.Data) > 0 {
			artistID, err := strconv.ParseUint(track.Resp.Relationships.Artists.Data[0].ID, 10, 64)
			if err != nil {
				return err
			}
			t.ItunesArtistID = int32(artistID)
		}
	}

	if (track.PreType == "playlists" || track.PreType == "stations") && !Config.UseSongInfoForPlaylist {
		t.DiscNumber = 1
		t.DiscTotal = 1
		t.TrackNumber = int16(track.TaskNum)
		t.TrackTotal = int16(track.TaskTotal)
		t.Album = track.PlaylistData.Attributes.Name
		t.AlbumArtist = track.PlaylistData.Attributes.ArtistName
		if Config.TagSortOrder {
			t.AlbumSort = track.PlaylistData.Attributes.Name
			t.AlbumArtistSort = track.PlaylistData.Attributes.ArtistName
		}
	} else if (track.PreType == "playlists" || track.PreType == "stations") && Config.UseSongInfoForPlaylist {
		t.DiscTotal = int16(track.DiscTotal)
		t.TrackTotal = int16(track.AlbumData.Attributes.TrackCount)
		t.AlbumArtist = track.AlbumData.Attributes.ArtistName
		t.Custom["UPC"] = track.AlbumData.Attributes.Upc
		t.Custom["LABEL"] = track.AlbumData.Attributes.RecordLabel
		t.Date = track.AlbumData.Attributes.ReleaseDate
		t.Copyright = track.AlbumData.Attributes.Copyright
		t.Publisher = track.AlbumData.Attributes.RecordLabel
		if Config.TagSortOrder {
			t.AlbumArtistSort = track.AlbumData.Attributes.ArtistName
		}
	} else {
		t.DiscTotal = int16(track.DiscTotal)
		t.TrackTotal = int16(track.AlbumData.Attributes.TrackCount)
		t.AlbumArtist = track.AlbumData.Attributes.ArtistName
		t.Custom["UPC"] = track.AlbumData.Attributes.Upc
		t.Date = track.AlbumData.Attributes.ReleaseDate
		t.Copyright = track.AlbumData.Attributes.Copyright
		t.Publisher = track.AlbumData.Attributes.RecordLabel
		if Config.TagSortOrder {
			t.AlbumArtistSort = track.AlbumData.Attributes.ArtistName
		}
	}

	if track.Resp.Attributes.ContentRating == "explicit" {
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryExplicit
	} else if track.Resp.Attributes.ContentRating == "clean" {
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryClean
	} else {
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryNone
	}

	mp4, err := mp4tag.Open(track.SavePath)
	if err != nil {
		return err
	}
	defer mp4.Close()
	err = mp4.Write(t, []string{})
	if err != nil {
		return err
	}
	return nil
}

func main() {
	if err := loadConfig(); err != nil {
		log.Printf("load config failed (%v); using defaults", err)
		Config.Storefront = "us"
		Config.Language = "en-US"
		Config.AlacSaveFolder = "AM-DL downloads"
		Config.AacSaveFolder = "AM-DL-AAC downloads"
		Config.AtmosSaveFolder = "AM-DL-Atmos downloads"
		Config.MVSaveFolder = "AM-DL-MV downloads"
		Config.AlacStreamFolder = "AM-Stream-ALAC"
		Config.AacStreamFolder = "AM-Stream-AAC"
		Config.AtmosStreamFolder = "AM-Stream-Atmos"
		Config.AacType = "aac-lc"
		Config.AlacMax = 192000
		Config.AtmosMax = 2768
		Config.LimitMax = 2000
		Config.MaxMemoryLimit = 4096
		Config.CoverSize = "5000x5000"
		Config.CoverFormat = "original"
		Config.LrcType = "lyrics"
		Config.LrcFormat = "lrc"
		Config.EmbedCover = true
		Config.EmbedLrc = true
		Config.GetM3u8Mode = "hires"
		Config.GetM3u8FromDevice = true
		Config.DecryptM3u8Port = "127.0.0.1:10020"
		Config.GetM3u8Port = "127.0.0.1:20020"
		Config.MVAudioType = "atmos"
		Config.MVMax = 2160
		Config.AlbumFolderFormat = "{AlbumName}"
		Config.SongFileFormat = "{SongNumer}. {SongName}"
		Config.PlaylistFolderFormat = "{PlaylistName}"
		Config.ArtistFolderFormat = "{UrlArtistName}"
		Config.ExplicitChoice = "[E]"
		Config.CleanChoice = "[C]"
		Config.AppleMasterChoice = "[M]"
		Config.FFmpegPath = "ffmpeg"
		Config.StreamCacheSize = 500
	}
	pflag.IntVar(&api_port, "api", 0, "Start local HTTP API server on given port (e.g. --api 20025)")
	pflag.Parse()
	runv3.WarmCache()
	if api_port > 0 {
		srv := NewAPIServer(api_port)
		if err := srv.Start(); err != nil {
			fmt.Println("API server failed to start:", err)
			os.Exit(1)
		}
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\nShutting down API server…")
		srv.Stop()
		return
	}
	fmt.Fprintln(os.Stderr, "Usage: apple-music-cli --api <port>")
	os.Exit(1)
}

func mvDownloader(adamID string, saveDir string, token string, storefront string, mediaUserToken string, track *task.Track) (string, error) {
	MVInfo, err := ampapi.GetMusicVideoResp(storefront, adamID, Config.Language, token)
	if err != nil {
		fmt.Println("\u26A0 Failed to get MV manifest:", err)
		return "", nil
	}

	if strings.HasSuffix(saveDir, ".") {
		saveDir = strings.ReplaceAll(saveDir, ".", "")
	}
	saveDir = strings.TrimSpace(saveDir)

	vidPath := filepath.Join(saveDir, fmt.Sprintf("%s_vid.mp4", adamID))
	audPath := filepath.Join(saveDir, fmt.Sprintf("%s_aud.mp4", adamID))
	mvSaveName := fmt.Sprintf("%s (%s)", MVInfo.Data[0].Attributes.Name, adamID)
	if track != nil {
		mvSaveName = fmt.Sprintf("%02d. %s", track.TaskNum, MVInfo.Data[0].Attributes.Name)
	}

	mvOutPath := filepath.Join(saveDir, fmt.Sprintf("%s.mp4", forbiddenNames.ReplaceAllString(mvSaveName, "_")))

	fmt.Println(MVInfo.Data[0].Attributes.Name)

	exists, _ := fileExists(mvOutPath)
	if exists {
		fmt.Println("MV already exists locally.")

		mvArtistName := MVInfo.Data[0].Attributes.ArtistName
		mvAlbumName := MVInfo.Data[0].Attributes.AlbumName
		mvName := MVInfo.Data[0].Attributes.Name
		mvArtistId := ""
		if len(MVInfo.Data[0].Relationships.Artists.Data) > 0 {
			mvArtistId = MVInfo.Data[0].Relationships.Artists.Data[0].ID
		}

		AddedTracks = append(AddedTracks, AddedTrack{
			Path:     mvOutPath,
			Artist:   mvArtistName,
			ArtistID: mvArtistId,
			Album:    mvAlbumName,
			Song:     mvName,
		})
		return mvOutPath, nil
	}

	mvm3u8url, _, _, _ := runv3.GetWebplayback(adamID, token, mediaUserToken, true)
	if mvm3u8url == "" {
		return "", errors.New("media-user-token may wrong or expired")
	}

	os.MkdirAll(saveDir, os.ModePerm)
	videom3u8url, _ := extractVideo(mvm3u8url)
	audiom3u8url, _ := extractMvAudio(mvm3u8url)

	type mvResult struct {
		keyAndUrls string
		err        error
	}
	vidKeyCh := make(chan mvResult, 1)
	audKeyCh := make(chan mvResult, 1)
	go func() {
		kau, err := runv3.Run(adamID, videom3u8url, token, mediaUserToken, true, "")
		vidKeyCh <- mvResult{kau, err}
	}()
	go func() {
		kau, err := runv3.Run(adamID, audiom3u8url, token, mediaUserToken, true, "")
		audKeyCh <- mvResult{kau, err}
	}()
	vidKeyRes := <-vidKeyCh
	audKeyRes := <-audKeyCh
	videokeyAndUrls := vidKeyRes.keyAndUrls
	audiokeyAndUrls := audKeyRes.keyAndUrls

	defer os.Remove(vidPath)
	defer os.Remove(audPath)
	var dlWg sync.WaitGroup
	dlWg.Add(2)
	go func() {
		defer dlWg.Done()
		_ = runv3.ExtMvDataResumable(videokeyAndUrls, vidPath)
	}()
	go func() {
		defer dlWg.Done()
		_ = runv3.ExtMvDataResumable(audiokeyAndUrls, audPath)
	}()
	dlWg.Wait()

	tags := []string{
		"tool=",
		fmt.Sprintf("artist=%s", MVInfo.Data[0].Attributes.ArtistName),
		fmt.Sprintf("title=%s", MVInfo.Data[0].Attributes.Name),
		fmt.Sprintf("genre=%s", MVInfo.Data[0].Attributes.GenreNames[0]),
		fmt.Sprintf("created=%s", MVInfo.Data[0].Attributes.ReleaseDate),
		fmt.Sprintf("ISRC=%s", MVInfo.Data[0].Attributes.Isrc),
	}

	if MVInfo.Data[0].Attributes.ContentRating == "explicit" {
		tags = append(tags, "rating=1")
	} else if MVInfo.Data[0].Attributes.ContentRating == "clean" {
		tags = append(tags, "rating=2")
	} else {
		tags = append(tags, "rating=0")
	}

	if track != nil {
		if track.PreType == "playlists" && !Config.UseSongInfoForPlaylist {
			tags = append(tags, "disk=1/1")
			tags = append(tags, fmt.Sprintf("album=%s", track.PlaylistData.Attributes.Name))
			tags = append(tags, fmt.Sprintf("track=%d", track.TaskNum))
			tags = append(tags, fmt.Sprintf("tracknum=%d/%d", track.TaskNum, track.TaskTotal))
			tags = append(tags, fmt.Sprintf("album_artist=%s", track.PlaylistData.Attributes.ArtistName))
			tags = append(tags, fmt.Sprintf("performer=%s", track.Resp.Attributes.ArtistName))
		} else if track.PreType == "playlists" && Config.UseSongInfoForPlaylist {
			tags = append(tags, fmt.Sprintf("album=%s", track.AlbumData.Attributes.Name))
			tags = append(tags, fmt.Sprintf("disk=%d/%d", track.Resp.Attributes.DiscNumber, track.DiscTotal))
			tags = append(tags, fmt.Sprintf("track=%d", track.Resp.Attributes.TrackNumber))
			tags = append(tags, fmt.Sprintf("tracknum=%d/%d", track.Resp.Attributes.TrackNumber, track.AlbumData.Attributes.TrackCount))
			tags = append(tags, fmt.Sprintf("album_artist=%s", track.AlbumData.Attributes.ArtistName))
			tags = append(tags, fmt.Sprintf("performer=%s", track.Resp.Attributes.ArtistName))
			tags = append(tags, fmt.Sprintf("copyright=%s", track.AlbumData.Attributes.Copyright))
			tags = append(tags, fmt.Sprintf("UPC=%s", track.AlbumData.Attributes.Upc))
		} else {
			tags = append(tags, fmt.Sprintf("album=%s", track.AlbumData.Attributes.Name))
			tags = append(tags, fmt.Sprintf("disk=%d/%d", track.Resp.Attributes.DiscNumber, track.DiscTotal))
			tags = append(tags, fmt.Sprintf("track=%d", track.Resp.Attributes.TrackNumber))
			tags = append(tags, fmt.Sprintf("tracknum=%d/%d", track.Resp.Attributes.TrackNumber, track.AlbumData.Attributes.TrackCount))
			tags = append(tags, fmt.Sprintf("album_artist=%s", track.AlbumData.Attributes.ArtistName))
			tags = append(tags, fmt.Sprintf("performer=%s", track.Resp.Attributes.ArtistName))
			tags = append(tags, fmt.Sprintf("copyright=%s", track.AlbumData.Attributes.Copyright))
			tags = append(tags, fmt.Sprintf("UPC=%s", track.AlbumData.Attributes.Upc))
		}
	} else {
		tags = append(tags, fmt.Sprintf("album=%s", MVInfo.Data[0].Attributes.AlbumName))
		tags = append(tags, fmt.Sprintf("disk=%d", MVInfo.Data[0].Attributes.DiscNumber))
		tags = append(tags, fmt.Sprintf("track=%d", MVInfo.Data[0].Attributes.TrackNumber))
		tags = append(tags, fmt.Sprintf("tracknum=%d", MVInfo.Data[0].Attributes.TrackNumber))
		tags = append(tags, fmt.Sprintf("performer=%s", MVInfo.Data[0].Attributes.ArtistName))
	}

	var covPath string
	if true {
		thumbURL := MVInfo.Data[0].Attributes.Artwork.URL
		baseThumbName := forbiddenNames.ReplaceAllString(mvSaveName, "_") + "_thumbnail"
		covPath, err = writeCover(saveDir, baseThumbName, thumbURL)
		if err != nil {
			fmt.Println("Failed to save MV thumbnail:", err)
		} else {
			tags = append(tags, fmt.Sprintf("cover=%s", covPath))
		}
	}
	defer os.Remove(covPath)

	tagsString := strings.Join(tags, ":")
	muxCmd := exec.Command("MP4Box", "-itags", tagsString, "-quiet", "-add", vidPath, "-add", audPath, "-keep-utc", "-new", mvOutPath)
	fmt.Printf("MV Remuxing...")
	if err := muxCmd.Run(); err != nil {
		fmt.Printf("MV mux failed: %v\n", err)
		return "", err
	}
	fmt.Printf("\rMV Remuxed.   \n")

	// Append to AddedTracks
	mvArtistName := MVInfo.Data[0].Attributes.ArtistName
	mvAlbumName := MVInfo.Data[0].Attributes.AlbumName
	mvName := MVInfo.Data[0].Attributes.Name
	mvArtistId := ""
	if len(MVInfo.Data[0].Relationships.Artists.Data) > 0 {
		mvArtistId = MVInfo.Data[0].Relationships.Artists.Data[0].ID
	}

	AddedTracks = append(AddedTracks, AddedTrack{
		Path:     mvOutPath,
		Artist:   mvArtistName,
		ArtistID: mvArtistId,
		Album:    mvAlbumName,
		Song:     mvName,
	})

	return mvOutPath, nil
}

// mvStreamToPlayer streams a music video to the player without waiting for the
// full download. Architecture:
//
//	Video segments → decrypt → named pipe ─┐
//	                                        ├─ ffmpeg mux → HTTP server → player
//	Audio segments → decrypt → named pipe ─┘
//
// Video is typically tiny (2-4 MB) and downloads in ~1-2s. ffmpeg buffers all
// video frames and interleaves them with audio frames as audio arrives.  The
// player connects immediately and begins playback once ffmpeg has enough data.
func mvStreamToPlayer(adamID, token, storefront, mediaUserToken string) error {
	mvm3u8url, _, _, _ := runv3.GetWebplayback(adamID, token, mediaUserToken, true)
	if mvm3u8url == "" {
		return errors.New("media-user-token may be wrong or expired")
	}
	videom3u8url, err := extractVideo(mvm3u8url)
	if err != nil {
		return fmt.Errorf("extract video stream: %w", err)
	}
	audiom3u8url, err := extractMvAudio(mvm3u8url)
	if err != nil {
		return fmt.Errorf("extract audio stream: %w", err)
	}

	// Fetch decryption keys for video and audio in parallel.
	type keyRes struct {
		kau string
		err error
	}
	vidCh, audCh := make(chan keyRes, 1), make(chan keyRes, 1)
	go func() {
		kau, e := runv3.Run(adamID, videom3u8url, token, mediaUserToken, true, "")
		vidCh <- keyRes{kau, e}
	}()
	go func() {
		kau, e := runv3.Run(adamID, audiom3u8url, token, mediaUserToken, true, "")
		audCh <- keyRes{kau, e}
	}()
	vidKey := <-vidCh
	audKey := <-audCh
	if vidKey.err != nil {
		return fmt.Errorf("video key: %w", vidKey.err)
	}
	if audKey.err != nil {
		return fmt.Errorf("audio key: %w", audKey.err)
	}

	// ── Download video to temp file ───────────────────────────────────────────
	// VLC handles fragmented MP4 (fMP4) natively, so no MP4Box post-processing
	// is needed.  We prefer VLC for MV streaming; mpv needs a separate MP4Box
	// pass first (fMP4 duration=0 causes mpv to stop after the first fragment).
	// Audio is served via HTTP so the player can begin audio immediately; VLC
	// syncs both tracks by PTS.
	//
	// Video is written to a temp file so VLC gets a seekable backing store.
	// VLC can open the file while it's still growing — it uses the demuxer's
	// caching window, so playback begins after a few seconds of buffering.
	player := ""
	for _, p := range []string{"vlc", "mpv", "ffplay"} {
		if _, err := exec.LookPath(p); err == nil {
			player = p
			break
		}
	}
	if player == "" {
		return errors.New("no supported player found (vlc, mpv, or ffplay)")
	}

	tmpVidDir := "/dev/shm"
	if _, serr := os.Stat(tmpVidDir); serr != nil {
		tmpVidDir = os.TempDir()
	}
	tmpVid, err := os.CreateTemp(tmpVidDir, "am-vid-*.mp4")
	if err != nil {
		return fmt.Errorf("tmp video: %w", err)
	}
	tmpVidPath := tmpVid.Name()
	defer os.Remove(tmpVidPath)

	// Signal when the first 4 MiB are on disk so the player can open the file
	// before the download finishes (VLC buffers via its file-caching window).
	const vidReadyThreshold = 4 << 20 // 4 MiB
	vidReady := make(chan struct{})
	tw := &thresholdWriter{w: tmpVid, threshold: vidReadyThreshold, ch: vidReady}

	vidCtx, cancelVid := context.WithCancel(context.Background())
	defer cancelVid()
	vidErrCh := make(chan error, 1)
	go func() {
		err := runv3.StreamMvData(vidCtx, vidKey.kau, tw)
		tmpVid.Close()
		vidErrCh <- err
	}()

	// ── Audio HTTP server ─────────────────────────────────────────────────────
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Remove(tmpVidPath)
		return fmt.Errorf("listen: %w", err)
	}
	audioURL := fmt.Sprintf("http://127.0.0.1:%d/audio", listener.Addr().(*net.TCPAddr).Port)
	mux := http.NewServeMux()
	mux.HandleFunc("/audio", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mp4")
		if err := runv3.StreamMvData(r.Context(), audKey.kau, w); err != nil && r.Context().Err() == nil {
			fmt.Println("audio stream:", err)
		}
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(listener)
	defer srv.Close()

	// ── Wait for enough video, then launch player ─────────────────────────────
	fmt.Print("Buffering video...")
	select {
	case <-vidReady:
		fmt.Println(" ready")
	case err := <-vidErrCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("video download: %w", err)
		}
		fmt.Println(" done (short clip)")
	case <-time.After(60 * time.Second):
		return fmt.Errorf("video download timed out after 60s")
	}

	fmt.Printf("▶️  Streaming MV via %s\n", player)

	var playerCmd *exec.Cmd
	switch player {
	case "vlc":
		playerCmd = exec.Command("vlc",
			"--play-and-exit",
			"--no-repeat",
			"--no-loop",
			fmt.Sprintf("--input-slave=%s", audioURL),
			tmpVidPath,
		)
	case "mpv":
		// mpv cannot play fMP4 without MP4Box post-processing (duration=0 in
		// moov causes mpv to stop after the first fragment).  Run MP4Box on
		// the completed file before handing it to mpv.
		select {
		case err := <-vidErrCh:
			if err != nil && !errors.Is(err, context.Canceled) {
				return fmt.Errorf("video download: %w", err)
			}
		case <-time.After(5 * time.Minute):
			return fmt.Errorf("video download timed out")
		}
		mp4boxFix := exec.Command("MP4Box", "-noprog", "-itags", "tool=", tmpVidPath)
		mp4boxFix.Stdout = io.Discard
		mp4boxFix.Stderr = io.Discard
		if mp4boxFix.Run() != nil {
			fixed := tmpVidPath + ".fixed.mp4"
			ffCmd := exec.Command("ffmpeg", "-y", "-loglevel", "quiet",
				"-i", tmpVidPath, "-c", "copy", "-movflags", "+faststart", fixed)
			if ffCmd.Run() == nil {
				os.Rename(fixed, tmpVidPath)
			} else {
				os.Remove(fixed)
			}
		}
		playerCmd = exec.Command("mpv",
			"--hwdec=auto",
			"--really-quiet",
			"--input-terminal=yes",
			"--terminal=yes",
			fmt.Sprintf("--audio-file=%s", audioURL),
			tmpVidPath,
		)
	default:
		playerCmd = exec.Command("ffplay",
			"-i", tmpVidPath,
		)
	}
	playerCmd.Stdin = os.Stdin
	playerCmd.Stdout = os.Stdout
	playerCmd.Stderr = os.Stderr
	if err := playerCmd.Start(); err != nil {
		return fmt.Errorf("launch player: %w", err)
	}

	playerCmd.Wait()
	// Let the download goroutine drain before deferred cleanup removes the file.
	select {
	case <-vidErrCh:
	case <-time.After(2 * time.Second):
	}
	return nil
}

// mvPipeToPlayer streams a music video by piping the decrypted fMP4 directly
// to the player's stdin.  No temp file is created.
//
// When a player reads from a non-seekable pipe it cannot seek to read mvhd
// duration, so it processes fragments linearly until EOF — this sidesteps the
// fMP4 duration=0 issue that causes mpv to stop early when playing a file.
// Audio is still served via HTTP so both tracks can be decoded concurrently.
func mvPipeToPlayer(adamID, token, storefront, mediaUserToken string) error {
	mvm3u8url, _, _, _ := runv3.GetWebplayback(adamID, token, mediaUserToken, true)
	if mvm3u8url == "" {
		return errors.New("media-user-token may be wrong or expired")
	}
	videom3u8url, err := extractVideo(mvm3u8url)
	if err != nil {
		return fmt.Errorf("extract video stream: %w", err)
	}
	audiom3u8url, err := extractMvAudio(mvm3u8url)
	if err != nil {
		return fmt.Errorf("extract audio stream: %w", err)
	}

	type keyRes struct {
		kau string
		err error
	}
	vidCh, audCh := make(chan keyRes, 1), make(chan keyRes, 1)
	go func() {
		kau, e := runv3.Run(adamID, videom3u8url, token, mediaUserToken, true, "")
		vidCh <- keyRes{kau, e}
	}()
	go func() {
		kau, e := runv3.Run(adamID, audiom3u8url, token, mediaUserToken, true, "")
		audCh <- keyRes{kau, e}
	}()
	vidKey := <-vidCh
	audKey := <-audCh
	if vidKey.err != nil {
		return fmt.Errorf("video key: %w", vidKey.err)
	}
	if audKey.err != nil {
		return fmt.Errorf("audio key: %w", audKey.err)
	}

	// ── Audio HTTP server ─────────────────────────────────────────────────────
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	audioURL := fmt.Sprintf("http://127.0.0.1:%d/audio", listener.Addr().(*net.TCPAddr).Port)
	mux := http.NewServeMux()
	mux.HandleFunc("/audio", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mp4")
		if err := runv3.StreamMvData(r.Context(), audKey.kau, w); err != nil && r.Context().Err() == nil {
			fmt.Println("audio stream:", err)
		}
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(listener)
	defer srv.Close()

	// ── Video pipe ────────────────────────────────────────────────────────────
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		if err := runv3.StreamMvData(ctx, vidKey.kau, pw); err != nil {
			pw.CloseWithError(err)
		} else {
			pw.Close()
		}
	}()

	// Prefer VLC for pipe: VLC probes the ftyp magic from the first bytes and
	// selects its MP4 demuxer even on a non-seekable stdin.  mpv exits
	// immediately on fMP4 pipe input because libavformat can't seek to
	// probe the moov box.
	player := ""
	for _, p := range []string{"vlc", "mpv", "ffplay"} {
		if _, err := exec.LookPath(p); err == nil {
			player = p
			break
		}
	}
	if player == "" {
		return errors.New("no supported player found (mpv, vlc, or ffplay)")
	}

	var playerCmd *exec.Cmd
	switch player {
	case "mpv":
		playerCmd = exec.Command("mpv",
			"--hwdec=auto",
			"--really-quiet",
			"--input-terminal=yes",
			"--terminal=yes",
			fmt.Sprintf("--audio-file=%s", audioURL),
			"-",
		)
	case "vlc":
		playerCmd = exec.Command("vlc",
			"--play-and-exit",
			"--no-repeat",
			"--no-loop",
			fmt.Sprintf("--input-slave=%s", audioURL),
			"-",
		)
	default:
		playerCmd = exec.Command("ffplay", "-i", "pipe:0")
	}
	playerCmd.Stdin = pr
	playerCmd.Stdout = os.Stdout
	playerCmd.Stderr = os.Stderr

	fmt.Printf("▶️  Streaming MV via %s (pipe)\n", player)
	return playerCmd.Run()
}

func extractMvAudio(c string) (string, error) {
	MediaUrl, err := url.Parse(c)
	if err != nil {
		return "", err
	}

	resp, err := http.Get(c)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.New(resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	audioString := string(body)
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(audioString), true)
	if err != nil || listType != m3u8.MASTER {
		return "", errors.New("m3u8 not of media type")
	}

	audio := from.(*m3u8.MasterPlaylist)

	var audioPriority = []string{"audio-atmos", "audio-ac3", "audio-stereo-256"}
	if Config.MVAudioType == "ac3" {
		audioPriority = []string{"audio-ac3", "audio-stereo-256"}
	} else if Config.MVAudioType == "aac" {
		audioPriority = []string{"audio-stereo-256"}
	}

	re := regexp.MustCompile(`_gr(\d+)_`)

	type AudioStream struct {
		URL     string
		Rank    int
		GroupID string
	}
	var audioStreams []AudioStream

	for _, variant := range audio.Variants {
		for _, audiov := range variant.Alternatives {
			if audiov.URI != "" {
				for _, priority := range audioPriority {
					if audiov.GroupId == priority {
						matches := re.FindStringSubmatch(audiov.URI)
						if len(matches) == 2 {
							var rank int
							fmt.Sscanf(matches[1], "%d", &rank)
							streamUrl, _ := MediaUrl.Parse(audiov.URI)
							audioStreams = append(audioStreams, AudioStream{
								URL:     streamUrl.String(),
								Rank:    rank,
								GroupID: audiov.GroupId,
							})
						}
					}
				}
			}
		}
	}

	if len(audioStreams) == 0 {
		return "", errors.New("no suitable audio stream found")
	}

	sort.Slice(audioStreams, func(i, j int) bool {
		return audioStreams[i].Rank > audioStreams[j].Rank
	})
	fmt.Println("Audio: " + audioStreams[0].GroupID)
	return audioStreams[0].URL, nil
}

func checkM3u8(b string, f string) (string, error) {
	var EnhancedHls string
	if Config.GetM3u8FromDevice {
		adamID := b
		conn, err := net.Dial("tcp", Config.GetM3u8Port)
		if err != nil {
			fmt.Println("Error connecting to device:", err)
			return "none", err
		}
		defer conn.Close()
		if f == "song" {
			fmt.Println("Connected to device")
		}

		adamIDBuffer := []byte(adamID)
		lengthBuffer := []byte{byte(len(adamIDBuffer))}

		_, err = conn.Write(lengthBuffer)
		if err != nil {
			fmt.Println("Error writing length to device:", err)
			return "none", err
		}

		_, err = conn.Write(adamIDBuffer)
		if err != nil {
			fmt.Println("Error writing adamID to device:", err)
			return "none", err
		}

		response, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			fmt.Println("Error reading response from device:", err)
			return "none", err
		}

		response = bytes.TrimSpace(response)
		if len(response) > 0 {
			if f == "song" {
				fmt.Println("Received URL:", string(response))
			}
			EnhancedHls = string(response)
		} else {
			fmt.Println("Received an empty response")
		}
	}
	return EnhancedHls, nil
}

func extractMedia(b string) (string, string, error) {
	master, masterUrl, err := manifest.FetchMaster(b)
	if err != nil {
		return "", "", err
	}
	sort.Slice(master.Variants, func(i, j int) bool {
		return master.Variants[i].AverageBandwidth > master.Variants[j].AverageBandwidth
	})
	var f manifest.Format
	switch {
	case dl_atmos:
		f = manifest.FormatAtmos
	case dl_aac:
		f = manifest.FormatAAC
	default:
		f = manifest.FormatALAC
	}
	sel, err := manifest.SelectVariant(master, masterUrl, f, Config)
	if err != nil {
		return "", "", err
	}
	if sel.Display != "" {
		fmt.Printf("%s\n", sel.Display)
	}
	return sel.MediaURL, sel.Quality, nil
}
func extractVideo(c string) (string, error) {
	MediaUrl, err := url.Parse(c)
	if err != nil {
		return "", err
	}

	resp, err := http.Get(c)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.New(resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	videoString := string(body)

	from, listType, err := m3u8.DecodeFrom(strings.NewReader(videoString), true)
	if err != nil || listType != m3u8.MASTER {
		return "", errors.New("m3u8 not of media type")
	}

	video := from.(*m3u8.MasterPlaylist)

	re := regexp.MustCompile(`_(\d+)x(\d+)`)

	var streamUrl *url.URL
	sort.Slice(video.Variants, func(i, j int) bool {
		return video.Variants[i].AverageBandwidth > video.Variants[j].AverageBandwidth
	})

	maxHeight := Config.MVMax

	for _, variant := range video.Variants {
		matches := re.FindStringSubmatch(variant.URI)
		if len(matches) == 3 {
			height := matches[2]
			var h int
			_, err := fmt.Sscanf(height, "%d", &h)
			if err != nil {
				continue
			}
			if h <= maxHeight {
				streamUrl, err = MediaUrl.Parse(variant.URI)
				if err != nil {
					return "", err
				}
				fmt.Println("Video: " + variant.Resolution + "-" + variant.VideoRange)
				break
			}
		}
	}

	if streamUrl == nil {
		return "", errors.New("no suitable video stream found")
	}

	return streamUrl.String(), nil
}

func ripSong(songId string, token string, storefront string, mediaUserToken string) error {
	// Get song info to find album ID
	manifest, err := ampapi.GetSongResp(storefront, songId, Config.Language, token)
	if err != nil {
		fmt.Println("Failed to get song response.")
		return err
	}

	songData := manifest.Data[0]
	albumId := songData.Relationships.Albums.Data[0].ID

	// Use album approach but only download the specific song
	dl_song = true
	err = ripAlbum(albumId, token, storefront, mediaUserToken, songId)
	if err != nil {
		fmt.Println("Failed to rip song:", err)
		return err
	}

	return nil
}
