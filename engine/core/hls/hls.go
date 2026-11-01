// Package hls parses HLS playlists into typed Go structs.
// It performs no segment downloading, no key acquisition, and no decryption.
// Playlist decoding goes through internal/m3u8safe (the library can panic).
//
// The name reflects what this is: an HLS container parser.  If DASH or CMAF
// support is added later, they become engine/dash and engine/cmaf — peers, not
// sub-packages of this one.
package hls

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/grafov/m3u8"

	"engine/internal/m3u8safe"
	"engine/internal/vlog"
)

var (
	grRankRe = regexp.MustCompile(`_gr(\d+)_`)
	dimRe    = regexp.MustCompile(`_?(\d+)x(\d+)`)
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
	// HDCPLevel is the HDCP-LEVEL attribute ("TYPE-0", "TYPE-1", "NONE"): the output protection the variant
	// requires before it may be played. Empty when the playlist does not say.
	HDCPLevel string
	// AllowedCPC is the ALLOWED-CPC attribute: the key systems, and the security level of each, that may be used to
	// play this variant (for example FairPlay, PlayReady SL3000, Widevine hardware). Empty when the playlist does not
	// say. A key system missing from it is one the server will not grant this variant's key to.
	AllowedCPC string
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
	re := grRankRe
	type candidate struct {
		uri  string
		rank int
		prio int
	}
	var best candidate
	found := false
	var fallback string

	prioRank := make(map[string]int, len(priorities))
	for i, p := range priorities {
		prioRank[p] = i
	}
	for _, alt := range m.Alternatives {
		if fallback == "" {
			fallback = alt.URI
		}
		i, ok := prioRank[alt.GroupID]
		if !ok {
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
	if found {
		return best.uri, nil
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", fmt.Errorf("no audio alternative matching priorities %v", priorities)
}

// SelectVideoVariantWithCodec is like SelectVideoVariant but also returns the
// CODECS= attribute string from the chosen variant.
func (m *Master) SelectVideoVariantWithCodec(maxHeight int) (variantURL, codecs, resolution string, err error) {
	sorted := make([]Variant, len(m.Variants))
	copy(sorted, m.Variants)
	// AVERAGE-BANDWIDTH is optional; without it every variant would tie at 0 and
	// the (unstable) sort could pick any of them, so fall back to BANDWIDTH.
	rate := func(v Variant) uint32 {
		if v.AverageBandwidth > 0 {
			return v.AverageBandwidth
		}
		return v.Bandwidth
	}
	sort.SliceStable(sorted, func(i, j int) bool { return rate(sorted[i]) > rate(sorted[j]) })
	heightOf := func(v Variant) int { return v.Height() }
	isH264 := func(v Variant) bool {
		return strings.Contains(strings.ToLower(v.Codecs), "avc1")
	}
	isHEVC := func(v Variant) bool {
		lc := strings.ToLower(v.Codecs)
		return strings.Contains(lc, "hvc1") || strings.Contains(lc, "hev1")
	}
	// Find the highest H.264 height available. When the caller requests above that
	// ceiling, Apple's HEVC-only variants (e.g. 4K at 3840×1920) are the only option.
	maxH264Height := 0
	for _, v := range sorted {
		if isH264(v) {
			if h := heightOf(v); h > maxH264Height {
				maxH264Height = h
			}
		}
	}
	if maxHeight > maxH264Height && maxH264Height > 0 {
		// Above the H.264 ceiling — prefer HEVC at or below maxHeight.
		for _, v := range sorted {
			if !isHEVC(v) {
				continue
			}
			h := heightOf(v)
			if h > maxH264Height && h <= maxHeight {
				return v.URL, v.Codecs, v.Resolution, nil
			}
		}
	}
	// Prefer H.264 (avc1) — HEVC hardware decode is not universal on Linux.
	// Two-pass: H.264 first, HEVC fallback.
	for _, preferH264 := range []bool{true, false} {
		anyParseable := false
		for _, v := range sorted {
			if preferH264 && !isH264(v) {
				continue
			}
			h := heightOf(v)
			if h > 0 {
				anyParseable = true
				if h <= maxHeight {
					return v.URL, v.Codecs, v.Resolution, nil
				}
			}
		}
		if !preferH264 && !anyParseable && len(sorted) > 0 {
			return sorted[0].URL, sorted[0].Codecs, sorted[0].Resolution, nil
		}
	}
	return "", "", "", fmt.Errorf("no video variant at or below %dp", maxHeight)
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

// Height is the variant's pixel height from RESOLUTION, or from the dimensions in its URL; 0 when neither says.
func (v Variant) Height() int {
	if v.Resolution != "" {
		var w, h int
		if n, _ := fmt.Sscanf(v.Resolution, "%dx%d", &w, &h); n == 2 && h > 0 {
			return h
		}
	}
	u, err := url.Parse(v.URL)
	if err != nil {
		return 0
	}
	matches := dimRe.FindStringSubmatch(u.Path)
	if len(matches) != 3 {
		return 0
	}
	var h int
	fmt.Sscanf(matches[2], "%d", &h)
	return h
}

func (v Variant) isH264() bool { return strings.Contains(strings.ToLower(v.Codecs), "avc1") }

// VideoFallback returns the variant to try after the licence for failed was refused: the tallest variant below it,
// H.264 preferred because every Linux and Windows build can decode it. ok is false when nothing lower exists.
func (m *Master) VideoFallback(failed Variant) (Variant, bool) {
	limit := failed.Height()
	if limit <= 0 {
		return Variant{}, false
	}
	var best Variant
	found := false
	better := func(c, b Variant) bool {
		if c.isH264() != b.isH264() {
			return c.isH264()
		}
		if c.Height() != b.Height() {
			return c.Height() > b.Height()
		}
		return c.Bandwidth > b.Bandwidth
	}
	for _, v := range m.Variants {
		if h := v.Height(); h <= 0 || h >= limit {
			continue
		}
		if !found || better(v, best) {
			best, found = v, true
		}
	}
	return best, found
}

var allowedCPCRe = regexp.MustCompile(`ALLOWED-CPC="([^"]*)"`)

// allowedCPCByURI maps each variant URI in a master playlist to its ALLOWED-CPC attribute. The m3u8 library does not
// expose that attribute, so the EXT-X-STREAM-INF lines are read directly.
func allowedCPCByURI(master string) map[string]string {
	out := map[string]string{}
	pending := ""
	for _, raw := range strings.Split(master, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "#EXT-X-STREAM-INF:"):
			pending = ""
			if m := allowedCPCRe.FindStringSubmatch(line); m != nil {
				pending = m[1]
			}
		case line == "" || strings.HasPrefix(line, "#"):
		default:
			if pending != "" {
				out[line] = pending
			}
			pending = ""
		}
	}
	return out
}

// CPCSummary shortens an ALLOWED-CPC value for a log line: the key systems by name with their levels, for example
// "fairplay:Main/AppleMain playready:SL3000".
func CPCSummary(cpc string) string {
	if cpc == "" {
		return "unspecified"
	}
	names := strings.NewReplacer(
		"com.apple.streamingkeydelivery", "fairplay",
		"com.microsoft.playready", "playready",
		"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", "widevine",
	)
	return strings.ReplaceAll(names.Replace(cpc), ",", " ")
}

// VariantFor returns the variant with the given URL (as returned by SelectVideoVariantWithCodec).
func (m *Master) VariantFor(variantURL string) (Variant, bool) {
	for _, v := range m.Variants {
		if v.URL == variantURL {
			return v, true
		}
	}
	return Variant{}, false
}

// VideoHeights returns the unique, sorted set of video heights the quality menu
// may offer — i.e. those SelectVideoVariantWithCodec will actually deliver.
//
// H.264 heights are always included. HEVC-only heights above the highest H.264
// height are also included: SelectVideoVariantWithCodec switches to HEVC when
// maxHeight exceeds the H.264 ceiling, so those entries are genuinely selectable.
// HEVC heights at or below the H.264 ceiling are excluded — the selector would
// return a lower-resolution H.264 stream there and the menu would lie.
// Variants with no CODECS attribute are counted: they cannot be ruled out.
func (m *Master) VideoHeights() []int {
	re := dimRe
	heightOf := func(v Variant) int {
		h := 0
		if v.Resolution != "" {
			if parts := strings.SplitN(v.Resolution, "x", 2); len(parts) == 2 {
				if n, err := fmt.Sscanf(parts[1], "%d", &h); n != 1 || err != nil {
					h = 0
				}
			}
		}
		if h == 0 {
			if m2 := re.FindStringSubmatch(v.URL); len(m2) == 3 {
				fmt.Sscanf(m2[2], "%d", &h)
			}
		}
		return h
	}
	// First pass: collect all H.264 heights and find the ceiling.
	h264Heights := make(map[int]struct{})
	maxH264 := 0
	for _, v := range m.Variants {
		lc := strings.ToLower(v.Codecs)
		if v.Codecs != "" && !strings.Contains(lc, "avc1") {
			continue
		}
		if h := heightOf(v); h > 0 {
			h264Heights[h] = struct{}{}
			if h > maxH264 {
				maxH264 = h
			}
		}
	}
	// Second pass: collect HEVC heights strictly above the H.264 ceiling.
	hevcAbove := make(map[int]struct{})
	for _, v := range m.Variants {
		lc := strings.ToLower(v.Codecs)
		if !strings.Contains(lc, "hvc1") && !strings.Contains(lc, "hev1") {
			continue
		}
		if h := heightOf(v); h > maxH264 {
			hevcAbove[h] = struct{}{}
		}
	}
	seen := make(map[int]struct{})
	for h := range h264Heights {
		seen[h] = struct{}{}
	}
	for h := range hevcAbove {
		seen[h] = struct{}{}
	}
	out := make([]int, 0, len(seen))
	for h := range seen {
		out = append(out, h)
	}
	sort.Ints(out)
	return out
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

	// Method and KeyFormat are the EXT-X-KEY attributes, kept for diagnostics: they show which key system the
	// playlist declares. KeyCount is the number of distinct key URIs the playlist uses (more than one means the key
	// changes between segments, which a single licence request does not cover).
	Method    string
	KeyFormat string
	KeyCount  int
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
		// Target at/after the last segment: start from the last one, and keep
		// cumulative equal to that segment's start (the step-back below relies on it).
		idx = max(0, len(m.SegmentURLs)-1)
		cumulative = 0
		for _, d := range m.SegmentDurations[:min(idx, len(m.SegmentDurations))] {
			cumulative += d
		}
	}
	// Step back one segment so the TFDT offset (segment boundary vs. HLS timestamp
	// discrepancy) does not push the first decoded frame past seekSec. One segment
	// of overlap also gives the decoder keyframe context before the target point.
	if idx > 0 {
		idx--
		cumulative -= m.SegmentDurations[idx]
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

// URLsFromExact is like URLsFrom but does not step back one segment.
// Use this for sources (e.g. vseg) where FFmpeg resets timestamps from zero at
// the HLS segment boundary, so no TFDT-overlap context is needed.
func (m *Media) URLsFromExact(startSec float64) (urls []string, actualStart float64) {
	if len(m.SegmentDurations) == 0 || startSec <= 0 {
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
		cumulative = 0
		for _, d := range m.SegmentDurations[:idx] {
			cumulative += d
		}
	}
	out := make([]string, 0, 1+(len(m.SegmentURLs)-idx))
	if m.InitURL != "" {
		out = append(out, m.InitURL)
	}
	out = append(out, m.SegmentURLs[idx:]...)
	log.Printf("[hls] URLsFromExact startSec=%.3f nSegs=%d → idx=%d actualStart=%.3f",
		startSec, len(m.SegmentURLs), idx, cumulative)
	return out, cumulative
}

// SegmentFor returns the index and playlist start time of the segment holding
// startSec, using the same rule as URLsFromExact. ok is false when the playlist
// carries no durations.
func (m *Media) SegmentFor(startSec float64) (idx int, segStart float64, ok bool) {
	if len(m.SegmentDurations) == 0 || len(m.SegmentURLs) == 0 {
		return 0, 0, false
	}
	if startSec < 0 {
		startSec = 0
	}
	var cumulative float64
	for i, d := range m.SegmentDurations {
		if cumulative+d > startSec {
			idx = i
			break
		}
		cumulative += d
		idx = i + 1
	}
	if idx >= len(m.SegmentURLs) {
		idx = len(m.SegmentURLs) - 1
		cumulative = 0
		for _, d := range m.SegmentDurations[:idx] {
			cumulative += d
		}
	}
	return idx, cumulative, true
}

// CumulativeSegmentTimes returns the presentation start time of each segment.
// Entry i is the cumulative sum of durations[0..i-1], so entry 0 is always 0.
func (m *Media) CumulativeSegmentTimes() []float64 {
	out := make([]float64, len(m.SegmentDurations))
	var cum float64
	for i, d := range m.SegmentDurations {
		out[i] = cum
		cum += d
	}
	return out
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

	from, listType, err := m3u8safe.DecodeFrom(bytes.NewReader(body), true)
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
				Method:    pl.Key.Method,
				KeyFormat: pl.Key.Keyformat,
				KeyCount:  distinctKeyURIs(pl),
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

		// If this segment has a different EXT-X-MAP than the playlist-level map, it
		// means the playlist switched init segments mid-stream (clear-leader CBCS
		// pattern: first segments use a clear mp4a init, later encrypted segments use
		// an enca init). We want the LAST unique init URL so that DecryptInit can
		// extract the CBCS sinf and decrypt the encrypted segments. The playlist-level
		// pl.Map is always the FIRST map (grafov/m3u8 behaviour), so scan per-segment
		// maps to find the encrypted one.
		if seg.Map != nil && seg.Map.URI != "" {
			mu, err := base.Parse(seg.Map.URI)
			if err == nil {
				candidate := byteRangeURL(mu.String(), seg.Map.Offset, seg.Map.Limit)
				if candidate != med.InitURL {
					med.InitURL = candidate
				}
			}
		}
	}

	logMediaParsed(rawURL, med, pl)
	return med, nil
}

// distinctKeyURIs counts the different EXT-X-KEY URIs a media playlist uses, at playlist level and on its segments.
func distinctKeyURIs(pl *m3u8.MediaPlaylist) int {
	seen := map[string]struct{}{}
	if pl.Key != nil && pl.Key.URI != "" {
		seen[pl.Key.URI] = struct{}{}
	}
	for _, seg := range pl.Segments {
		if seg != nil && seg.Key != nil && seg.Key.URI != "" {
			seen[seg.Key.URI] = struct{}{}
		}
	}
	return len(seen)
}

func logMediaParsed(rawURL string, med *Media, pl *m3u8.MediaPlaylist) {
	var totalDur float64
	for _, d := range med.SegmentDurations {
		totalDur += d
	}
	firstSeg := "(none)"
	if len(med.SegmentURLs) > 0 {
		firstSeg = med.SegmentURLs[0]
	}
	lastSeg := "(none)"
	if len(med.SegmentURLs) > 1 {
		lastSeg = med.SegmentURLs[len(med.SegmentURLs)-1]
	}
	encInfo := "nil"
	if med.Encryption != nil {
		encInfo = med.Encryption.URIPrefix + ",<kid>"
	}
	keyMethod := ""
	if pl.Key != nil {
		keyMethod = pl.Key.Method
	}
	vlog.Printf("[hls] parseMedia url=%s nSegs=%d totalDur=%.2fs enc=%s method=%q initURL=%q first=%q last=%q",
		rawURL, len(med.SegmentURLs), totalDur, encInfo, keyMethod,
		med.InitURL, firstSeg, lastSeg)
}

// byteRangeURL appends a "#bytes=<offset>-<end>" fragment to url when the
// segment declares an EXT-X-BYTERANGE (Limit > 0). The segment downloader in
// utils/aacstream detects this fragment and issues a Range request instead of a
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

	// KIDBase64 is the base64-encoded key ID extracted from the playlist's
	// EXT-X-KEY line. This is the real KID used for license acquisition.
	KIDBase64 string

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

	from, listType, err := m3u8safe.DecodeFrom(strings.NewReader(filtered), true)
	if err != nil {
		return nil, fmt.Errorf("m3u8 decode: %w", err)
	}
	if listType != m3u8.MEDIA {
		return nil, fmt.Errorf("expected media playlist at %s", rawURL)
	}

	pl := from.(*m3u8.MediaPlaylist)
	med := &CBCSMedia{}

	// Extract KID from playlist-level EXT-X-KEY if present
	if pl.Key != nil && pl.Key.URI != "" {
		parts := strings.SplitN(pl.Key.URI, ",", 2)
		if len(parts) == 2 {
			med.KIDBase64 = parts[1]
			log.Printf("[hls] OpenMediaCBCS: extracted KID from playlist: %s", med.KIDBase64)
		}
	}

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

// playlistClient fetches master/media playlists. These are small text files on
// the critical path of every session open, so they must fail fast rather than
// hang: http.DefaultClient has no timeout at all, and a stalled Apple CDN
// connection would block the open indefinitely — long enough that the caller's
// own deadline never even gets a chance to classify it as a timeout.
//
// Apple's Android client is far more aggressive here (CONNECT_TIMEOUT 4 s,
// READ_TIMEOUT 2 s, then retry). 15 s is a conservative equivalent that still
// bounds the hang, matching the pattern already used for artwork in apiserver.go.
var playlistClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        20,
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConnsPerHost: 10,
		TLSHandshakeTimeout: 10 * time.Second,
	},
}

func fetchWithHeaders(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := playlistClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, rawURL)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB cap for HLS playlist
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
	from, listType, err := m3u8safe.DecodeFrom(bytes.NewReader(body), true)
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
	cpc := allowedCPCByURI(string(body))

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
			HDCPLevel:        v.HDCPLevel,
			AllowedCPC:       cpc[v.URI],
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
