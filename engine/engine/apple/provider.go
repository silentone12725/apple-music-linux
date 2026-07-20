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
	"net/http"
	"strings"
	"time"

	"main/engine/bench"
	"main/engine/fairplay"
	"main/engine/hls"
	"main/engine/media"
	"main/engine/pipeline"
	"main/utils/ampapi"
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
	return &appleMusicProvider{lp: fairplay.New()}
}

// NewProviderWithCBCS returns a media.Provider backed by Apple Music with
// CBCS/FairPlay decryption enabled for ALAC and Atmos tracks.
//
// dialer opens a FairPlay decryption connection for each stream attempt.
// In production, pass a *drm.DRMManager which implements fairplay.CBCSDialer.
// If dialer is nil, ALAC and Atmos requests will fail with an error.
func NewProviderWithCBCS(dialer fairplay.CBCSDialer) media.Provider {
	return &appleMusicProvider{lp: fairplay.New(), cbcsDialer: dialer}
}

type appleMusicProvider struct {
	lp         fairplay.LicenseProvider
	cbcsDialer fairplay.CBCSDialer // nil = CBCS disabled
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
	tr := bench.FromContext(ctx)
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
			Kind:       pipeline.KindAudio,
			Codec:      codec,
			SampleRate: sr,
			BitDepth:   bd,
			Open:       trackOpen,
		}},
	}, nil
}

// ── Music video ───────────────────────────────────────────────────────────────

func (p *appleMusicProvider) openMV(ctx context.Context, req media.OpenRequest) (*media.Session, error) {
	if req.MVMaxHeight == 0 {
		req.MVMaxHeight = 2160
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

	videoURL, err := master.SelectVideoVariant(req.MVMaxHeight)
	if err != nil {
		return nil, fmt.Errorf("select video variant: %w", err)
	}
	audioURL, err := master.SelectAudioVariant(req.MVAudioPriorities)
	if err != nil {
		return nil, fmt.Errorf("select audio variant: %w", err)
	}

	lp := p.lp
	assetID, mut := req.AssetID, req.MUT
	// token is already resolved above (developer JWT, no "Bearer" prefix)

	return &media.Session{
		Kind: "mv",
		Metadata: media.Metadata{
			Title:      a.Name,
			ArtistName: a.ArtistName,
			AlbumName:  a.AlbumName,
			DurationMs: a.DurationInMillis,
			ArtworkURL: fmtArtwork(a.Artwork.URL, 500),
		},
		Tracks: []media.Track{
			{
				Kind:  pipeline.KindVideo,
				Codec: pipeline.CodecH264,
				Open:  makeAuthTrackOpener(lp, assetID, token, mut, videoURL, pipeline.KindVideo, pipeline.CodecH264),
			},
			{
				Kind:  pipeline.KindAudio,
				Codec: pipeline.CodecAAC,
				Open:  makeAuthSeekableTrackOpener(lp, assetID, token, mut, audioURL, pipeline.KindAudio, pipeline.CodecAAC),
			},
		},
	}, nil
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
		var med *hls.Media
		var err error
		if auth {
			med, err = hls.OpenMediaAuth(ctx, playlistURL, token, mut)
		} else {
			med, err = hls.OpenMedia(ctx, playlistURL)
		}
		if err != nil {
			return nil, fmt.Errorf("open media playlist: %w", err)
		}
		var dec pipeline.Decryptor
		if med.Encryption == nil {
			dec = fairplay.PassthroughDecryptor()
		} else {
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
		return &pipeline.Stream{
			Source: fairplay.HLSSeekableSource(med),
			Stages: []pipeline.Stage{pipeline.DecryptStage(dec)},
			Kind:   kind,
			Codec:  codec,
		}, nil
	}
}

// makeTrackOpener returns the Track.Open func for a single encrypted HLS track.
// On call it parses the media playlist, acquires a licence, and returns a
// pipeline.Stream ready to run.  All Apple Music and FairPlay specifics are
// captured in the closure; nothing leaks to the caller.
func makeTrackOpener(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
) func(context.Context) (*pipeline.Stream, error) {
	return makeTrackOpenerWithAuth(lp, assetID, token, mut, playlistURL, kind, codec, false)
}

// makeAuthTrackOpener is like makeTrackOpener but fetches the media playlist
// with Apple Music auth headers.  Use for MV tracks whose playlists live at
// play.itunes.apple.com and require Bearer + x-apple-music-user-token.
func makeAuthTrackOpener(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
) func(context.Context) (*pipeline.Stream, error) {
	return makeTrackOpenerWithAuth(lp, assetID, token, mut, playlistURL, kind, codec, true)
}

func makeTrackOpenerWithAuth(
	lp fairplay.LicenseProvider,
	assetID, token, mut string,
	playlistURL string,
	kind pipeline.StreamKind,
	codec pipeline.Codec,
	auth bool,
) func(context.Context) (*pipeline.Stream, error) {
	return func(ctx context.Context) (*pipeline.Stream, error) {
		var med *hls.Media
		var err error
		if auth {
			med, err = hls.OpenMediaAuth(ctx, playlistURL, token, mut)
		} else {
			med, err = hls.OpenMedia(ctx, playlistURL)
		}
		if err != nil {
			return nil, fmt.Errorf("open media playlist: %w", err)
		}

		var dec pipeline.Decryptor
		if med.Encryption == nil {
			dec = fairplay.PassthroughDecryptor()
		} else {
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
		return &pipeline.Stream{
			Source: fairplay.HLSSource(med.AllURLs()),
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
	bench.FromContext(ctx).RecordWebplaybackStart()
	defer bench.FromContext(ctx).RecordWebplaybackEnd()
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
	return io.ReadAll(resp.Body)
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
	s := fmt.Sprintf("%d", size)
	return strings.ReplaceAll(strings.ReplaceAll(template, "{w}", s), "{h}", s)
}
