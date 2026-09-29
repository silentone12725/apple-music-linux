package config

type ConfigSet struct {
	Storefront           string `yaml:"storefront"`
	MediaUserToken       string `yaml:"media-user-token"`
	AuthorizationToken   string `yaml:"authorization-token"`
	Language             string `yaml:"language"`
	SaveLrcFile          bool   `yaml:"save-lrc-file"`
	LrcType              string `yaml:"lrc-type"`
	LrcFormat            string `yaml:"lrc-format"`
	SaveAnimatedArtwork  bool   `yaml:"save-animated-artwork"`
	EmbyAnimatedArtwork  bool   `yaml:"emby-animated-artwork"`
	EmbedLrc             bool   `yaml:"embed-lrc"`
	EmbedCover           bool   `yaml:"embed-cover"`
	SaveArtistCover      bool   `yaml:"save-artist-cover"`
	CoverSize            string `yaml:"cover-size"`
	CoverFormat          string `yaml:"cover-format"`
	TagSortOrder         bool   `yaml:"tag-sort-order"`
	TagItunesID          bool   `yaml:"tag-itunes-id"`
	AlacSaveFolder       string `yaml:"alac-save-folder"`
	AtmosSaveFolder      string `yaml:"atmos-save-folder"`
	AacSaveFolder        string `yaml:"aac-save-folder"`
	MVSaveFolder         string `yaml:"mv-save-folder"`
	AlacStreamFolder     string `yaml:"alac-stream-folder"`
	AtmosStreamFolder    string `yaml:"atmos-stream-folder"`
	AacStreamFolder      string `yaml:"aac-stream-folder"`
	AlbumFolderFormat    string `yaml:"album-folder-format"`
	PlaylistFolderFormat string `yaml:"playlist-folder-format"`
	ArtistFolderFormat   string `yaml:"artist-folder-format"`
	SongFileFormat       string `yaml:"song-file-format"`
	ExplicitChoice       string `yaml:"explicit-choice"`
	CleanChoice          string `yaml:"clean-choice"`
	AppleMasterChoice    string `yaml:"apple-master-choice"`
	MaxMemoryLimit       int    `yaml:"max-memory-limit"`
	// DRM binary (engine/drm package)
	DRMBinaryPath string `yaml:"drm-binary-path"` // path to drm-rootless binary
	DRMBaseDir    string `yaml:"drm-base-dir"`    // mpl_db parent directory
	GetM3u8Mode   string `yaml:"get-m3u8-mode"`
	GetM3u8FromDevice          bool          `yaml:"get-m3u8-from-device"`
	AacType                    string        `yaml:"aac-type"`
	AlacMax                    int           `yaml:"alac-max"`
	AtmosMax                   int           `yaml:"atmos-max"`
	LimitMax                   int           `yaml:"limit-max"`
	UseSongInfoForPlaylist     bool          `yaml:"use-songinfo-for-playlist"`
	DlAlbumcoverForPlaylist    bool          `yaml:"dl-albumcover-for-playlist"`
	MVAudioType                string        `yaml:"mv-audio-type"`
	MVMax                      int           `yaml:"mv-max"`
	ConvertAfterDownload       bool          `yaml:"convert-after-download"`
	ConvertFormat              string        `yaml:"convert-format"`
	ConvertKeepOriginal        bool          `yaml:"convert-keep-original"`
	ConvertSkipIfSourceMatch   bool          `yaml:"convert-skip-if-source-matches"`
	FFmpegPath                 string        `yaml:"ffmpeg-path"`
	ConvertExtraArgs           string        `yaml:"convert-extra-args"`
	ConvertWithMetadata        bool          `yaml:"convert-with-metadata"`
	ConvertWarnLossyToLossless bool          `yaml:"convert-warn-lossy-to-lossless"`
	ConvertSkipLossyToLossless bool          `yaml:"convert-skip-lossy-to-lossless"`
	ConvertCheckBadALAC        bool          `yaml:"convert-check-bad-alac"`
	ConvertDeleteBadALAC       bool          `yaml:"convert-delete-bad-alac"`
	ALACFix                    bool          `yaml:"alac-fix"`
	ExitOnError                bool          `yaml:"exit-on-error"`
	// ExportThrottleFloorKbps is the minimum export (download) rate in KiB/s
	// while playback is streaming. 0 = engine default (128 KiB/s).
	ExportThrottleFloorKbps int `yaml:"export-throttle-floor-kbps"`
	StreamCacheSize         int `yaml:"stream-cache-size"` // MB, 0 = unlimited
}

