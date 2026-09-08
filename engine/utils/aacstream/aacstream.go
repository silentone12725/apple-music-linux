package aacstream

import (
	"context"
	"encoding/base64"
	"fmt"
	"github.com/go-resty/resty/v2"
	"google.golang.org/protobuf/proto"
	"log"
	"log/slog"

	cdm "engine/utils/aacstream/cdm"
	wvkey "engine/utils/aacstream/wvkey"

	"bytes"
	"errors"
	"io"

	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grafov/m3u8"
)

type PlaybackLicense struct {
	ErrorCode  int    `json:"errorCode"`
	License    string `json:"license"`
	RenewAfter int    `json:"renew-after"`
	Status     int    `json:"status"`
}

func getPSSH(contentId string, kidBase64 string) (string, error) {
	kidBytes, err := base64.StdEncoding.DecodeString(kidBase64)
	if err != nil {
		return "", fmt.Errorf("failed to decode base64 KID: %v", err)
	}
	contentIdEncoded := base64.StdEncoding.EncodeToString([]byte(contentId))
	algo := cdm.WidevineCencHeader_AESCTR
	widevineCencHeader := &cdm.WidevineCencHeader{
		KeyId:     [][]byte{kidBytes},
		Algorithm: &algo,
		Provider:  new(string),
		ContentId: []byte(contentIdEncoded),
		Policy:    new(string),
	}
	widevineCenc, err := proto.Marshal(widevineCencHeader)
	if err != nil {
		return "", fmt.Errorf("failed to marshal WidevineCencHeader: %v", err)
	}
	//最前面添加32字节
	widevineCenc = append([]byte("0123456789abcdef0123456789abcdef"), widevineCenc...)
	pssh := base64.StdEncoding.EncodeToString(widevineCenc)
	return pssh, nil
}

func BeforeRequest(cl *resty.Client, ctx context.Context, url string, body []byte) (*resty.Response, error) {
	jsondata := map[string]interface{}{
		"challenge":      base64.StdEncoding.EncodeToString(body), // 'body' is passed in directly
		"key-system":     "com.widevine.alpha",
		"uri":            ctx.Value("uriPrefix").(string) + "," + ctx.Value("pssh").(string),
		"adamId":         ctx.Value("adamId").(string),
		"isLibrary":      false,
		"user-initiated": true,
	}

	resp, err := cl.R().
		SetContext(ctx).
		SetBody(jsondata).
		Post(url)

	if err != nil {
		slog.Error("BeforeRequest error", "err", err)
	}

	return resp, err
}

func AfterRequest(response *resty.Response) ([]byte, error) {
	var responseData PlaybackLicense

	err := json.Unmarshal(response.Body(), &responseData)
	if err != nil {
		return nil, fmt.Errorf("failed to parse response JSON: %v", err)
	}

	if responseData.ErrorCode != 0 || responseData.Status != 0 {
		return nil, fmt.Errorf("error in license response, code: %d, status: %d", responseData.ErrorCode, responseData.Status)
	}

	license, err := base64.StdEncoding.DecodeString(responseData.License)
	if err != nil {
		return nil, fmt.Errorf("failed to decode license: %v", err)
	}

	return license, nil
}

func GetWebplayback(adamId string, authtoken string, mutoken string, mvmode bool) (string, string, string, error) {
	url := "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback"
	postData := map[string]string{
		"salableAdamId": adamId,
	}
	jsonData, err := json.Marshal(postData)
	if err != nil {
		slog.Error("GetWebplayback: encode JSON", "err", err)
		return "", "", "", err
	}
	ctx30, cancel30 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel30()
	req, err := http.NewRequestWithContext(ctx30, "POST", url, bytes.NewBuffer([]byte(jsonData)))
	if err != nil {
		slog.Error("GetWebplayback: create request", "err", err)
		return "", "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	req.Header.Set("Referer", "https://music.apple.com/")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", authtoken))
	req.Header.Set("x-apple-music-user-token", mutoken)
	resp, err := webplaybackClient.Do(req)
	if err != nil {
		slog.Error("GetWebplayback: send request", "err", err)
		return "", "", "", err
	}
	defer resp.Body.Close()
	obj := new(Songlist)
	err = json.NewDecoder(resp.Body).Decode(&obj)
	if err != nil {
		slog.Error("GetWebplayback: decode JSON", "err", err)
		return "", "", "", err
	}
	if len(obj.List) > 0 {
		if mvmode {
			return obj.List[0].HlsPlaylistUrl, "", "", nil
		}
		// 遍历 Assets
		for i := range obj.List[0].Assets {
			if obj.List[0].Assets[i].Flavor == "28:ctrp256" {
				kidBase64, fileurl, uriPrefix, err := extractKidBase64(obj.List[0].Assets[i].URL, false)
				if err != nil {
					return "", "", "", err
				}
				return fileurl, kidBase64, uriPrefix, nil
			}
			continue
		}
	}
	return "", "", "", errors.New("Unavailable")
}

type Songlist struct {
	List []struct {
		Hlsurl         string `json:"hls-key-cert-url"`
		HlsPlaylistUrl string `json:"hls-playlist-url"`
		Assets         []struct {
			Flavor string `json:"flavor"`
			URL    string `json:"URL"`
		} `json:"assets"`
	} `json:"songList"`
	Status int `json:"status"`
}

func extractKidBase64(b string, mvmode bool) (string, string, string, error) {
	// webplaybackClient, not http.DefaultClient: this is a master playlist fetch
	// (exactly what that client documents itself as covering) and DefaultClient
	// has no timeout, so a stalled CDN would hang key extraction indefinitely.
	resp, err := webplaybackClient.Get(b)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", errors.New(resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", "", err
	}
	masterString := string(body)
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(masterString), true)
	if err != nil {
		return "", "", "", err
	}
	var kidbase64 string
	var uriPrefix string
	var urlBuilder strings.Builder
	if listType == m3u8.MEDIA {
		mediaPlaylist := from.(*m3u8.MediaPlaylist)
		if mediaPlaylist.Key != nil {
			split := strings.Split(mediaPlaylist.Key.URI, ",")
			uriPrefix = split[0]
			kidbase64 = split[1]
			lastSlashIndex := strings.LastIndex(b, "/")
			// 截取最后一个斜杠之前的部分
			urlBuilder.WriteString(b[:lastSlashIndex])
			urlBuilder.WriteString("/")
			urlBuilder.WriteString(mediaPlaylist.Map.URI)
			//fileurl = b[:lastSlashIndex] + "/" + mediaPlaylist.Map.URI
			if mvmode {
				for _, segment := range mediaPlaylist.Segments {
					if segment != nil {
						urlBuilder.WriteString(";")
						urlBuilder.WriteString(b[:lastSlashIndex])
						urlBuilder.WriteString("/")
						urlBuilder.WriteString(segment.URI)
						//fileurl = fileurl + ";" + b[:lastSlashIndex] + "/" + segment.URI
					}
				}
			}
		} else {
			slog.Warn("no key information found in m3u8")
		}
	} else {
		slog.Warn("not a media playlist")
	}
	return kidbase64, urlBuilder.String(), uriPrefix, nil
}

// retryBackoff sleeps the exponential backoff for attempt and returns whether
// the caller should continue (true) or abort (false, ctx done).
func retryBackoff(ctx context.Context, attempt int) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(time.Duration(1<<attempt) * 500 * time.Millisecond):
		return true
	}
}

// mvRetry returns true if a failed attempt should be retried (sleeps backoff).
func mvRetry(ctx context.Context, attempt, maxRetries int) bool {
	return attempt < maxRetries-1 && ctx.Err() == nil && retryBackoff(ctx, attempt)
}

// appleIPv4Dial forces IPv4 so Apple CDN AAAA records (unreachable on many
// Linux machines) don't cause "network is unreachable" failures.
func appleIPv4Dial(timeout, keepAlive time.Duration) func(context.Context, string, string) (net.Conn, error) {
	d := &net.Dialer{Timeout: timeout, KeepAlive: keepAlive}
	return func(ctx context.Context, _, addr string) (net.Conn, error) {
		return d.DialContext(ctx, "tcp4", addr)
	}
}

// webplaybackClient is used for Apple webplayback API calls and master playlist
// fetches — needs a timeout; http.DefaultClient has none.
var webplaybackClient = &http.Client{
	Transport: &http.Transport{
		DialContext:         appleIPv4Dial(15*time.Second, 30*time.Second),
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     60 * time.Second,
	},
	Timeout: 30 * time.Second,
}

var mvHTTPClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           appleIPv4Dial(10*time.Second, 30*time.Second),
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     true,
	},
	Timeout: 90 * time.Second,
}

// licenseTransport is shared across all AcquireKey calls so TCP+TLS connections
// to play.itunes.apple.com are reused — eliminating per-track handshake latency.
// Mirrors Android FootHillDecryptionKeyController which holds a persistent CDM
// session rather than opening a new one per track.
var licenseTransport = &http.Transport{
	DialContext:         (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext,
	MaxIdleConns:        10,
	IdleConnTimeout:     90 * time.Second,
	TLSHandshakeTimeout: 10 * time.Second,
	ForceAttemptHTTP2:   true,
}

// WarmLicensePool pre-establishes a TLS connection to Apple's FairPlay license
// server so the first AcquireKey call skips the handshake latency.
// Mirrors Android FootHillDecryptionKey.DEFAULT_PREFETCH_KEY_URI warm-up via
// FootHillDecryptionKeyController at BaseMediaPlayerContext.<init> time.
func WarmLicensePool(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cl := resty.New().SetTransport(licenseTransport)
	if resp, err := cl.R().SetContext(ctx).Get("https://play.itunes.apple.com/"); err == nil {
		log.Printf("[drm] license pool warmed status=%d", resp.StatusCode())
	}
}

// AcquireKey acquires the AES decryption key for one Apple Music track via the
// Widevine licence endpoint and returns the raw key bytes.  This is the only
// exported key-acquisition function; callers must not store the bytes in any
// field that is serialised or returned to API clients.
//
// kidBase64 and uriPrefix come from the EXT-X-KEY URI field in the HLS media
// playlist (split on the first comma: uriPrefix,kidBase64).
// adamID is the Apple Music asset identifier used in the licence request body.
func AcquireKey(ctx context.Context, adamID, kidBase64, uriPrefix, token, mutoken string) ([]byte, error) {
	ctx = context.WithValue(ctx, "pssh", kidBase64)
	ctx = context.WithValue(ctx, "adamId", adamID)
	ctx = context.WithValue(ctx, "uriPrefix", uriPrefix)

	pssh, err := getPSSH("", kidBase64)
	if err != nil {
		return nil, fmt.Errorf("pssh: %w", err)
	}

	headers := map[string]string{
		"authorization":            "Bearer " + token,
		"x-apple-music-user-token": mutoken,
	}
	cl := resty.New().SetTransport(licenseTransport)
	cl.SetHeaders(headers)
	k := wvkey.Key{
		ReqCli:        cl,
		BeforeRequest: BeforeRequest,
		AfterRequest:  AfterRequest,
	}
	k.CdmInit()

	_, keyBytes, err := k.GetKey(ctx,
		"https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense",
		pssh, nil)
	return keyBytes, err
}

// stableCacheKey strips rotating query parameters (Apple CDN accessKey rotates
// per webplayback session) while preserving the byte-range fragment.
// Mirrors Android MediaHlsAssetCache keying by (fileName, byteStart, byteEnd)
// not by full signed URL — so cache hits survive token rotation between replays.
func stableCacheKey(url string) string {
	frag := strings.Index(url, "#bytes=")
	if frag >= 0 {
		base := url[:frag]
		if q := strings.IndexByte(base, '?'); q >= 0 {
			base = base[:q]
		}
		return base + url[frag:]
	}
	if q := strings.IndexByte(url, '?'); q >= 0 {
		return url[:q]
	}
	return url
}

// fetchSegment downloads cacheKey (cache-hit → returns immediately) with up to
// 3 retries and exponential backoff. Handles "#bytes=<off>-<end>" range fragments.
func fetchSegment(ctx context.Context, cacheKey string) ([]byte, error) {
	// Use a stable key (no rotating query params) for cache lookup and storage.
	// The fetch URL retains the signed query params needed for CDN auth.
	stableKey := stableCacheKey(cacheKey)
	if cached, ok := GetCachedSegment(stableKey); ok {
		return cached, nil
	}
	fetchURL, rangeHdr := cacheKey, ""
	if idx := strings.Index(cacheKey, "#bytes="); idx >= 0 {
		fetchURL = cacheKey[:idx]
		rangeHdr = "bytes=" + cacheKey[idx+len("#bytes="):]
	}
	const maxRetries = 3
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
		if err != nil {
			return nil, err
		}
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			if attempt < maxRetries-1 && ctx.Err() == nil && retryBackoff(ctx, attempt) {
				continue
			}
			return nil, fmt.Errorf("fetch: %w", err)
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			if attempt < maxRetries-1 && ctx.Err() == nil && retryBackoff(ctx, attempt) {
				continue
			}
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			if attempt < maxRetries-1 && ctx.Err() == nil && retryBackoff(ctx, attempt) {
				continue
			}
			return nil, fmt.Errorf("read body: %w", err)
		}
		PutCachedSegment(stableKey, data)
		return data, nil
	}
	return nil, fmt.Errorf("all retries exhausted")
}

// streamMVSegmentDirect fetches url and pipes bytes to w as they arrive — no
// whole-segment buffering. If MV cache is enabled the segment is also tee'd
// into the cache (bytes.Buffer capture). Matches ExoPlayer's InputStream.read
// streaming model where the decoder sees bytes as soon as the CDN sends them.
func streamMVSegmentDirect(ctx context.Context, url string, w io.Writer) error {
	diskKey := url
	if q := strings.IndexByte(url, '?'); q >= 0 {
		diskKey = url[:q]
	}
	if cached, ok := GetCachedMVSegment(diskKey); ok {
		log.Printf("[mv-seg] stream cache HIT key=...%s len=%d", diskKey[len(diskKey)-20:], len(cached))
		_, err := w.Write(cached)
		return err
	}
	fetchURL, rangeHdr := url, ""
	if idx := strings.Index(url, "#bytes="); idx >= 0 {
		fetchURL = url[:idx]
		rangeHdr = "bytes=" + url[idx+len("#bytes="):]
	}
	const maxRetries = 3
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
		if err != nil {
			return err
		}
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			if !mvRetry(ctx, attempt, maxRetries) {
				return fmt.Errorf("fetch: %w", err)
			}
			continue
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			if !mvRetry(ctx, attempt, maxRetries) {
				return fmt.Errorf("HTTP %d", resp.StatusCode)
			}
			continue
		}
		var dst io.Writer = w
		var cacheBuf bytes.Buffer
		if MVCacheEnabled() {
			dst = io.MultiWriter(w, &cacheBuf)
		}
		_, copyErr := io.Copy(dst, resp.Body)
		resp.Body.Close()
		if copyErr != nil {
			// Never retry after io.Copy has started — partial bytes are already in w.
			// Retrying would re-send from byte 0, creating [partial][full] garbage that
			// MSE cannot decode (MEDIA_ERR_DECODE). Fail fast and let the session abort.
			return fmt.Errorf("stream body: %w", copyErr)
		}
		if MVCacheEnabled() {
			PutCachedMVSegment(diskKey, cacheBuf.Bytes())
		}
		return nil
	}
	return fmt.Errorf("all retries exhausted")
}

// DownloadMVSegmentsStreaming replaces DownloadMVSegmentsParallel on the
// streaming branch. Segment 0 is piped directly to w as bytes arrive from
// Apple's CDN (first byte in O(RTT), not O(segment_size/bw)), while the next
// `prefetch` segments are fetched into RAM in parallel. When segment 0 finishes
// streaming, segment 1 is already in RAM and writes with zero wait. This matches
// ExoPlayer's native HLS InputStream model (PlayerHttpDataSource.read → decoder).
func DownloadMVSegmentsStreaming(ctx context.Context, urls []string, w io.Writer, prefetch int) error {
	log.Printf("[dl] DownloadMVSegmentsStreaming nURLs=%d prefetch=%d firstURL=%s",
		len(urls), prefetch, func() string {
			if len(urls) > 0 {
				return urls[0]
			}
			return "(none)"
		}())

	if len(urls) == 0 {
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type prefetched struct {
		data []byte
		err  error
	}

	// ahead is a pipeline of channels, one per lookahead segment (urls[1:]).
	// Buffer size = prefetch so the producer can queue that many ahead without
	// blocking while segment 0 is still streaming.
	ahead := make(chan chan prefetched, prefetch)

	go func() {
		defer close(ahead)
		// Semaphore limits concurrent prefetch HTTP requests to `prefetch`.
		sem := make(chan struct{}, prefetch)
		for i, url := range urls[1:] {
			ch := make(chan prefetched, 1)
			select {
			case ahead <- ch:
			case <-ctx.Done():
				return
			}
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				ch <- prefetched{err: ctx.Err()}
				return
			}
			go func(idx int, url string, ch chan prefetched) {
				defer func() { <-sem }()
				t0 := time.Now()
				data, err := fetchMVSegment(ctx, url)
				if err == nil {
					log.Printf("[dl] mv#%d prefetch arrived size=%dB elapsed=%.2fs", idx, len(data), time.Since(t0).Seconds())
				} else {
					log.Printf("[dl] mv#%d prefetch error elapsed=%.2fs: %v", idx, time.Since(t0).Seconds(), err)
				}
				ch <- prefetched{data, err}
			}(i+1, url, ch)
		}
		// Drain semaphore so all in-flight goroutines finish before close.
		for range prefetch {
			sem <- struct{}{}
		}
	}()

	// Stream segment 0 directly — first bytes reach MSE within O(RTT).
	t0 := time.Now()
	log.Printf("[dl] mv#0 streaming directly (no buffer)")
	if err := streamMVSegmentDirect(ctx, urls[0], w); err != nil {
		cancel()
		return fmt.Errorf("segment 0: %w", err)
	}
	log.Printf("[dl] mv#0 stream done elapsed=%.2fs", time.Since(t0).Seconds())

	// Drain prefetched segments in order; each is already in RAM by the time
	// we reach it (segment 0's stream duration ≈ 1 segment download time).
	idx := 1
	for ch := range ahead {
		r := <-ch
		if r.err != nil {
			cancel()
			return fmt.Errorf("segment %d: %w", idx, r.err)
		}
		t1 := time.Now()
		if _, err := w.Write(r.data); err != nil {
			return err
		}
		log.Printf("[dl] mv#%d written size=%dB write_elapsed=%.2fs", idx, len(r.data), time.Since(t1).Seconds())
		idx++
	}
	return nil
}

// mvBgDownloads tracks segments currently being background-cached so we don't
// duplicate downloads when multiple retries cancel the same in-flight request.
var mvBgDownloads sync.Map // diskKey → struct{}

// fetchMVSegment is like fetchSegment but uses the separate MV video cache.
func fetchMVSegment(ctx context.Context, url string) ([]byte, error) {
	// Strip rotating query params (accessKey changes each session) so the disk
	// cache key is stable across replays of the same video.
	diskKey := url
	if q := strings.IndexByte(url, '?'); q >= 0 {
		diskKey = url[:q]
	}
	if cached, ok := GetCachedMVSegment(diskKey); ok {
		log.Printf("[mv-seg] cache HIT key=%s len=%d", diskKey[len(diskKey)-20:], len(cached))
		return cached, nil
	}
	log.Printf("[mv-seg] cache MISS key=%s", diskKey[len(diskKey)-20:])
	fetchURL, rangeHdr := url, ""
	if idx := strings.Index(url, "#bytes="); idx >= 0 {
		fetchURL = url[:idx]
		rangeHdr = "bytes=" + url[idx+len("#bytes="):]
	}
	const maxRetries = 3
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			// Session was canceled before this segment finished downloading.
			// Kick off a background goroutine to complete the download so that
			// the next retry (or next play of the same track) finds it in cache.
			kickMVSegmentBackground(diskKey, fetchURL, rangeHdr)
			return nil, ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
		if err != nil {
			return nil, err
		}
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			if !mvRetry(ctx, attempt, maxRetries) {
				return nil, fmt.Errorf("fetch: %w", err)
			}
			continue
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			if !mvRetry(ctx, attempt, maxRetries) {
				return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
			}
			continue
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			if !mvRetry(ctx, attempt, maxRetries) {
				return nil, fmt.Errorf("read body: %w", err)
			}
			continue
		}
		if MVCacheEnabled() {
			PutCachedMVSegment(diskKey, data)
		}
		return data, nil
	}
	return nil, fmt.Errorf("all retries exhausted")
}

// kickMVSegmentBackground launches a background download for a segment that was
// canceled mid-flight. It is a no-op if a background download for this key is
// already in progress. The goroutine uses its own context with a 10-minute
// timeout so it survives the session that triggered it.
func kickMVSegmentBackground(diskKey, fetchURL, rangeHdr string) {
	if _, loaded := mvBgDownloads.LoadOrStore(diskKey, struct{}{}); loaded {
		return // already in progress
	}
	go func() {
		defer mvBgDownloads.Delete(diskKey)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
		if err != nil {
			return
		}
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			log.Printf("[mv-seg] bg-dl error key=%s: %v", diskKey[len(diskKey)-20:], err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			log.Printf("[mv-seg] bg-dl HTTP %d key=%s", resp.StatusCode, diskKey[len(diskKey)-20:])
			return
		}
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			log.Printf("[mv-seg] bg-dl read error key=%s: %v", diskKey[len(diskKey)-20:], err)
			return
		}
		if MVCacheEnabled() {
			PutCachedMVSegment(diskKey, data)
			log.Printf("[mv-seg] bg-dl cached key=%s len=%d", diskKey[len(diskKey)-20:], len(data))
		}
	}()
}

// DownloadMVSegmentsParallel is like DownloadSegmentsParallel but uses the
// separate MV video segment cache. Use for MV video tracks.
func DownloadMVSegmentsParallel(ctx context.Context, urls []string, w io.Writer, concurrency int) error {
	log.Printf("[dl] DownloadMVSegmentsParallel nURLs=%d concurrency=%d firstURL=%s",
		len(urls), concurrency, func() string {
			if len(urls) > 0 {
				return urls[0]
			}
			return "(none)"
		}())

	type result struct {
		data []byte
		err  error
	}

	resultChs := make([]chan result, len(urls))
	for i := range resultChs {
		resultChs[i] = make(chan result, 1)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sem := make(chan struct{}, concurrency)

	go func() {
		for i, url := range urls {
			i, url := i, url
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				for j := i; j < len(resultChs); j++ {
					resultChs[j] <- result{err: ctx.Err()}
				}
				return
			}
			go func() {
				defer func() { <-sem }()
				t0 := time.Now()
				data, err := fetchMVSegment(ctx, url)
				if err == nil {
					log.Printf("[dl] mv#%d arrived size=%dB elapsed=%.2fs", i, len(data), time.Since(t0).Seconds())
				} else {
					log.Printf("[dl] mv#%d error elapsed=%.2fs: %v", i, time.Since(t0).Seconds(), err)
				}
				resultChs[i] <- result{data: data, err: err}
			}()
		}
	}()

	for i, ch := range resultChs {
		r := <-ch
		if r.err != nil {
			cancel()
			return fmt.Errorf("segment %d: %w", i, r.err)
		}
		if _, err := w.Write(r.data); err != nil {
			return err
		}
	}
	return nil
}

// DownloadSegments streams each URL one at a time, writing each segment to w
// immediately after it is fetched. Use for small segments (AAC audio) where
// startup latency matters more than throughput.
func DownloadSegments(ctx context.Context, urls []string, w io.Writer) error {
	log.Printf("[dl] DownloadSegments nURLs=%d firstURL=%s", len(urls), func() string {
		if len(urls) > 0 {
			return urls[0]
		}
		return "(none)"
	}())
	for i, cacheKey := range urls {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		data, err := fetchSegment(ctx, cacheKey)
		if err != nil {
			return fmt.Errorf("segment %d: %w", i, err)
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return nil
}

// DownloadSegmentsParallel fetches up to concurrency segments simultaneously
// and writes them to w in playlist order. The launcher runs in its own goroutine
// so the drain loop starts immediately — segments already in cache flow to the
// decrypt pipeline without waiting for slow network segments to be launched.
//
// Memory: at most concurrency×segmentSize bytes in-flight at any time.
// Order: strictly preserved — w always receives [init, seg0, seg1, …].
func DownloadSegmentsParallel(ctx context.Context, urls []string, w io.Writer, concurrency int) error {
	log.Printf("[dl] DownloadSegmentsParallel nURLs=%d concurrency=%d firstURL=%s",
		len(urls), concurrency, func() string {
			if len(urls) > 0 {
				return urls[0]
			}
			return "(none)"
		}())

	type result struct {
		data []byte
		err  error
	}

	// One buffered channel per segment so goroutines never block writing results.
	resultChs := make([]chan result, len(urls))
	for i := range resultChs {
		resultChs[i] = make(chan result, 1)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Semaphore: at most `concurrency` HTTP requests in flight at once.
	sem := make(chan struct{}, concurrency)

	// Launcher runs in a separate goroutine so the drain loop below starts
	// immediately. Cache-hit segments (elapsed≈0) flow to w without waiting
	// for the semaphore to open for slow network segments.
	go func() {
		for i, url := range urls {
			i, url := i, url
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				for j := i; j < len(resultChs); j++ {
					resultChs[j] <- result{err: ctx.Err()}
				}
				return
			}
			go func() {
				defer func() { <-sem }()
				t0 := time.Now()
				data, err := fetchSegment(ctx, url)
				if err == nil {
					log.Printf("[dl] seg#%d arrived size=%dB elapsed=%.2fs", i, len(data), time.Since(t0).Seconds())
				} else {
					log.Printf("[dl] seg#%d error elapsed=%.2fs: %v", i, time.Since(t0).Seconds(), err)
				}
				resultChs[i] <- result{data: data, err: err}
			}()
		}
	}()

	for i, ch := range resultChs {
		r := <-ch
		if r.err != nil {
			cancel()
			return fmt.Errorf("segment %d: %w", i, r.err)
		}
		if _, err := w.Write(r.data); err != nil {
			return err
		}
	}
	return nil
}
