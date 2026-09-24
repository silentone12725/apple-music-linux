// Package apple implements media.Provider for Apple Music.
//
// AppleMusicProvider is the only type in the engine that knows about:
//   - The Apple Music catalog API (ampapi)
//   - The Apple webplayback API
//   - HLS master playlist variant selection for Apple-specific content
//
// It does NOT know about DRM beyond asking a LicenseProvider for a Decryptor,
// and the rest of the engine does not know this package exists — only the
// playback.Manager constructor wires it in.
package apple

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"engine/core/fairplay"
	"engine/core/hls"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/tracer"
	"engine/utils/ampapi"
	"engine/utils/mvlabel"
)

// webplaybackClient is used for all Apple webplayback API calls.
// A 30s timeout guards against a hung Apple server blocking engine.Open
// indefinitely.  Requests also carry the caller's context, so explicit
// cancellation still works before the 30s deadline.
var webplaybackClient = &http.Client{Timeout: 30 * time.Second}


// AssetFlavor identifies the DRM family and bitrate of a webplayback asset.
// The naming convention is "<id>:<enc><bitrate>" where enc is:
//   - ctrp = CTR/Widevine (data:;base64 key format — wrapper server compatible)
//   - cbcp = CBCS/FairPlay (skd:// key format — requires runv2 TCP socket)
//   - ibhp = ?
type AssetFlavor string

const (
	// CTR/Widevine flavors — EXT-X-KEY URI="data:;base64,[kid]"
	// These work with the wrapper server via AcquireKey/Widevine CDM.
	FlavorCTR256 AssetFlavor = "28:ctrp256" // 256 kbps AAC-LC
	FlavorCTR64  AssetFlavor = "32:ctrp64"  // 64 kbps AAC-LC

	// CBCS/FairPlay flavors — EXT-X-KEY URI="skd://itunes.apple.com/…"
	// These require the runv2 TCP socket path (Config.DecryptM3u8Port).
	FlavorCBCS256 AssetFlavor = "30:cbcp256" // 256 kbps AAC-LC
	FlavorCBCS64  AssetFlavor = "34:cbcp64"  // 64 kbps AAC-LC
)

// NewProvider returns a media.Provider backed by Apple Music.
// ALAC and Atmos tracks require a CBCS decryption socket; use NewProviderWithCBCS
// to enable them.
func NewProvider() media.Provider {
	return &appleMusicProvider{lp: fairplay.New(), acct: nil}
}

// AccountTokenSource supplies iTunes-style auth tokens and native API calls
// from the Android DRM backend. It is satisfied by *drm.DRMManager via a
// thin adapter in apiserver.go.
type AccountTokenSource interface {
	// GetMusicToken returns (devToken, musicToken) from the Android DRM session.
	// Called once per subDownload attempt; errors fall back to web MusicKit tokens.
	GetMusicToken(ctx context.Context) (devToken, musicToken string, err error)

	// GetProgressiveMVURL fetches a progressive video URL and associated
	// downloadKey (base64 FairPlay token; empty if not available) for the given
	// adamID through the wrapper's native Android StoreKit auth (port 40020).
	GetProgressiveMVURL(ctx context.Context, adamID uint64) (url string, downloadKey string, err error)
}

// NewProviderWithCBCS returns a media.Provider backed by Apple Music with
// CBCS/FairPlay decryption enabled for ALAC and Atmos tracks.
//
// dialer opens a FairPlay decryption connection for each stream attempt.
// In production, pass a *drm.DRMManager which implements fairplay.CBCSDialer.
// If dialer is nil, ALAC and Atmos requests will fail with an error.
//
// acct is optional; when non-nil, subDownload requests use iTunes-style tokens
// from the DRM backend instead of web MusicKit tokens — fixing auth on
// play.music.apple.com/subDownload.
func NewProviderWithCBCS(dialer fairplay.CBCSDialer, acct AccountTokenSource) media.Provider {
	return &appleMusicProvider{lp: fairplay.New(), cbcsDialer: dialer, acct: acct}
}

type appleMusicProvider struct {
	lp         fairplay.LicenseProvider
	cbcsDialer fairplay.CBCSDialer  // nil = CBCS disabled
	acct       AccountTokenSource   // nil = use web MusicKit tokens for subDownload
}

func (p *appleMusicProvider) Open(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	if req.Video {
		return p.openMV(ctx, req)
	}
	return p.openSong(ctx, req)
}

// ── Song ──────────────────────────────────────────────────────────────────────

func (p *appleMusicProvider) openSong(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	token := strings.TrimPrefix(req.Token, "Bearer ")
	if token == "" {
		var err error
		token, err = ampapi.GetToken()
		if err != nil {
			return nil, fmt.Errorf("auto-fetch developer token: %w", err)
		}
	}
	tr := tracer.FromContext(ctx)
	tr.RecordCatalogFetchStart()
	song, err := ampapi.GetSongRespContext(ctx, req.Storefront, req.AssetID, req.Language, token)
	tr.RecordCatalogFetchEnd()
	if err != nil || len(song.Data) == 0 {
		return nil, fmt.Errorf("song %s not found in %s: %w", req.AssetID, req.Storefront, err)
	}
	a := song.Data[0].Attributes

	if a.ExtendedAssetUrls.EnhancedHls == "" {
		return nil, fmt.Errorf("no HLS URL for track %s", req.AssetID)
	}

	traits := traitSet(a.AudioTraits)
	var codec pipeline.Codec
	var hlsFilter string
	var sr, bd int

	switch {
	case req.Atmos && traits["atmos"]:
		codec, hlsFilter = pipeline.CodecAtmos, "ec-3"
	case req.Lossless && traits["hi-res-lossless"]:
		codec, hlsFilter = pipeline.CodecALAC, "alac"
		sr, bd = extractALACQuality(a.AudioTraits)
	case req.Lossless && traits["lossless"]:
		codec, hlsFilter = pipeline.CodecALAC, "alac"
		sr, bd = 44100, 16
	default:
		codec, hlsFilter = pipeline.CodecAAC, "mp4a.40.2"
	}

	var playlistURL string
	if codec == pipeline.CodecAAC {
		// Standard AAC content (256 kbps) is CTR-encrypted in the webplayback
		// API's "28:ctrp256" asset.  Those media playlists carry
		// URI="data:;base64,[kid]" in EXT-X-KEY — the format the HLS parser and
		// Widevine license provider both understand.
		// The catalog enhanced-HLS variants use URI="skd://…" (FairPlay CBCS),
		// which requires a different key path not yet wired into the engine.
		playlistURL, err = p.webplaybackAssetURL(ctx, req.AssetID, token, req.MUT, FlavorCTR256)
		if err != nil {
			return nil, fmt.Errorf("webplayback AAC asset: %w", err)
		}
	} else {
		master, err := hls.OpenMaster(ctx, a.ExtendedAssetUrls.EnhancedHls)
		if err != nil {
			return nil, fmt.Errorf("open master playlist: %w", err)
		}
		playlistURL = master.SelectByCodec(hlsFilter)
		if playlistURL == "" {
			return nil, fmt.Errorf("no HLS variant matching codec %q", hlsFilter)
		}
	}

	lp := p.lp
	assetID, mut := req.AssetID, req.MUT

	// Choose the track opener based on the DRM family.
	// AAC uses the CTR/Widevine path (webplayback 28:ctrp256 asset).
	// ALAC and Atmos use the CBCS/FairPlay path (catalog enhanced-HLS + TCP socket).
	var trackOpen func(context.Context) (*pipeline.Stream, error)
	if codec == pipeline.CodecAAC {
		trackOpen = makeSeekableTrackOpener(lp, assetID, token, mut, playlistURL, pipeline.KindAudio, codec)
	} else {
		if p.cbcsDialer == nil {
			return nil, fmt.Errorf("ALAC/Atmos requires CBCS decryption (no CBCSDialer configured)")
		}
		trackOpen = p.makeCBCSTrackOpener(assetID, playlistURL, pipeline.KindAudio, codec, a.DurationInMillis)
	}

	br, ch, mimeType := audioFormatFields(codec, sr)
	return &media.Session{
		Kind: "song",
		Metadata: media.Metadata{
			Title:      a.Name,
			ArtistName: a.ArtistName,
			AlbumName:  a.AlbumName,
			DurationMs: a.DurationInMillis,
			ArtworkURL: fmtArtwork(a.Artwork.URL, 500),
			HasLyrics:  a.HasLyrics,
		},
		Tracks: []media.Track{{
			Kind:          pipeline.KindAudio,
			Codec:         codec,
			SampleRate:    sr,
			BitDepth:      bd,
			BitRate:       br,
			ChannelCount:  ch,
			CodecMIMEType: mimeType,
			Open:          trackOpen,
		}},
	}, nil
}

// audioFormatFields returns (bitRate bps, channelCount, codecMIMEType) for the
// given codec.  Values are Apple Music defaults; they are informational only and
// never used in the decryption path.
func audioFormatFields(codec pipeline.Codec, sampleRate int) (bitRate, channelCount int, mimeType string) {
	switch codec {
	case pipeline.CodecAAC:
		return 256_000, 2, `audio/mp4; codecs="mp4a.40.2"`
	case pipeline.CodecALAC:
		// Lossless bitrate is track-dependent; report 0 (unknown).
		return 0, 2, `audio/mp4; codecs="alac"`
	case pipeline.CodecAtmos:
		// Dolby Atmos EC-3 7.1+objects; base bed is 7.1 (8 channels).
		return 768_000, 8, `audio/mp4; codecs="ec-3"`
	default:
		return 0, 0, ""
	}
}

// ── Music video ───────────────────────────────────────────────────────────────

func (p *appleMusicProvider) openMV(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	if req.MVMaxHeight == 0 {
		req.MVMaxHeight = 1080 // default: 1080p H.264 (safe for Linux/Electron)
	}
	if len(req.MVAudioPriorities) == 0 {
		req.MVAudioPriorities = []string{"audio-atmos", "audio-ac3", "audio-stereo-256"}
	}

	// Resolve developer token once; all downstream API calls share the same value.
	token := strings.TrimPrefix(req.Token, "Bearer ")
	if token == "" {
		var err error
		token, err = ampapi.GetToken()
		if err != nil {
			return nil, fmt.Errorf("auto-fetch developer token: %w", err)
		}
	}

	mv, err := ampapi.GetMusicVideoRespContext(ctx, req.Storefront, req.AssetID, req.Language, token)
	if err != nil {
		return nil, fmt.Errorf("MV catalog lookup %s/%s: %w", req.Storefront, req.AssetID, err)
	}
	if len(mv.Data) == 0 {
		return nil, fmt.Errorf("MV %s not found in %s", req.AssetID, req.Storefront)
	}
	a := mv.Data[0].Attributes

	masterURL, err := p.webplaybackURL(ctx, req.AssetID, token, req.MUT)
	if err != nil {
		return nil, fmt.Errorf("webplayback API: %w", err)
	}

	master, err := hls.OpenMasterAuth(ctx, masterURL, token, req.MUT)
	if err != nil {
		return nil, fmt.Errorf("open MV master playlist: %w", err)
	}

	log.Printf("[mv] assetID=%s masterURL=%s nVariants=%d h264Heights=%v",
		req.AssetID, masterURL, len(master.Variants), master.VideoHeights())

	audioURL, err := master.SelectAudioVariant(req.MVAudioPriorities)
	if err != nil {
		return nil, fmt.Errorf("select audio variant: %w", err)
	}

	lp := p.lp
	assetID, mut := req.AssetID, req.MUT

	// Always use the HLS CBCS segment pipeline for video. The progressive CDN
	// files (mvod.itunes.apple.com) carry iTunes FairPlay DRM (drmi/drms,
	// Scheme Type: itun) which Chrome on Linux cannot decrypt and FFmpeg
	// cannot process. Only the HLS path goes through proper CBCS decryption.
	videoURL, videoCodecs, videoResolution, selErr := master.SelectVideoVariantWithCodec(req.MVMaxHeight)
	if selErr != nil {
		return nil, fmt.Errorf("select video variant: %w", selErr)
	}
	mvlabel.Set(videoResolution)
	videoTrack := media.Track{
		Kind:        pipeline.KindVideo,
		Codec:       pipeline.CodecH264,
		CodecString: videoCodecs,
		Open:        makeAuthSeekableTrackOpener(lp, assetID, token, mut, videoURL, pipeline.KindVideo, pipeline.CodecH264),
	}

	sess := &media.Session{
		Kind: "mv",
		Metadata: media.Metadata{
			Title:      a.Name,
			ArtistName: a.ArtistName,
			AlbumName:  a.AlbumName,
			DurationMs: a.DurationInMillis,
			ArtworkURL: fmtArtwork(a.Artwork.URL, 500),
		},
		VideoHeights: master.VideoHeights(),
		Tracks: []media.Track{
			videoTrack,
			{
				Kind:  pipeline.KindAudio,
				Codec: pipeline.CodecAAC,
				Open:  makeAuthSeekableTrackOpener(lp, assetID, token, mut, audioURL, pipeline.KindAudio, pipeline.CodecAAC),
			},
		},
	}

	// Try to obtain the progressive CDN URL and downloadKey from the native
	// wrapper (port 40020). The downloadKey is sent as an HTTP cookie to the
	// CDN (Android pattern) — the CDN authorises server-side decryption.
	// Non-fatal: HLS CBCS path is always the primary; this is an optimisation.
	if p.acct != nil {
		if adamID, parseErr := strconv.ParseUint(req.AssetID, 10, 64); parseErr == nil {
			if pURL, pKey, pErr := p.acct.GetProgressiveMVURL(ctx, adamID); pErr == nil && pURL != "" {
				sess.MVProgressiveURL = pURL
				sess.MVDownloadKey = pKey
				log.Printf("[mv] progressive URL obtained for adamID=%s keyLen=%d", req.AssetID, len(pKey))
			} else if pErr != nil {
				log.Printf("[mv] GetProgressiveMVURL adamID=%s: %v (non-fatal)", req.AssetID, pErr)
			}
		}
	}

	log.Printf("[mv] openMV %s: returning sess with %d tracks mvProgressiveURL=%v", req.AssetID, len(sess.Tracks), sess.MVProgressiveURL != "")
	return sess, nil
}

// makeSeekableTrackOpener is like makeTrackOpener but uses HLSSeekableSource so
// that the caller can stream from an arbitrary time offset via SeekableSource.
// Only used for AAC (CTR path); ALAC/Atmos use the CBCS path which doesn't
// expose segment timing.
func makeSeekableTrackOpener(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
) func(context.Context) (*pipeline.Stream, error) {
	return makeSeekableTrackOpenerWithAuth(lp, assetID, token, mut, playlistURL, kind, codec, false)
}

// makeAuthSeekableTrackOpener is like makeSeekableTrackOpener but fetches the
// media playlist with Apple Music auth headers.  Use for MV audio tracks.
func makeAuthSeekableTrackOpener(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
) func(context.Context) (*pipeline.Stream, error) {
	return makeSeekableTrackOpenerWithAuth(lp, assetID, token, mut, playlistURL, kind, codec, true)
}

func makeSeekableTrackOpenerWithAuth(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
	auth bool,
) func(context.Context) (*pipeline.Stream, error) {
	return func(ctx context.Context) (*pipeline.Stream, error) {
		log.Printf("[apple] %s: opening media playlist url=%s auth=%v", kind, playlistURL, auth)
		var med *hls.Media
		var err error
		if auth {
			med, err = hls.OpenMediaAuth(ctx, playlistURL, token, mut)
		} else {
			med, err = hls.OpenMedia(ctx, playlistURL)
		}
		if err != nil {
			log.Printf("[apple] %s: open media playlist FAILED: %v", kind, err)
			return nil, fmt.Errorf("open media playlist: %w", err)
		}
		log.Printf("[apple] %s: media playlist OK nSegs=%d enc=%v", kind, len(med.SegmentURLs), med.Encryption != nil)
		var dec pipeline.Decryptor
		if med.Encryption == nil {
			log.Printf("[apple] %s %s: enc=nil → passthrough (no content-level encryption detected)", kind, playlistURL)
			dec = fairplay.PassthroughDecryptor()
		} else {
			log.Printf("[apple] %s %s: enc detected prefix=%q → acquiring licence", kind, playlistURL, med.Encryption.URIPrefix)
			dec, err = lp.Open(ctx, fairplay.LicenseRequest{
				AssetID:        assetID,
				KIDBase64:      med.Encryption.KIDBase64,
				URIPrefix:      med.Encryption.URIPrefix,
				Token:          token,
				MediaUserToken: mut,
			})
			if err != nil {
				return nil, fmt.Errorf("acquire licence: %w", err)
			}
		}
		var src pipeline.SeekableSource
		if kind == pipeline.KindVideo {
			src = fairplay.HLSMVVideoSource(med) // uses separate MV cache
		} else {
			src = fairplay.HLSSeekableSource(med)
		}
		return &pipeline.Stream{
			Source: src,
			Stages: []pipeline.Stage{pipeline.DecryptStage(dec)},
			Kind:   kind,
			Codec:  codec,
		}, nil
	}
}

// makeCBCSTrackOpener returns the Track.Open func for a FairPlay CBCS track
// (ALAC or Atmos).  On call it parses the media playlist, builds a CBCSSource
// that dials the wrapper's TCP socket, and returns a pipeline.Stream with no
// additional stages — all decryption happens inside the Source.
func (p *appleMusicProvider) makeCBCSTrackOpener(
	assetID string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
	durationMs int,
) func(context.Context) (*pipeline.Stream, error) {
	dialer := p.cbcsDialer
	return func(ctx context.Context) (*pipeline.Stream, error) {
		cbcsMedia, err := hls.OpenMediaCBCS(ctx, playlistURL)
		if err != nil {
			return nil, fmt.Errorf("open CBCS media playlist: %w", err)
		}
		return &pipeline.Stream{
			Source: fairplay.CBCSSeekableSource(assetID, dialer, cbcsMedia, durationMs),
			Kind:   kind,
			Codec:  codec,
		}, nil
	}
}

// ── webplayback API ───────────────────────────────────────────────────────────

// fetchWebplayback posts to Apple's webplayback endpoint and returns the raw
// response body.  Both webplaybackURL (MV master) and webplaybackAssetURL
// (song CTR asset) call this to avoid duplicating the HTTP logic.
func (p *appleMusicProvider) fetchWebplayback(ctx context.Context, adamID, token, mut string) ([]byte, error) {
	tracer.FromContext(ctx).RecordWebplaybackStart()
	defer tracer.FromContext(ctx).RecordWebplaybackEnd()
	body, _ := json.Marshal(map[string]string{"salableAdamId": adamID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("x-apple-music-user-token", mut)
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
	resp, err := webplaybackClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB cap for API JSON
}

// webplaybackURL returns the HLS master playlist URL for a music video.
func (p *appleMusicProvider) webplaybackURL(ctx context.Context, adamID, token, mut string) (string, error) {
	raw, err := p.fetchWebplayback(ctx, adamID, token, mut)
	if err != nil {
		return "", err
	}
	var obj struct {
		SongList []struct {
			HlsPlaylistUrl string `json:"hls-playlist-url"`
		} `json:"songList"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", fmt.Errorf("parse webplayback response: %w", err)
	}
	if len(obj.SongList) == 0 || obj.SongList[0].HlsPlaylistUrl == "" {
		return "", fmt.Errorf("webplayback response contained no HLS playlist")
	}
	return obj.SongList[0].HlsPlaylistUrl, nil
}

// webplaybackAssetURL returns the media playlist URL for the given DRM flavor
// from Apple's webplayback assets list.  For standard AAC songs, use flavor
// "28:ctrp256" — its media playlist carries URI="data:;base64,[kid]" in
// EXT-X-KEY, which the HLS parser and Widevine license provider both handle.
func (p *appleMusicProvider) webplaybackAssetURL(ctx context.Context, adamID, token, mut string, flavor AssetFlavor) (string, error) {
	raw, err := p.fetchWebplayback(ctx, adamID, token, mut)
	if err != nil {
		return "", err
	}
	var obj struct {
		SongList []struct {
			Assets []struct {
				Flavor string `json:"flavor"`
				URL    string `json:"URL"`
			} `json:"assets"`
		} `json:"songList"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", fmt.Errorf("parse webplayback response: %w", err)
	}
	if len(obj.SongList) == 0 {
		return "", fmt.Errorf("webplayback response contained no song list")
	}
	for _, asset := range obj.SongList[0].Assets {
		if AssetFlavor(asset.Flavor) == flavor {
			return asset.URL, nil
		}
	}
	return "", fmt.Errorf("webplayback response has no asset with flavor %q", flavor)
}

// ── subDownload API (Android lease endpoint) ──────────────────────────────────


// ── Helpers ───────────────────────────────────────────────────────────────────

func traitSet(traits []string) map[string]bool {
	m := make(map[string]bool, len(traits))
	for _, t := range traits {
		m[t] = true
	}
	return m
}

func extractALACQuality(traits []string) (sampleRate, bitDepth int) {
	for _, t := range traits {
		parts := strings.Split(t, "-")
		if len(parts) >= 2 {
			fmt.Sscanf(parts[len(parts)-2], "%d", &sampleRate)
			fmt.Sscanf(parts[len(parts)-1], "%d", &bitDepth)
			if sampleRate > 0 && bitDepth > 0 {
				return
			}
		}
	}
	return 96000, 24
}

func fmtArtwork(template string, size int) string {
	s := strconv.Itoa(size)
	return strings.ReplaceAll(strings.ReplaceAll(template, "{w}", s), "{h}", s)
}

// ── Progressive MV asset selection ───────────────────────────────────────────

// mvProgressiveAsset is one entry from the webplayback asset list for an MV.
type mvProgressiveAsset struct {
	URL         string
	FileSize    int64
	DownloadKey string // FairPlay CDN auth token; empty if not available
}

// selectBestProgressiveAsset picks the best CDN URL from a list of progressive
// MV assets. Prefers mvod.itunes.apple.com; among equals takes the largest
// FileSize. Falls back to the largest of any URL when no mvod entry exists.
// Appends ?accessKey=<DownloadKey> when DownloadKey is set and the URL does not
// already contain an accessKey parameter.
// Returns ("", false) for an empty slice.
func selectBestProgressiveAsset(assets []mvProgressiveAsset) (string, bool) {
	if len(assets) == 0 {
		return "", false
	}
	var best *mvProgressiveAsset
	for i := range assets {
		a := &assets[i]
		if best == nil {
			best = a
			continue
		}
		bestMvod := strings.Contains(best.URL, "mvod.itunes.apple.com")
		aMvod := strings.Contains(a.URL, "mvod.itunes.apple.com")
		switch {
		case aMvod && !bestMvod:
			best = a
		case bestMvod && !aMvod:
			// keep best
		default:
			if a.FileSize > best.FileSize {
				best = a
			}
		}
	}
	u := best.URL
	if best.DownloadKey != "" && !strings.Contains(u, "accessKey=") {
		if strings.Contains(u, "?") {
			u += "&accessKey=" + best.DownloadKey
		} else {
			u += "?accessKey=" + best.DownloadKey
		}
	}
	return u, true
}

// progressiveVideoSource is a pipeline.Source that streams a progressive MP4
// directly from a CDN URL. Seeking is not supported (SourceFrom returns self
// at t=0); the growing-file layer above handles in-range seeks.
type progressiveVideoSource struct {
	url string
}

func (s *progressiveVideoSource) Stream(ctx context.Context, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("progressive CDN returned HTTP %d", resp.StatusCode)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func (s *progressiveVideoSource) SourceFrom(_ float64) (pipeline.Source, float64) {
	return s, 0
}
