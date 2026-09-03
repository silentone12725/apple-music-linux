package main

import (
	"flag"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"engine/utils/aacstream"
	"engine/utils/config"

	"gopkg.in/yaml.v2"
)

var (
	api_port int
	Config   config.ConfigSet
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
	flag.IntVar(&api_port, "api", 0, "Start local HTTP API server on given port (e.g. --api 20025)")
	flag.Parse()
	aacstream.WarmCache()
	if api_port > 0 {
		srv := NewAPIServer(api_port, ServerConfig{
			DRMBinaryPath:      Config.DRMBinaryPath,
			DRMBaseDir:         Config.DRMBaseDir,
			BackendPreferred:   Config.Backend.Preferred,
			BackendFallback:    Config.Backend.Fallback,
			UseEmbeddedBackend: Config.UseEmbeddedBackend,
			DecryptM3u8Port:    Config.DecryptM3u8Port,
			GetM3u8Port:        Config.GetM3u8Port,
		})
		if err := srv.Start(); err != nil {
			slog.Error("API server failed to start", "err", err)
			os.Exit(1)
		}
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("Shutting down API server")
		srv.Stop()
		return
	}
	slog.Error("Usage: engine --api <port>")
	os.Exit(1)
}
