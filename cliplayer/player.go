package cliplayer

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"apple-music-linux/internal/embedded"
)

type Player struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	currentURL string
}

func New() *Player {
	return &Player{}
}

func (p *Player) StartStream(url, mediaUserToken string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if url == "" {
		return fmt.Errorf("track url is empty")
	}
	if mediaUserToken == "" {
		return fmt.Errorf("media-user-token is empty")
	}

	if err := p.stopLocked(); err != nil {
		return err
	}

	configDir, err := ensureConfig(mediaUserToken)
	if err != nil {
		return err
	}

	cliPath, err := resolveCliPath()
	if err != nil {
		return err
	}

	cmd := exec.Command(cliPath, "--stream", "--song", url)
	cmd.Dir = configDir
	// Own process group so the whole group (CLI + mpv child) can be killed together.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Detach stdin so survey/TUI in the CLI doesn't block waiting for a terminal.
	devNull, err := os.Open(os.DevNull)
	if err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	p.cmd = cmd
	p.currentURL = url

	go streamLogs("[CLI]", stdoutPipe)
	go streamLogs("[CLI]", stderrPipe)

	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		if p.cmd == cmd {
			p.cmd = nil
			p.currentURL = ""
		}
		p.mu.Unlock()
		if err != nil {
			log.Printf("[CLI] Playback exited: %v", err)
		} else {
			log.Println("[CLI] Playback exited cleanly.")
		}
	}()

	return nil
}

func (p *Player) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopLocked()
}

func (p *Player) stopLocked() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	log.Println("[CLI] Stopping playback...")
	// Kill the entire process group (negative PID) so mpv, a child of the CLI
	// subprocess, is also terminated and doesn't continue as an orphan.
	pgid := p.cmd.Process.Pid
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		log.Printf("[CLI] SIGTERM to group failed (%v), sending SIGKILL", err)
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
	p.cmd = nil
	p.currentURL = ""
	return nil
}

func streamLogs(prefix string, r io.ReadCloser) {
	defer r.Close()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		log.Printf("%s %s", prefix, line)
	}
}

func resolveCliPath() (string, error) {
	if envPath := os.Getenv("APPLE_MUSIC_CLI_BIN"); envPath != "" {
		return envPath, nil
	}
	if len(embedded.AppleMusicCLIBinary) > 0 {
		return ensureEmbeddedCli()
	}
	if p, err := exec.LookPath("apple-music-downloader"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("apple-music-cli"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("apple-music-cli binary not found (set APPLE_MUSIC_CLI_BIN or install apple-music-downloader in PATH)")
}

func ensureEmbeddedCli() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("failed to resolve user config dir: %w", err)
	}
	binDir := filepath.Join(configDir, "apple-music-linux", "apple-music-cli", "bin")
	if err := os.MkdirAll(binDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create cli bin dir: %w", err)
	}
	if err := os.Chmod(binDir, 0700); err != nil {
		return "", fmt.Errorf("failed to secure cli bin dir: %w", err)
	}

	binaryPath := filepath.Join(binDir, "apple-music-cli")
	if info, err := os.Stat(binaryPath); err == nil {
		if info.Mode().IsRegular() && info.Size() == int64(len(embedded.AppleMusicCLIBinary)) {
			return binaryPath, nil
		}
	}

	if err := os.WriteFile(binaryPath, embedded.AppleMusicCLIBinary, 0700); err != nil {
		return "", fmt.Errorf("failed to extract embedded cli: %w", err)
	}
	return binaryPath, nil
}

func ensureConfig(mediaUserToken string) (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("failed to resolve user config dir: %w", err)
	}
	configDir = filepath.Join(configDir, "apple-music-linux", "apple-music-cli")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create cli config dir: %w", err)
	}
	if err := os.Chmod(configDir, 0700); err != nil {
		return "", fmt.Errorf("failed to secure cli config dir: %w", err)
	}

	configPath := filepath.Join(configDir, "config.yaml")
	config := buildConfigYAML(mediaUserToken)
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		return "", fmt.Errorf("failed to write cli config: %w", err)
	}
	return configDir, nil
}

func buildConfigYAML(mediaUserToken string) string {
	return fmt.Sprintf(`media-user-token: %q
authorization-token: ""
language: ""
storefront: "us"
max-memory-limit: 256
decrypt-m3u8-port: "127.0.0.1:10020"
get-m3u8-port: "127.0.0.1:20020"
get-m3u8-from-device: true
get-m3u8-mode: hires
aac-type: aac-lc
alac-max: 192000
atmos-max: 2768
limit-max: 200
alac-stream-folder: "AM-Stream-ALAC"
aac-stream-folder: "AM-Stream-AAC"
atmos-stream-folder: "AM-Stream-Atmos"
stream-cache-size: 500
alac-save-folder: "AM-DL downloads"
aac-save-folder: "AM-DL-AAC downloads"
atmos-save-folder: "AM-DL-Atmos downloads"
mv-save-folder: "AM-DL-MV downloads"
album-folder-format: "{AlbumName}"
artist-folder-format: "{ArtistName}"
song-file-format: "{SongNumer}. {SongName}"
playlist-folder-format: "{PlaylistName}"
embed-cover: false
embed-lrc: false
`, mediaUserToken)
}
