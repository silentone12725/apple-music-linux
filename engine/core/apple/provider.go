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
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"engine/core/fairplay"
	"engine/core/hls"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/tracer"
	"engine/internal/vlog"
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
//   - cbcp = CBCS/FairPlay (skd:// key format — decrypted via CBCSDialer)
//   - ibhp = ?
type AssetFlavor string

const (
	// CTR/Widevine flavors — EXT-X-KEY URI="data:;base64,[kid]"
	// These work with the wrapper server via AcquireKey/Widevine CDM.
	FlavorCTR256 AssetFlavor = "28:ctrp256" // 256 kbps AAC-LC
	FlavorCTR64  AssetFlavor = "32:ctrp64"  // 64 kbps AAC-LC

	// CBCS/FairPlay flavors — EXT-X-KEY URI="skd://itunes.apple.com/…"
	// Decryption is handled in-process via DRMManager.DialCBCS (AdamplayBackend).
	FlavorCBCS256 AssetFlavor = "30:cbcp256" // 256 kbps AAC-LC
	FlavorCBCS64  AssetFlavor = "34:cbcp64"  // 64 kbps AAC-LC
)

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

	// DecryptItunSamples decrypts itun-encrypted samples via the wrapper's
	// port 50020. Requires a prior GetProgressiveMVURL call for the same adamID
	// to initialize the decryptor.
	DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error)
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
	cbcsDialer fairplay.CBCSDialer // nil = CBCS disabled
	acct       AccountTokenSource  // nil = use web MusicKit tokens for subDownload
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
	case req.Lossless && req.HiRes && traits["hi-res-lossless"]:
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
	// ALAC and Atmos use the CBCS/FairPlay path (catalog enhanced-HLS + CBCSDialer).
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

	log.Printf("[mv] assetID=%s masterURL=%s nVariants=%d videoHeights=%v",
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
	requestedHeight := req.MVMaxHeight
	req.MVMaxHeight = capByRefusal(req.AssetID, req.MVMaxHeight)
	if req.MVMaxHeight != requestedHeight {
		log.Printf("[mv-quality] %s: requested %s, capped to %dp: the licence for a taller tier was refused earlier",
			req.AssetID, qualityName(requestedHeight), req.MVMaxHeight)
	}
	videoURL, videoCodecs, videoResolution, selErr := master.SelectVideoVariantWithCodec(req.MVMaxHeight)
	if selErr != nil {
		return nil, fmt.Errorf("select video variant: %w", selErr)
	}
	mvlabel.Set(videoResolution)
	if v, ok := master.VariantFor(videoURL); ok {
		log.Printf("[mv-quality] %s: requested %s (limit %dp), selected %s %s range=%s hdcp=%q allowed key systems: %s",
			req.AssetID, qualityName(requestedHeight), req.MVMaxHeight, videoResolution, videoCodecs, v.VideoRange,
			v.HDCPLevel, hls.CPCSummary(v.AllowedCPC))
		log.Printf("[mv-quality] %s: variants offered: %s", req.AssetID, describeVariants(master.Variants))
	}
	videoTrack := media.Track{
		Kind:        pipeline.KindVideo,
		Codec:       pipeline.CodecH264,
		CodecString: videoCodecs,
		Open: openVideoWithFallback(master, firstVideoVariant(master, videoURL, videoCodecs, videoResolution), assetID,
			requestedHeight, func(v hls.Variant) func(context.Context) (*pipeline.Stream, error) {
				return makeAuthSeekableTrackOpener(lp, assetID, token, mut, v.URL, pipeline.KindVideo, pipeline.CodecH264)
			}),
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
	// Opt-in (ADAM_MV_PROGRESSIVE=1): the request costs seconds on every open, and nothing
	// consumes the result unless the native <video> backend is in use.
	if p.acct != nil && os.Getenv("ADAM_MV_PROGRESSIVE") == "1" {
		if adamID, parseErr := strconv.ParseUint(req.AssetID, 10, 64); parseErr == nil {
			progCtx, progCancel := context.WithTimeout(ctx, 5*time.Second)
			pURL, pKey, pErr := p.acct.GetProgressiveMVURL(progCtx, adamID)
			progCancel()
			if pErr == nil && pURL != "" {
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
		vlog.Printf("[apple] %s: opening media playlist url=%s auth=%v", kind, playlistURL, auth)
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
		vlog.Printf("[apple] %s: media playlist OK nSegs=%d enc=%v", kind, len(med.SegmentURLs), med.Encryption != nil)
		var dec pipeline.Decryptor
		if med.Encryption == nil {
			log.Printf("[apple] %s %s: enc=nil → passthrough (no content-level encryption detected)", kind, playlistURL)
			dec = fairplay.PassthroughDecryptor()
		} else {
			vlog.Printf("[apple] %s %s: enc detected prefix=%q → acquiring licence", kind, playlistURL, med.Encryption.URIPrefix)
			dec, err = lp.Open(ctx, fairplay.LicenseRequest{
				AssetID:        assetID,
				KIDBase64:      med.Encryption.KIDBase64,
				URIPrefix:      med.Encryption.URIPrefix,
				Token:          token,
				MediaUserToken: mut,
			})
			if err != nil {
				log.Printf("[apple] %s %s: licence refused: method=%s keyformat=%q keys=%d uriPrefix=%q kidLen=%d: %v",
					kind, assetID, med.Encryption.Method, med.Encryption.KeyFormat, med.Encryption.KeyCount,
					med.Encryption.URIPrefix, len(med.Encryption.KIDBase64), err)
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
			Source:     src,
			Stages:     []pipeline.Stage{pipeline.DecryptStage(dec)},
			Kind:       kind,
			Codec:      codec,
			DurationMs: declaredDurationMs(med.SegmentDurations),
		}, nil
	}
}

// declaredDurationMs sums a media playlist's segment durations (seconds) into milliseconds; 0 when it declares none.
func declaredDurationMs(segments []float64) int {
	total := 0.0
	for _, d := range segments {
		if d > 0 {
			total += d
		}
	}
	return int(total*1000 + 0.5)
}

// firstVideoVariant is the variant the selection picked, with its details from the master when it lists it.
func firstVideoVariant(master *hls.Master, url, codecs, resolution string) hls.Variant {
	if v, ok := master.VariantFor(url); ok {
		return v
	}
	return hls.Variant{URL: url, Codecs: codecs, Resolution: resolution}
}

// openVideoWithFallback opens the video track on first and, when the licence server refuses its key (a tier this
// client may not play, such as 4K for a software Widevine identity), retries on the next lower variant until one opens
// or none is left. The variant that opened sets the stream's codec string and the quality label, and the refusal is
// remembered so a reopen of the same video does not repeat it.
func openVideoWithFallback(
	master *hls.Master,
	first hls.Variant,
	assetID string,
	requestedHeight int,
	opener func(hls.Variant) func(context.Context) (*pipeline.Stream, error),
) func(context.Context) (*pipeline.Stream, error) {
	return func(ctx context.Context) (*pipeline.Stream, error) {
		v := first
		for {
			st, err := opener(v)(ctx)
			if err == nil {
				st.CodecString = v.Codecs
				if v.URL != first.URL {
					mvlabel.Set(v.Resolution)
				}
				log.Print(qualityLine(assetID, requestedHeight, first, v))
				return st, nil
			}
			if !errors.Is(err, fairplay.ErrLicenceRefused) || ctx.Err() != nil {
				return nil, err
			}
			rememberRefusal(assetID, v.Height())
			next, ok := master.VideoFallback(v)
			if !ok {
				log.Printf("[mv-quality] %s: requested %s: NO PLAYABLE VARIANT, the licence was refused for every tier",
					assetID, qualityName(requestedHeight))
				return nil, err
			}
			log.Printf("[mv-quality] %s: licence refused for %s %s; trying %s %s",
				assetID, v.Resolution, v.Codecs, next.Resolution, next.Codecs)
			v = next
		}
	}
}

// describeVariants lists a master's video variants as height:codec:range:hdcp:[allowed key systems], tallest first, so a log shows which tiers
// exist and what each one declares (HDCP-LEVEL says whether a tier demands output protection).
func describeVariants(variants []hls.Variant) string {
	out := make([]string, 0, len(variants))
	seen := map[string]bool{}
	for _, v := range variants {
		if v.Height() == 0 {
			continue
		}
		codec, _, _ := strings.Cut(v.Codecs, ",")
		if i := strings.IndexByte(codec, '.'); i > 0 {
			codec = codec[:i]
		}
		d := fmt.Sprintf("%dp:%s:%s:%s:[%s]", v.Height(), codec, v.VideoRange, v.HDCPLevel, hls.CPCSummary(v.AllowedCPC))
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		var a, b int
		fmt.Sscanf(out[i], "%dp", &a)
		fmt.Sscanf(out[j], "%dp", &b)
		return a > b
	})
	return strings.Join(out, " ")
}

// qualityName names a requested maximum height the way the quality menu does: 2160 is 4K, the rest are NNNp.
func qualityName(height int) string {
	if height >= 2160 {
		return "4K (2160p)"
	}
	return fmt.Sprintf("%dp", height)
}

// qualityLine is the one line that says what quality a music video was asked for and what it plays at. selected is
// what the quality choice picked from the master; played is what actually opened, which differs after a fallback.
func qualityLine(assetID string, requestedHeight int, selected, played hls.Variant) string {
	line := fmt.Sprintf("[mv-quality] %s: requested %s -> PLAYING %s %s range=%s %.1f Mbps",
		assetID, qualityName(requestedHeight), played.Resolution, played.Codecs, played.VideoRange,
		float64(played.Bandwidth)/1e6)
	if played.URL != selected.URL {
		line += fmt.Sprintf(" (FELL BACK from %s %s: licence refused)", selected.Resolution, selected.Codecs)
	} else if requestedHeight > 0 && played.Height() > 0 && played.Height() < requestedHeight {
		line += " (the tallest this video offers within the request)"
	}
	return line
}

// refusals remembers, per video, the height whose licence was refused, so later opens start below it.
var refusals sync.Map // assetID -> refusal

type refusal struct {
	height int
	at     time.Time
}

const refusalTTL = time.Hour

func rememberRefusal(assetID string, height int) {
	if height <= 0 {
		return
	}
	if prev, ok := refusals.Load(assetID); ok {
		if r := prev.(refusal); time.Since(r.at) <= refusalTTL && r.height <= height {
			return // keep the lower ceiling
		}
	}
	refusals.Store(assetID, refusal{height: height, at: time.Now()})
}

// capByRefusal lowers a requested maximum height to just below one whose licence was refused for this video recently.
func capByRefusal(assetID string, maxHeight int) int {
	v, ok := refusals.Load(assetID)
	if !ok {
		return maxHeight
	}
	r := v.(refusal)
	if time.Since(r.at) > refusalTTL {
		refusals.Delete(assetID)
		return maxHeight
	}
	if maxHeight >= r.height {
		return r.height - 1
	}
	return maxHeight
}

// makeCBCSTrackOpener returns the Track.Open func for a FairPlay CBCS track
// (ALAC or Atmos).  On call it parses the media playlist, builds a CBCSSource
// that decrypts through the CBCSDialer (in-process DRM), and returns a
// pipeline.Stream with no additional stages — all decryption happens inside
// the Source.
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
		// Pre-warm the FairPlay key in the background so it is already in the
		// Android SQLite cache by the time the CBCS pipeline needs it.  This
		// overlaps the ~2 s hybris key fetch with the ~2 s CDN init-segment
		// download, cutting ALAC start latency roughly in half for first plays.
		if firstKey := fairplay.FirstAudioKeyURI(cbcsMedia.KeyURIs); firstKey != "" {
			go fairplay.WarmCBCSKey(context.Background(), dialer, assetID, firstKey)
		}
		// The file's own length wins over the catalog's: it is stored in the moov (the player reports it) and is
		// where the stream really ends.
		declared := declaredDurationMs(cbcsMedia.SegmentDurations)
		durationMs = media.ReconcileDurationMs(durationMs, declared)
		return &pipeline.Stream{
			Source:     fairplay.CBCSSeekableSource(assetID, dialer, cbcsMedia, durationMs),
			Kind:       kind,
			Codec:      codec,
			DurationMs: declared,
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
	// Without this, a 401 (expired token) or 5xx outage surfaced as "no song
	// list", hiding the cause from users and from the open circuit breaker.
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("webplayback: HTTP %d", resp.StatusCode)
	}
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
