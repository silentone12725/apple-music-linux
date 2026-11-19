package main

import (
	"flag"
	"io"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"engine/utils/aacstream"
	"engine/utils/config"

	"gopkg.in/yaml.v2"
)

var (
	apiPort int
	Config  config.ConfigSet
)

func loadConfig() error {
	data, err := os.ReadFile("config.yaml")
	if err != nil {
		return err
	}
	if err = yaml.Unmarshal(data, &Config); err != nil {
		return err
	}
	if len(Config.Storefront) != 2 {
		Config.Storefront = "us"
	}
	return nil
}

func main() {
	// Return transient heap spikes (full-track ALAC decrypt buffers, MV cache
	// commits) to the OS. Go's GC reclaims them but retains the pages by default,
	// so the engine's RSS ratchets up and never falls. FreeOSMemory hands them
	// back. Purely additive — it only releases memory the GC already freed, so it
	// cannot OOM or throttle any playback path (ALAC/VLC included).
	go func() {
		t := time.NewTicker(2 * time.Minute)
		defer t.Stop()
		for range t.C {
			debug.FreeOSMemory()
		}
	}()

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
	flag.IntVar(&apiPort, "api", 0, "Start local HTTP API server on given port (e.g. --api 20025)")
	flag.Parse()
	aacstream.WarmCache()
	if apiPort > 0 {
		srv := NewAPIServer(apiPort, ServerConfig{
			DRMBinaryPath:   Config.DRMBinaryPath,
			DRMBaseDir:      Config.DRMBaseDir,
			ExportFloorKbps: Config.ExportThrottleFloorKbps,
		})
		if err := srv.Start(); err != nil {
			slog.Error("API server failed to start", "err", err)
			os.Exit(1)
		}
		shutdown := make(chan string, 1)
		stopFor := func(reason string) {
			select {
			case shutdown <- reason:
			default:
			}
		}
		sigCh := make(chan os.Signal, 2)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
		go func() {
			<-sigCh
			stopFor("signal")
			<-sigCh // a second signal means the first shutdown is taking too long
			slog.Error("Second signal during shutdown: exiting now")
			os.Exit(1)
		}()
		// Windows has no signal that reaches a child, and a parent that is killed outright cannot send
		// one. The parent therefore holds the engine's stdin open, and its closing is the stop request
		// on every platform and however the parent went away.
		if os.Getenv("ADAM_EXIT_ON_STDIN_EOF") == "1" {
			go func() {
				_, _ = io.Copy(io.Discard, os.Stdin)
				stopFor("parent closed stdin")
			}()
		}
		reason := <-shutdown
		slog.Info("Shutting down API server", "reason", reason)
		// A stop that hangs must not leave the engine running with nobody to stop it.
		time.AfterFunc(20*time.Second, func() {
			slog.Error("Shutdown timed out: exiting")
			os.Exit(1)
		})
		srv.Stop()
		return
	}
	slog.Error("Usage: engine --api <port>")
	os.Exit(1)
}
