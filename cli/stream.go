package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"
	"path/filepath"
	"sort"
	"strings"

	"main/utils/runv2"
	"main/utils/task"
)

// thresholdWriter wraps an io.Writer and closes ch once at least threshold
// bytes have been written.  Used to signal when enough video data is on disk
// to start the player without waiting for the full download to complete.
type thresholdWriter struct {
	w         io.Writer
	threshold int64
	written   int64
	once      sync.Once
	ch        chan struct{}
}

func (t *thresholdWriter) Write(p []byte) (int, error) {
	n, err := t.w.Write(p)
	t.written += int64(n)
	if t.written >= t.threshold {
		t.once.Do(func() { close(t.ch) })
	}
	return n, err
}

// waitForIPC polls until mpv's IPC socket is ready or 300ms elapses.
// Saves ~250ms on fast machines where mpv starts in ~50ms.
func waitForIPC(ipcPath string) {
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ipcPath); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type PlayerSession struct {
    cmd      *exec.Cmd
    ipcPath  string
}

func (p *PlayerSession) Stop() error {
    return p.sendIPC(`{"command": ["quit"]}`)
}

func (p *PlayerSession) Next() error {
	return p.sendIPC(`{"command": ["playlist-next"]}`)
}

func (p *PlayerSession) Previous() error {
	return p.sendIPC(`{"command": ["playlist-prev"]}`)
}

func (p *PlayerSession) TogglePause() error {
	return p.sendIPC(`{"command": ["cycle", "pause"]}`)
}

func (p *PlayerSession) WaitDone() {
	p.cmd.Wait()
}

func (p *PlayerSession) sendIPC(msg string) error {
    conn, err := net.Dial("unix", p.ipcPath)
    if err != nil {
        return err
    }
    defer conn.Close()
    _, err = fmt.Fprintf(conn, msg+"\n")
    return err
}

func PlayMediaBackground(filePath string, audioTraits []string) (*PlayerSession, error) {
	ipcPath := fmt.Sprintf("/tmp/mpv-ipc-%d.sock", os.Getpid())
	sampleRate, audioFormat := traitsToFormat(audioTraits)
	cmd := exec.Command("mpv",
		"--hwdec=auto",
		"--audio-device=pipewire",
		fmt.Sprintf("--audio-samplerate=%s", sampleRate),
		fmt.Sprintf("--audio-format=%s", audioFormat),
		fmt.Sprintf("--input-ipc-server=%s", ipcPath),
		"--no-video",
		"--really-quiet",
		"--input-terminal=yes",
		"--terminal=yes",
		"--input-media-keys=yes",
		filePath,
	)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	waitForIPC(ipcPath)
	return &PlayerSession{cmd: cmd, ipcPath: ipcPath}, nil
}

func traitsToFormat(audioTraits []string) (string, string) {
    for _, trait := range audioTraits {
        switch trait {
        case "hi-res-lossless":
            return "96000", "s32"
        case "lossless":
            return "44100", "s32"
        case "atmos":
            return "48000", "float"
        }
    }
    return "44100", "s16"
}

// streamCacheResult holds the result of a background track preparation.
type streamCacheResult struct {
	path string
	err  error
}

// streamCache maps track.ID → buffered channel (cap 1) with the prepared temp file path.
var streamCache sync.Map

// Stream playlist collector — used when play_stream is true for albums/playlists
var streamPlaylistPaths []string
var streamPlaylistTraits []string

func ResetStreamPlaylist() {
	streamPlaylistPaths = nil
	streamPlaylistTraits = nil
}

func AddToStreamPlaylist(path string, traits []string) {
	streamPlaylistPaths = append(streamPlaylistPaths, path)
	if len(streamPlaylistTraits) == 0 {
		streamPlaylistTraits = traits
	}
}

// startPrefetchTrack kicks off background download+decrypt+MP4Box for a track.
func startPrefetchTrack(track *task.Track, token, mediaUserToken string) {
	ch := make(chan streamCacheResult, 1)
	if _, loaded := streamCache.LoadOrStore(track.ID, ch); loaded {
		return
	}
	go func() {
		path, err := prepareAlacStreamFile(track)
		ch <- streamCacheResult{path, err}
	}()
}

// takePrefetchResult retrieves and removes a prefetched result.
func takePrefetchResult(trackID string) (streamCacheResult, bool) {
	v, ok := streamCache.LoadAndDelete(trackID)
	if !ok {
		return streamCacheResult{}, false
	}
	return <-v.(chan streamCacheResult), true
}

// prepareAlacStreamFile downloads, decrypts, and MP4Box-converts a track to a /dev/shm temp file.
func prepareAlacStreamFile(track *task.Track) (string, error) {
	needDlAacLc := dl_aac && Config.AacType == "aac-lc"
	if track.WebM3u8 == "" && !needDlAacLc {
		needDlAacLc = true
	}
	if needDlAacLc {
		return "", nil
	}
	trackM3u8Url, _, err := extractMedia(track.M3u8, false)
	if err != nil {
		return "", fmt.Errorf("extractMedia: %w", err)
	}
	tmpDir := "/dev/shm"
	if _, serr := os.Stat(tmpDir); serr != nil {
		tmpDir = os.TempDir()
	}
	tf, err := os.CreateTemp(tmpDir, "am-stream-*.m4a")
	if err != nil {
		return "", err
	}
	tempPath := tf.Name()
	tf.Close()
	os.Remove(tempPath)
	if err := runv2.Run(track.ID, trackM3u8Url, tempPath, Config); err != nil {
		os.Remove(tempPath)
		return "", fmt.Errorf("runv2.Run: %w", err)
	}
	// Convert fMP4 → regular m4a so mpv sees the full duration metadata.
	mp4boxCmd := exec.Command("MP4Box", "-noprog", "-itags", "tool=", tempPath)
	mp4boxCmd.Stderr = io.Discard
	mp4boxCmd.Stdout = io.Discard
	mp4boxCmd.Run()
	return tempPath, nil
}

// PlayMedia plays a file using ffplay or mpv, whichever is available.
func PlayMedia(filePath string, audioTraits []string) error {
	ipcPath := fmt.Sprintf("/tmp/mpv-ipc-%d.sock", os.Getpid())
	sampleRate, audioFormat := traitsToFormat(audioTraits)
	if _, err := exec.LookPath("mpv"); err == nil {
		cmd := exec.Command("mpv",
			"--hwdec=auto",
			"--audio-device=pipewire",
			fmt.Sprintf("--audio-samplerate=%s", sampleRate),
			fmt.Sprintf("--audio-format=%s", audioFormat),
			"--no-video",
			"--really-quiet",
			fmt.Sprintf("--input-ipc-server=%s", ipcPath),
			"--input-terminal=yes",
			"--terminal=yes",
			"--input-media-keys=yes",
			filePath,
		)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	} else if _, err := exec.LookPath("ffplay"); err == nil {
		cmd := exec.Command("ffplay", "-i", filePath, "-nodisp", "-autoexit")
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	return errors.New("missing media player dependency (mpv or ffplay)")
}

// PlayMediaPlaylist launches mpv with multiple files as a playlist with IPC control.
func PlayMediaPlaylist(paths []string, audioTraits []string) (*PlayerSession, error) {
	player := resolvePlayer()
	var cmd *exec.Cmd
	var ipcPath string

	switch player {
	case "mpv":
		ipcPath = fmt.Sprintf("/tmp/mpv-ipc-%d.sock", os.Getpid())
		sampleRate, audioFormat := traitsToFormat(audioTraits)
		args := []string{
			"--hwdec=auto",
			"--audio-device=pipewire",
			fmt.Sprintf("--audio-samplerate=%s", sampleRate),
			fmt.Sprintf("--audio-format=%s", audioFormat),
			"--no-video",
			"--really-quiet",
			fmt.Sprintf("--input-ipc-server=%s", ipcPath),
			"--input-terminal=yes",
			"--terminal=yes",
			"--input-media-keys=yes",
		}
		args = append(args, paths...)
		cmd = exec.Command("mpv", args...)
	case "vlc":
		args := []string{"--intf", "dummy", "--no-video", "--play-and-exit"}
		args = append(args, paths...)
		cmd = exec.Command("vlc", args...)
	case "ffplay":
		// ffplay doesn't support playlists natively; play first track
		cmd = exec.Command("ffplay", "-i", paths[0], "-nodisp", "-autoexit")
	default:
		return nil, fmt.Errorf("no supported media player found (mpv, vlc, or ffplay)")
	}

	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if ipcPath != "" {
		waitForIPC(ipcPath)
	}
	return &PlayerSession{cmd: cmd, ipcPath: ipcPath}, nil
}

// streamDiskCachePath returns the cache file path for a track ID.
func streamDiskCachePath(trackID string, isAAC bool) string {
	cacheDir := Config.AlacStreamFolder
	if isAAC {
		cacheDir = Config.AacStreamFolder
	}
	if cacheDir == "" {
		cacheDir = os.TempDir()
	}
	os.MkdirAll(cacheDir, 0755)
	ext := "alac"
	if isAAC {
		ext = "aac"
	}
	return filepath.Join(cacheDir, fmt.Sprintf(".cache-%s.%s.m4a", trackID, ext))
}

// checkDiskCache returns cached file path if it exists and is valid.
func checkDiskCache(trackID string, isAAC bool) string {
	path := streamDiskCachePath(trackID, isAAC)
	info, err := os.Stat(path)
	if err != nil || info.Size() < 1024 {
		return ""
	}
	return path
}

// saveToDiskCache moves a temp file into the stream cache folder.
func saveToDiskCache(tempPath string, trackID string, isAAC bool) string {
	if Config.StreamCacheSize > 0 {
		go evictCacheIfNeeded(isAAC)
	}
	cachePath := streamDiskCachePath(trackID, isAAC)
	if err := os.Rename(tempPath, cachePath); err != nil {
		if err := copyFile(tempPath, cachePath); err == nil {
			os.Remove(tempPath)
		}
		return cachePath
	}
	return cachePath
}

// evictCacheIfNeeded removes oldest cache files if cache exceeds StreamCacheSize MB.
func evictCacheIfNeeded(isAAC bool) {
	cacheDir := Config.AlacStreamFolder
	if isAAC {
		cacheDir = Config.AacStreamFolder
	}
	if cacheDir == "" {
		return
	}
	maxBytes := int64(Config.StreamCacheSize) * 1024 * 1024

	type cacheEntry struct {
		path    string
		modTime time.Time
		size    int64
	}

	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}

	var files []cacheEntry
	var totalSize int64
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".cache-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, cacheEntry{
			path:    filepath.Join(cacheDir, e.Name()),
			modTime: info.ModTime(),
			size:    info.Size(),
		})
		totalSize += info.Size()
	}

	if totalSize <= maxBytes {
		return
	}

	// Sort oldest first
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})

	for _, f := range files {
		if totalSize <= maxBytes {
			break
		}
		os.Remove(f.path)
		totalSize -= f.size
		fmt.Printf("Cache evicted: %s\n", filepath.Base(f.path))
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}