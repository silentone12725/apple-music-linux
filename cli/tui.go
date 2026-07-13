package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"main/utils/structs"

	"github.com/AlecAivazis/survey/v2"
	"gopkg.in/yaml.v2"
)
// ── Main TUI Entry Point ─────────────────────────────────────────────────────

func RunTUI(token string) {
	for {
		choice := ""
		prompt := &survey.Select{
			Message: "Apple Music CLI",
			Options: []string{
				"🔍  Search",
				"🌐  URL",
				"🎬  Stream MV",
				"⚙️   Settings",
				"❌  Exit",
			},
			PageSize: 6,
		}
		if err := survey.AskOne(prompt, &choice); err != nil || choice == "❌  Exit" {
			fmt.Println("Goodbye.")
			return
		}

		switch choice {
		case "🔍  Search":
			tuiSearch(token)
		case "🌐  URL":
			tuiURL(token)
		case "🎬  Stream MV":
			tuiStreamMV(token)
		case "⚙️   Settings":
			tuiSettings()
		}
	}
}

// ── Search Menu ──────────────────────────────────────────────────────────────

func tuiSearch(token string) {
	searchType := ""
	prompt := &survey.Select{
		Message: "Search by:",
		Options: []string{"Song", "Album", "Artist", "Music Video", "Playlist", "← Back"},
		PageSize: 7,
	}
	if err := survey.AskOne(prompt, &searchType); err != nil || searchType == "← Back" {
		return
	}

	// Playlist doesn't support search — ask for URL directly
	if searchType == "Playlist" {
		urlInput := ""
		if err := survey.AskOne(&survey.Input{
			Message: "Paste playlist URL:",
		}, &urlInput); err != nil || urlInput == "" {
			return
		}
		play_stream = false
		dl_aac = false
		dl_atmos = false
		tuiAskActionAndQuality(false)
		tuiDispatch(urlInput, token)
		return
	}

	query := ""
	if err := survey.AskOne(&survey.Input{
		Message: fmt.Sprintf("Enter %s name:", strings.ToLower(searchType)),
	}, &query); err != nil || query == "" {
		return
	}

	// Reset flags
	play_stream = false
	dl_aac = false
	dl_atmos = false
	dl_song = false

	// Map TUI display name to API search type
	apiSearchType := strings.ToLower(searchType)
	if searchType == "Music Video" {
		apiSearchType = "music-video"
	}

	selectedUrl, err := handleSearch(apiSearchType, []string{query}, token)
	if err != nil {
		fmt.Println("Search error:", err)
		return
	}
	if selectedUrl == "" {
		return
	}
	if strings.Contains(selectedUrl, "?i=") {
		dl_song = true
	}

	// Music videos need an explicit action prompt here so play_stream is set
	// in the same stack frame as the eventual dispatch call.
	if searchType == "Music Video" {
		action := ""
		if askErr := survey.AskOne(&survey.Select{
			Message: "Action:",
			Options: []string{"Download", "Stream"},
		}, &action); askErr != nil || action == "" {
			return
		}
		play_stream = action == "Stream"
	}

	tuiDispatch(selectedUrl, token)
}
// ── Stream MV Menu ───────────────────────────────────────────────────────────

func tuiStreamMV(token string) {
	urlInput := ""
	if err := survey.AskOne(&survey.Input{
		Message: "Paste Apple Music video URL:",
		Help:    "e.g. https://music.apple.com/us/music-video/name/id",
	}, &urlInput); err != nil || urlInput == "" {
		return
	}
	if !strings.Contains(urlInput, "/music-video/") {
		fmt.Println("⚠  Not a music video URL.")
		return
	}

	mode := ""
	if err := survey.AskOne(&survey.Select{
		Message: "Stream mode:",
		Options: []string{
			"Buffered  (temp file → VLC, seeking supported)",
			"Direct    (pipe → mpv, zero disk, linear only)",
		},
	}, &mode); err != nil || mode == "" {
		return
	}

	storefront, id := checkUrlMv(urlInput)
	if storefront == "" || id == "" {
		fmt.Println("⚠  Could not parse MV URL.")
		return
	}

	if strings.HasPrefix(mode, "Direct") {
		if err := mvPipeToPlayer(id, token, storefront, Config.MediaUserToken); err != nil {
			fmt.Println("⚠  Stream error:", err)
		}
		return
	}

	play_stream = true
	tuiDispatch(urlInput, token)
}

// ── URL Menu ─────────────────────────────────────────────────────────────────

func tuiURL(token string) {
	urlInput := ""
	if err := survey.AskOne(&survey.Input{
		Message: "Paste Apple Music URL:",
	}, &urlInput); err != nil || urlInput == "" {
		return
	}

	play_stream = false
	dl_aac = false
	dl_atmos = false

	// MV doesn't support stream
	atmosAvailable := !strings.Contains(urlInput, "/music-video/")
	tuiAskActionAndQuality(atmosAvailable)

	tuiDispatch(urlInput, token)
}
// ── Dispatch URL to rip functions ────────────────────────────────────────────

func tuiDispatch(urlRaw string, token string) {
	counter = structs.Counter{}
	var storefront, id string

	switch {
	case strings.Contains(urlRaw, "/song/"):
		storefront, id = checkUrlSong(urlRaw)
		if err := ripSong(id, token, storefront, Config.MediaUserToken); err != nil {
			fmt.Println("Error:", err)
		}
	case strings.Contains(urlRaw, "/music-video/"):
		storefront, id = checkUrlMv(urlRaw)
		if play_stream {
			if err := mvStreamToPlayer(id, token, storefront, Config.MediaUserToken); err != nil {
				fmt.Println("Stream error:", err)
			}
			return
		}
		mvSaveDir := Config.MVSaveFolder
		if mvSaveDir == "" {
			mvSaveDir = "AM-DL-MV"
		}
		os.MkdirAll(mvSaveDir, 0755)
		if _, err := mvDownloader(id, mvSaveDir, token, storefront, Config.MediaUserToken, nil); err != nil {
			fmt.Println("Error:", err)
		}
	case strings.Contains(urlRaw, "/album/"):
		parsed, _ := url.Parse(urlRaw)
		urlArg_i := parsed.Query().Get("i")
		storefront, id = checkUrl(urlRaw)
		if err := ripAlbum(id, token, storefront, Config.MediaUserToken, urlArg_i); err != nil {
			fmt.Println("Error:", err)
		}
	case strings.Contains(urlRaw, "/playlist/"):
		storefront, id = checkUrlPlaylist(urlRaw)
		if err := ripPlaylist(id, token, storefront, Config.MediaUserToken); err != nil {
			fmt.Println("Error:", err)
		}
	case strings.Contains(urlRaw, "/artist/"):
		urlArtistName, urlArtistID, err := getUrlArtistName(urlRaw, token)
		if err != nil {
			fmt.Println("Failed to get artist name:", err)
			return
		}
		// Save and restore to prevent contamination across searches
		originalArtistFormat := Config.ArtistFolderFormat
		Config.ArtistFolderFormat = strings.NewReplacer(
			"{UrlArtistName}", LimitString(urlArtistName),
			"{ArtistId}", urlArtistID,
		).Replace(Config.ArtistFolderFormat)
		defer func() { Config.ArtistFolderFormat = originalArtistFormat }()

		fetchChoice := ""
		survey.AskOne(&survey.Select{
			Message: fmt.Sprintf("What to fetch for %s?", urlArtistName),
			Options: []string{"Albums only", "Music Videos only", "Both", "← Back"},
		}, &fetchChoice)
		if fetchChoice == "← Back" || fetchChoice == "" {
			return
		}

		tuiAskActionAndQuality(true)

		var urls []string
		if fetchChoice == "Albums only" || fetchChoice == "Both" {
			albumArgs, err := checkArtist(urlRaw, token, "albums")
			if err != nil {
				fmt.Println("Failed to get albums:", err)
			} else {
				urls = append(urls, albumArgs...)
			}
		}
		if fetchChoice == "Music Videos only" || fetchChoice == "Both" {
			mvArgs, err := checkArtist(urlRaw, token, "music-videos")
			if err != nil {
				fmt.Println("Failed to get music videos:", err)
			} else {
				urls = append(urls, mvArgs...)
			}
		}
		for _, u := range urls {
			tuiDispatch(u, token)
		}
		return
	default:
		// Try as album URL with ?i= track param
		storefront, id = checkUrl(urlRaw)
		if storefront != "" && id != "" {
			if err := ripAlbum(id, token, storefront, Config.MediaUserToken, ""); err != nil {
				fmt.Println("Error:", err)
			}
		} else {
			fmt.Println("Unrecognized URL format.")
		}
	}

	fmt.Printf("\n=======  [✔] Completed: %d/%d  |  [⚠] Warnings: %d  |  [✖] Errors: %d  =======\n",
		counter.Success, counter.Total, counter.Unavailable+counter.NotSong, counter.Error)
}


// ── Settings Menu ────────────────────────────────────────────────────────────

func tuiSettings() {
	for {
		choice := ""
		prompt := &survey.Select{
			Message: "Settings",
			Options: []string{
				"📁  Download Folders",
				"📁  Stream Folders",
				"🎵  Audio Quality",
				"🔄  Conversion",
				"🏷️   Tagging",
				"📝  Lyrics",
				"🖼️   Artwork",
				"🌍  Storefront & Language",
				"🔧  Advanced",
				"← Back",
			},
			PageSize: 12,
		}
		if err := survey.AskOne(prompt, &choice); err != nil || choice == "← Back" {
			return
		}

		switch choice {
		case "📁  Download Folders":
			tuiEditFolders(false)
		case "📁  Stream Folders":
			tuiEditFolders(true)
		case "🎵  Audio Quality":
			tuiEditQuality()
		case "🔄  Conversion":
			tuiEditConversion()
		case "🏷️   Tagging":
			tuiEditTagging()
		case "📝  Lyrics":
			tuiEditLyrics()
		case "🖼️   Artwork":
			tuiEditArtwork()
		case "🌍  Storefront & Language":
			tuiEditStorefront()
		case "🔧  Advanced":
			tuiEditAdvanced()
		}
	}
}

// ── Settings Sections ────────────────────────────────────────────────────────

func tuiEditFolders(stream bool) {
	if stream {
		tuiInputField("ALAC Stream Folder", &Config.AlacStreamFolder)
		tuiInputField("AAC Stream Folder", &Config.AacStreamFolder)
		tuiInputField("Atmos Stream Folder", &Config.AtmosStreamFolder)
	} else {
		tuiInputField("ALAC Download Folder", &Config.AlacSaveFolder)
		tuiInputField("AAC Download Folder", &Config.AacSaveFolder)
		tuiInputField("Atmos Download Folder", &Config.AtmosSaveFolder)
		tuiInputField("MV Download Folder", &Config.MVSaveFolder)
	}
	saveConfig()
}

func tuiEditQuality() {
	// ALAC Max
	alacOptions := []string{"192000", "96000", "48000", "44100"}
	tuiSelectField("ALAC Max Sample Rate", alacOptions, func(v string) {
		n, _ := strconv.Atoi(v)
		Config.AlacMax = n
	}, strconv.Itoa(Config.AlacMax))

	// AAC Type
	aacOptions := []string{"aac-lc", "aac", "aac-binaural", "aac-downmix"}
	tuiSelectField("AAC Type", aacOptions, func(v string) {
		Config.AacType = v
	}, Config.AacType)

	// Atmos Max
	atmosOptions := []string{"2768", "2448"}
	tuiSelectField("Atmos Max Bitrate", atmosOptions, func(v string) {
		n, _ := strconv.Atoi(v)
		Config.AtmosMax = n
	}, strconv.Itoa(Config.AtmosMax))

	// MV Audio Type
	mvOptions := []string{"atmos", "ac3", "aac"}
	tuiSelectField("MV Audio Type", mvOptions, func(v string) {
		Config.MVAudioType = v
	}, Config.MVAudioType)

	// MV Max
	mvMaxOptions := []string{"2160", "1080", "720"}
	tuiSelectField("MV Max Resolution", mvMaxOptions, func(v string) {
		n, _ := strconv.Atoi(v)
		Config.MVMax = n
	}, strconv.Itoa(Config.MVMax))

	// GetM3u8 Mode
	m3u8Options := []string{"hires", "all"}
	tuiSelectField("Get M3U8 Mode", m3u8Options, func(v string) {
		Config.GetM3u8Mode = v
	}, Config.GetM3u8Mode)

	saveConfig()
}

func tuiEditConversion() {
	tuiBoolField("Convert After Download", &Config.ConvertAfterDownload)

	fmtOptions := []string{"flac", "mp3", "opus", "wav", "copy"}
	tuiSelectField("Convert Format", fmtOptions, func(v string) {
		Config.ConvertFormat = v
	}, Config.ConvertFormat)

	tuiBoolField("Keep Original After Conversion", &Config.ConvertKeepOriginal)
	tuiBoolField("Skip If Source Matches Format", &Config.ConvertSkipIfSourceMatch)
	tuiBoolField("Warn Lossy to Lossless", &Config.ConvertWarnLossyToLossless)
	tuiBoolField("Skip Lossy to Lossless", &Config.ConvertSkipLossyToLossless)
	tuiBoolField("Check Bad ALAC", &Config.ConvertCheckBadALAC)
	tuiBoolField("Delete Bad ALAC", &Config.ConvertDeleteBadALAC)
	tuiBoolField("ALAC Fix", &Config.ALACFix)
	tuiInputField("FFmpeg Path", &Config.FFmpegPath)
	tuiInputField("Extra FFmpeg Args", &Config.ConvertExtraArgs)

	saveConfig()
}

func tuiEditTagging() {
	tuiBoolField("Tag Sort Order", &Config.TagSortOrder)
	tuiBoolField("Tag iTunes ID", &Config.TagItunesID)
	tuiInputField("Explicit Tag", &Config.ExplicitChoice)
	tuiInputField("Clean Tag", &Config.CleanChoice)
	tuiInputField("Apple Master Tag", &Config.AppleMasterChoice)
	tuiInputField("Album Folder Format", &Config.AlbumFolderFormat)
	tuiInputField("Playlist Folder Format", &Config.PlaylistFolderFormat)
	tuiInputField("Artist Folder Format", &Config.ArtistFolderFormat)
	tuiInputField("Song File Format", &Config.SongFileFormat)
	tuiBoolField("Use Song Info For Playlist", &Config.UseSongInfoForPlaylist)

	saveConfig()
}

func tuiEditLyrics() {
	lrcTypeOptions := []string{"lyrics", "syllable-lyrics"}
	tuiSelectField("Lyrics Type", lrcTypeOptions, func(v string) {
		Config.LrcType = v
	}, Config.LrcType)

	lrcFmtOptions := []string{"lrc", "ttml"}
	tuiSelectField("Lyrics Format", lrcFmtOptions, func(v string) {
		Config.LrcFormat = v
	}, Config.LrcFormat)

	tuiBoolField("Embed Lyrics", &Config.EmbedLrc)
	tuiBoolField("Save Lyrics File", &Config.SaveLrcFile)

	saveConfig()
}

func tuiEditArtwork() {
	tuiBoolField("Embed Cover", &Config.EmbedCover)
	tuiBoolField("Save Artist Cover", &Config.SaveArtistCover)
	tuiBoolField("Save Animated Artwork", &Config.SaveAnimatedArtwork)
	tuiBoolField("Emby Animated Artwork", &Config.EmbyAnimatedArtwork)

	coverSizeOptions := []string{"5000x5000", "3000x3000", "1000x1000", "500x500"}
	tuiSelectField("Cover Size", coverSizeOptions, func(v string) {
		Config.CoverSize = v
	}, Config.CoverSize)

	coverFmtOptions := []string{"original", "jpg", "png"}
	tuiSelectField("Cover Format", coverFmtOptions, func(v string) {
		Config.CoverFormat = v
	}, Config.CoverFormat)

	tuiBoolField("Download Album Cover For Playlist", &Config.DlAlbumcoverForPlaylist)

	saveConfig()
}

func tuiEditStorefront() {
	tuiInputField("Storefront (e.g. us, in, jp)", &Config.Storefront)
	tuiInputField("Language (e.g. en-GB)", &Config.Language)

	saveConfig()
}

func tuiEditAdvanced() {
	tuiInputField("Decrypt M3U8 Port", &Config.DecryptM3u8Port)
	tuiInputField("Get M3U8 Port", &Config.GetM3u8Port)
	tuiBoolField("Get M3U8 From Device", &Config.GetM3u8FromDevice)

	limitStr := strconv.Itoa(Config.LimitMax)
	tuiInputField("Limit Max", &limitStr)
	Config.LimitMax, _ = strconv.Atoi(limitStr)

	memStr := strconv.Itoa(Config.MaxMemoryLimit)
	tuiInputField("Max Memory Limit (MB)", &memStr)
	Config.MaxMemoryLimit, _ = strconv.Atoi(memStr)

	saveConfig()
}

// ── Helper Widgets ───────────────────────────────────────────────────────────

func tuiAskActionAndQuality(atmosAvailable bool) {
	action := ""
	survey.AskOne(&survey.Select{
		Message: "Action:",
		Options: []string{"Download", "Stream", "← Back"},
	}, &action)
	if action == "← Back" || action == "" {
		return
	}
	play_stream = action == "Stream"

	qualityOpts := []string{"Lossless (ALAC)", "High-Quality (AAC)"}
	if atmosAvailable {
		qualityOpts = append(qualityOpts, "Dolby Atmos")
	}
	qualityOpts = append(qualityOpts, "← Back")
	quality := ""
	survey.AskOne(&survey.Select{
		Message:  "Quality:",
		Options:  qualityOpts,
		PageSize: 5,
	}, &quality)
	switch quality {
	case "High-Quality (AAC)":
		setDlFlags("aac")
	case "Dolby Atmos":
		setDlFlags("atmos")
	case "← Back", "":
		return
	default:
		setDlFlags("alac")
	}
}

func tuiInputField(label string, val *string) {
	result := *val
	err := survey.AskOne(&survey.Input{
		Message: label + ":",
		Default: *val,
	}, &result)
	if err == nil {
		*val = result
	}
}

func tuiBoolField(label string, val *bool) {
	result := *val
	err := survey.AskOne(&survey.Confirm{
		Message: label + ":",
		Default: *val,
	}, &result)
	if err == nil {
		*val = result
	}
}

func tuiSelectField(label string, options []string, setter func(string), current string) {
	// Mark current value
	marked := make([]string, len(options))
	for i, o := range options {
		if o == current {
			marked[i] = o + " ✓"
		} else {
			marked[i] = o
		}
	}
	result := ""
	err := survey.AskOne(&survey.Select{
		Message:  label + ":",
		Options:  marked,
		PageSize: 8,
	}, &result)
	if err == nil {
		// Strip the ✓ marker if present
		setter(strings.TrimSuffix(strings.TrimSpace(result), " ✓"))
	}
}

// ── Save Config to config.yaml ───────────────────────────────────────────────

func saveConfig() {
	data, err := yaml.Marshal(&Config)
	if err != nil {
		fmt.Println("Error serializing config:", err)
		return
	}
	if err := os.WriteFile("config.yaml", data, 0644); err != nil {
		fmt.Println("Error saving config:", err)
		return
	}
	fmt.Println("✓ Config saved.")
}

func tuiNowPlaying(trackName string, session *PlayerSession) {
	for {
		action := ""
		survey.AskOne(&survey.Select{
			Message: fmt.Sprintf("▶️  Now Playing: %s", trackName),
			Options: []string{
				"⏸  Pause/Resume  (Space)",
				"⏭  Next          (n)",
				"⏮  Previous      (p)",
				"⏹  Stop          (q)",
				"🔍  Search another",
				"← Back",
			},
			PageSize: 7,
		}, &action)

		switch action {
		case "⏸  Pause/Resume  (Space)":
			session.TogglePause()
		case "⏭  Next          (n)":
			session.Next()
		case "⏮  Previous      (p)":
			session.Previous()
		case "⏹  Stop          (q)", "← Back":
			session.Stop()
			return
		case "🔍  Search another":
			session.Stop()
			return
		case "":
			// Ctrl+C or error
			session.Stop()
			return
		}
	}
}