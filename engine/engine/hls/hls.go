// Package hls parses HLS playlists into typed Go structs.
// It performs no segment downloading, no key acquisition, and no decryption.
// It is the only engine package that imports github.com/grafov/m3u8.
//
// The name reflects what this is: an HLS container parser.  If DASH or CMAF
// support is added later, they become engine/dash and engine/cmaf — peers, not
// sub-packages of this one.
package hls

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/grafov/m3u8"
)

// ─── Master playlist ──────────────────────────────────────────────────────────

// Variant is one quality level in an HLS master playlist.
type Variant struct {
	URL              string
	Bandwidth        uint32
	AverageBandwidth uint32
	Codecs           string
	Resolution       string
	VideoRange       string
}

// Alternative is one audio/subtitle rendition in an HLS master playlist.
type Alternative struct {
	GroupID string
	Name    string
	URI     string
}

// Master is a parsed HLS master playlist.
type Master struct {
	baseURL      *url.URL
	Variants     []Variant
	Alternatives []Alternative
}

// OpenMaster fetches and parses a master HLS playlist.
// Returns an error if the URL yields a media playlist instead.
func OpenMaster(ctx context.Context, rawURL string) (*Master, error) {
	body, err := fetch(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	return parseMaster(base, rawURL, body)
}

// SelectAudioVariant returns the URL of the best audio alternative.
// It first tries to match one of the given group ID priorities (first match
// wins), using the highest _grN_ rank within each group.  If no priority
// matches, it falls back to the first available audio alternative so that
// playlists with non-standard GROUP-ID names still work.
func (m *Master) SelectAudioVariant(priorities []string) (string, error) {
	re := regexp.MustCompile(`_gr(\d+)_`)
	type candidate struct {
		uri  string
		rank int
		prio int
	}
	var best candidate
	found := false
	var fallback string

	for _, alt := range m.Alternatives {
		if fallback == "" {
			fallback = alt.URI
		}
		for i, p := range priorities {
			if alt.GroupID != p {
				continue
			}
			matches := re.FindStringSubmatch(alt.URI)
			rank := 0
			if len(matches) == 2 {
				fmt.Sscanf(matches[1], "%d", &rank)
			}
			if !found || i < best.prio || (i == best.prio && rank > best.rank) {
				best = candidate{uri: alt.URI, rank: rank, prio: i}
				found = true
			}
		}
	}
	if found {
		return best.uri, nil
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", fmt.Errorf("no audio alternative matching priorities %v", priorities)
}

// SelectVideoVariant returns the highest-bandwidth video variant whose height
// (from resolution WxH) does not exceed maxHeight.
// Resolution is read from the RESOLUTION= m3u8 attribute first; the URL-path
// pattern _WxH_ is used as a fallback for older playlist formats.
func (m *Master) SelectVideoVariant(maxHeight int) (string, error) {
	re := regexp.MustCompile(`_?(\d+)x(\d+)`)
	sorted := make([]Variant, len(m.Variants))
	copy(sorted, m.Variants)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].AverageBandwidth > sorted[j].AverageBandwidth
	})

	heightOf := func(v Variant) int {
		// Prefer RESOLUTION= attribute (e.g. "1920x1080").
		if v.Resolution != "" {
			var w, h int
			if n, _ := fmt.Sscanf(v.Resolution, "%dx%d", &w, &h); n == 2 && h > 0 {
				return h
			}
		}
		// Fall back to _WxH_ pattern in URL path.
		u, err := url.Parse(v.URL)
		if err != nil {
			return 0
		}
		matches := re.FindStringSubmatch(u.Path)
		if len(matches) != 3 {
			return 0
		}
		var h int
		fmt.Sscanf(matches[2], "%d", &h)
		return h
	}

	anyParseable := false
	for _, v := range sorted {
		h := heightOf(v)
		if h > 0 {
			anyParseable = true
			if h <= maxHeight {
				return v.URL, nil
			}
		}
	}
	// If no variant has parseable resolution, return the highest-bandwidth one
	// so playlists without resolution metadata still work.
	if !anyParseable && len(sorted) > 0 {
		return sorted[0].URL, nil
	}
	return "", fmt.Errorf("no video variant at or below %dp", maxHeight)
}

// SelectByCodec returns the URL of the highest-bandwidth variant whose Codecs
// field contains the given string.  Falls back to highest bandwidth on no match.
func (m *Master) SelectByCodec(codec string) string {
	codec = strings.ToLower(codec)
	var best, fallback Variant
	for _, v := range m.Variants {
		if v.Bandwidth > fallback.Bandwidth {
			fallback = v
		}
		if codec != "" && strings.Contains(strings.ToLower(v.Codecs), codec) {
			if v.Bandwidth > best.Bandwidth {
				best = v
			}
		}
	}
	if best.URL != "" {
		return best.URL
	}
	return fallback.URL
}

// ─── Media playlist ───────────────────────────────────────────────────────────

// EncryptionInfo holds the HLS EXT-X-KEY attributes needed to acquire a
// decryption key.  The key material itself lives only in engine/fairplay.
type EncryptionInfo struct {
	// URIPrefix is the Apple license endpoint prefix (before the comma in the
	// EXT-X-KEY URI field).
	URIPrefix string

	// KIDBase64 is the base64-encoded key ID (after the comma).
	KIDBase64 string
}

// Media is a parsed HLS media playlist.
type Media struct {
	InitURL          string          // CMAF initialization segment (EXT-X-MAP URI)
	SegmentURLs      []string        // Media segments in presentation order
	SegmentDurations []float64       // Duration of each segment in seconds (parallel to SegmentURLs)
	Encryption       *EncryptionInfo // nil for unencrypted tracks
}

// AllURLs returns [InitURL, seg0, seg1, ...] — the ordered list of URLs that
// the pipeline must download and assemble to produce a complete fMP4 stream.
func (m *Media) AllURLs() []string {
	out := make([]string, 0, 1+len(m.SegmentURLs))
	if m.InitURL != "" {
		out = append(out, m.InitURL)
	}
	return append(out, m.SegmentURLs...)
}

// URLsFrom returns [InitURL, seg_N, seg_N+1, ...] where N is the first segment
// whose start time is closest to startSec without exceeding it.
// Also returns the actual start time of segment N (segment-granular precision).
// Falls back to AllURLs() if no duration information is available.
func (m *Media) URLsFrom(startSec float64) (urls []string, actualStart float64) {
	if len(m.SegmentDurations) == 0 || startSec <= 0 {
		log.Printf("[hls] URLsFrom startSec=%.3f → fallback AllURLs (nDurations=%d)", startSec, len(m.SegmentDurations))
		return m.AllURLs(), 0
	}
	var cumulative float64
	idx := 0
	for i, d := range m.SegmentDurations {
		if cumulative+d > startSec {
			idx = i
			break
		}
		cumulative += d
		idx = i + 1
	}
	if idx >= len(m.SegmentURLs) {
		idx = max(0, len(m.SegmentURLs)-1)
	}
	out := make([]string, 0, 1+(len(m.SegmentURLs)-idx))
	if m.InitURL != "" {
		out = append(out, m.InitURL)
	}
	out = append(out, m.SegmentURLs[idx:]...)
	log.Printf("[hls] URLsFrom startSec=%.3f nSegs=%d nDurations=%d → idx=%d actualStart=%.3f firstSegURL=%s",
		startSec, len(m.SegmentURLs), len(m.SegmentDurations), idx, cumulative,
		func() string {
			if len(out) > 1 {
				return out[1]
			}
			return "(none)"
		}())
	return out, cumulative
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// OpenMediaAuth is like OpenMedia but adds Apple Music auth headers.
// Use this for media playlists at play.itunes.apple.com that require authentication.
func OpenMediaAuth(ctx context.Context, rawURL, token, mut string) (*Media, error) {
	headers := map[string]string{
		"Authorization":            "Bearer " + token,
		"x-apple-music-user-token": mut,
		"Origin":                   "https://music.apple.com",
	}
	body, err := fetchWithHeaders(ctx, rawURL, headers)
	if err != nil {
		return nil, err
	}
	return parseMedia(rawURL, body)
}

// OpenMedia fetches and parses an HLS media playlist.
func OpenMedia(ctx context.Context, rawURL string) (*Media, error) {
	body, err := fetch(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	return parseMedia(rawURL, body)
}

func parseMedia(rawURL string, body []byte) (*Media, error) {
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}

	from, listType, err := m3u8.DecodeFrom(strings.NewReader(string(body)), true)
	if err != nil {
		return nil, fmt.Errorf("m3u8 decode: %w", err)
	}
	if listType != m3u8.MEDIA {
		return nil, fmt.Errorf("expected media playlist at %s", rawURL)
	}

	pl := from.(*m3u8.MediaPlaylist)
	med := &Media{}

	if pl.Map != nil && pl.Map.URI != "" {
		u, err := base.Parse(pl.Map.URI)
		if err == nil {
			med.InitURL = byteRangeURL(u.String(), pl.Map.Offset, pl.Map.Limit)
		}
	}

	if pl.Key != nil && pl.Key.URI != "" {
		parts := strings.SplitN(pl.Key.URI, ",", 2)
		if len(parts) == 2 {
			med.Encryption = &EncryptionInfo{
				URIPrefix: parts[0],
				KIDBase64: parts[1],
			}
		}
	}

	for _, seg := range pl.Segments {
		if seg == nil {
			continue
		}
		u, err := base.Parse(seg.URI)
		if err != nil {
			continue
		}
		med.SegmentURLs = append(med.SegmentURLs, byteRangeURL(u.String(), seg.Offset, seg.Limit))
		med.SegmentDurations = append(med.SegmentDurations, seg.Duration)
	}

	return med, nil
}

// byteRangeURL appends a "#bytes=<offset>-<end>" fragment to url when the
// segment declares an EXT-X-BYTERANGE (Limit > 0). DownloadSegments in
// utils/runv3 detects this fragment and issues a Range request instead of a
// full GET, so byte-range playlists (like Apple Music AAC) start at the
// correct position instead of always downloading from byte 0.
func byteRangeURL(rawURL string, offset, length int64) string {
	if length <= 0 {
		return rawURL
	}
	return fmt.Sprintf("%s#bytes=%d-%d", rawURL, offset, offset+length-1)
}

// ─── CBCS media playlist ──────────────────────────────────────────────────────

// CBCSMedia holds the information needed to decrypt a FairPlay CBCS stream.
// Unlike Media (which is for CTR content), CBCSMedia preserves the raw skd://
// key URI for each segment so the CBCS decryptor can send them to the wrapper's
// TCP socket verbatim.
type CBCSMedia struct {
	// FileURL is the URL of the single encrypted fMP4 file. All segments are
	// byte ranges of this file. Resolved from the first segment's URI.
	FileURL string

	// KeyURIs contains one entry per segment in playlist order.
	// Empty string means no key change at that position.
	KeyURIs []string

	// SegmentDurations holds the declared duration (seconds) of each segment,
	// in playlist order. Used by CBCSSeekableSource to compute seek offsets.
	SegmentDurations []float64
}

// OpenMediaCBCS fetches and parses a FairPlay CBCS media playlist.
// It strips any non-streamingkeydelivery EXT-X-KEY lines before parsing —
// Apple playlists sometimes carry multiple key formats that the m3u8 parser
// cannot handle with a single Key field.
//
// Returns an error if the playlist is not a byterange playlist, because the
// CBCS decryption path requires a single fMP4 file download.
func OpenMediaCBCS(ctx context.Context, rawURL string) (*CBCSMedia, error) {
	body, err := fetch(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}

	filtered := filterStreamingKeyDelivery(string(body))

	from, listType, err := m3u8.DecodeFrom(strings.NewReader(filtered), true)
	if err != nil {
		return nil, fmt.Errorf("m3u8 decode: %w", err)
	}
	if listType != m3u8.MEDIA {
		return nil, fmt.Errorf("expected media playlist at %s", rawURL)
	}

	pl := from.(*m3u8.MediaPlaylist)
	med := &CBCSMedia{}

	for _, seg := range pl.Segments {
		if seg == nil {
			continue
		}
		if med.FileURL == "" {
			if seg.Limit <= 0 {
				return nil, fmt.Errorf("cbcs: non-byterange playlist not supported at %s", rawURL)
			}
			u, err := base.Parse(seg.URI)
			if err != nil {
				return nil, fmt.Errorf("cbcs: resolve file URL: %w", err)
			}
			med.FileURL = u.String()
		}
		keyURI := ""
		if seg.Key != nil {
			keyURI = seg.Key.URI
		}
		med.KeyURIs = append(med.KeyURIs, keyURI)
		med.SegmentDurations = append(med.SegmentDurations, seg.Duration)
	}

	if med.FileURL == "" {
		return nil, fmt.Errorf("cbcs: no segments in playlist %s", rawURL)
	}
	return med, nil
}

// filterStreamingKeyDelivery strips EXT-X-KEY lines that do not use the
// FairPlay streamingkeydelivery key format.  Apple's enhanced-HLS playlists
// sometimes include PlayReady or Widevine key entries alongside the FairPlay
// one; the m3u8 parser cannot represent multiple concurrent keys, so we keep
// only the one the CBCS decryptor actually needs.
func filterStreamingKeyDelivery(body string) string {
	var sb strings.Builder
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "#EXT-X-KEY:") && !strings.Contains(line, "streamingkeydelivery") {
			continue
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return sb.String()
}

// fetch is a minimal HTTP GET used only for playlist files (text, small).
func fetch(ctx context.Context, rawURL string) ([]byte, error) {
	return fetchWithHeaders(ctx, rawURL, nil)
}

func fetchWithHeaders(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, rawURL)
	}
	return io.ReadAll(resp.Body)
}

// OpenMasterAuth is like OpenMaster but adds Apple Music auth headers.
// Use this for playlists at play.itunes.apple.com that require authentication.
func OpenMasterAuth(ctx context.Context, rawURL, token, mut string) (*Master, error) {
	headers := map[string]string{
		"Authorization":            "Bearer " + token,
		"x-apple-music-user-token": mut,
		"Origin":                   "https://music.apple.com",
	}
	body, err := fetchWithHeaders(ctx, rawURL, headers)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	return parseMaster(base, rawURL, body)
}

func parseMaster(base *url.URL, rawURL string, body []byte) (*Master, error) {
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(string(body)), true)
	if err != nil {
		return nil, fmt.Errorf("m3u8 decode: %w", err)
	}

	// If it's already a media playlist, wrap it as a single-variant master.
	if listType == m3u8.MEDIA {
		return &Master{
			baseURL: base,
			Variants: []Variant{{
				URL: rawURL,
			}},
		}, nil
	}

	pl := from.(*m3u8.MasterPlaylist)
	m := &Master{baseURL: base}

	for _, v := range pl.Variants {
		if v == nil {
			continue
		}
		varURL, err := base.Parse(v.URI)
		if err != nil {
			continue
		}
		m.Variants = append(m.Variants, Variant{
			URL:              varURL.String(),
			Bandwidth:        v.Bandwidth,
			AverageBandwidth: v.AverageBandwidth,
			Codecs:           v.Codecs,
			Resolution:       v.Resolution,
			VideoRange:       v.VideoRange,
		})
		for _, alt := range v.Alternatives {
			if alt == nil || alt.URI == "" {
				continue
			}
			altURL, err := base.Parse(alt.URI)
			if err != nil {
				continue
			}
			m.Alternatives = append(m.Alternatives, Alternative{
				GroupID: alt.GroupId,
				Name:    alt.Name,
				URI:     altURL.String(),
			})
		}
	}

	return m, nil
}
