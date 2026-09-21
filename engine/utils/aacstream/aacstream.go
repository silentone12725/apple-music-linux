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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB cap for HLS playlist
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
	// No client-level Timeout: segments can be 14MB+ at 2Mbps (~56s) or slower.
	// ResponseHeaderTimeout guards against hung connections; body reads are bounded
	// by the caller's context (session lifetime).
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

// keyCache caches acquired Widevine content keys keyed by "kidBase64:uriPrefix".
// A cached key eliminates the full CDM round-trip on subsequent opens of the
// same track (e.g. pause → resume), mirroring Android's PlayerPlaybackCertManager
// which persists the FPS Application Certificate across sessions.
// The cache is process-scoped and never written to disk; keys survive only for
// the engine process lifetime.
var keyCache sync.Map // string → []byte

// cacheKeyFor builds the cache lookup key from the content-key identifiers.
func cacheKeyFor(kidBase64, uriPrefix string) string { return kidBase64 + "\x00" + uriPrefix }

// InvalidateKey evicts a cached content key so the next AcquireKey call is
// forced to re-negotiate with the licence server.  Call this when a segment
// decrypts with an error — the cached key may be stale.
func InvalidateKey(kidBase64, uriPrefix string) { keyCache.Delete(cacheKeyFor(kidBase64, uriPrefix)) }

// AcquireKey acquires the AES decryption key for one Apple Music track via the
// Widevine licence endpoint and returns the raw key bytes.  This is the only
// exported key-acquisition function; callers must not store the bytes in any
// field that is serialised or returned to API clients.
//
// kidBase64 and uriPrefix come from the EXT-X-KEY URI field in the HLS media
// playlist (split on the first comma: uriPrefix,kidBase64).
// adamID is the Apple Music asset identifier used in the licence request body.
//
// When forceRefresh is false, a previously cached key is returned immediately
// (eliminating the CDM round-trip on track resume).  When forceRefresh is true,
// the cache is bypassed and a fresh licence is acquired — use this after a
// decryption failure to recover from a stale cached key.
func AcquireKey(ctx context.Context, adamID, kidBase64, uriPrefix, token, mutoken string, forceRefresh bool) ([]byte, error) {
	ck := cacheKeyFor(kidBase64, uriPrefix)
	if !forceRefresh {
		if v, ok := keyCache.Load(ck); ok {
			return v.([]byte), nil
		}
	}
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
	if err == nil && len(keyBytes) > 0 {
		keyCache.Store(ck, keyBytes)
	}
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
		data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20)) // 50 MB cap per segment
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

// mvByteCounter wraps an io.Writer and records the total bytes written.
// Used to measure segment 0's size for bandwidth estimation.
type mvByteCounter struct {
	w io.Writer
	n int64
}

func (c *mvByteCounter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// DownloadMVSegmentsStreaming replaces DownloadMVSegmentsParallel on the
// streaming branch. Segment 0 is streamed at full available bandwidth with no
// concurrent downloads competing for it. After segment 0 completes, bandwidth
// is measured and an adaptive prefetch count is chosen (1 at 2Mbps, up to
// `prefetch` at high bandwidth). Prefetched segments also stream: goroutines
// open HTTP connections in parallel and send the open body as soon as headers
// arrive (O(RTT)); the main goroutine drains each body in order via io.Copy,
// so the growing file grows continuously — not in discrete end-of-segment jumps.
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

	// Stream segment 0 at full bandwidth — no concurrent downloads compete.
	// Wrap w to count bytes so we can measure bandwidth for adaptive prefetch.
	seg0 := &mvByteCounter{w: w}
	t0 := time.Now()
	log.Printf("[dl] mv#0 streaming directly (no buffer)")
	if err := streamMVSegmentDirect(ctx, urls[0], seg0); err != nil {
		cancel()
		return fmt.Errorf("segment 0: %w", err)
	}
	seg0Dur := time.Since(t0)

	// Compute effectivePrefetch from measured segment-0 bandwidth.
	// Parallel connections each get (bw/N) — at 2Mbps that's ruinous.
	// 1 extra concurrent connection per 8Mbps keeps each connection's share ≥ 2Mbps.
	effectivePrefetch := prefetch
	if seg0Dur > 0 && seg0.n > 0 {
		bwMbps := float64(seg0.n*8) / seg0Dur.Seconds() / 1e6
		p := int(bwMbps / 8)
		if p < 1 {
			p = 1
		}
		if p > prefetch {
			p = prefetch
		}
		effectivePrefetch = p
		log.Printf("[dl] mv#0 done size=%dB elapsed=%.2fs bw=%.1fMbps → effectivePrefetch=%d",
			seg0.n, seg0Dur.Seconds(), bwMbps, effectivePrefetch)
	} else {
		log.Printf("[dl] mv#0 done elapsed=%.2fs", seg0Dur.Seconds())
	}

	if len(urls) == 1 {
		return nil
	}

	// prefetchStream holds a ready-to-drain HTTP response body for one
	// prefetched segment. The goroutine blocks on done until the main goroutine
	// finishes draining, then closes the body and releases its sem slot.
	// This keeps at most `effectivePrefetch` concurrent open HTTP connections.
	type prefetchStream struct {
		body    io.ReadCloser // response body or cache bytes.Reader; nil on error
		diskKey string        // for PutCachedMVSegment; empty for cache hits
		err     error
		done    chan struct{} // close to unblock goroutine cleanup; nil for cache hits
	}

	// ahead is a pipeline of channels, one per lookahead segment (urls[1:]).
	ahead := make(chan chan prefetchStream, effectivePrefetch)

	go func() {
		defer close(ahead)
		sem := make(chan struct{}, effectivePrefetch)

		for i, url := range urls[1:] {
			ch := make(chan prefetchStream, 1)
			select {
			case ahead <- ch:
			case <-ctx.Done():
				return
			}
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				ch <- prefetchStream{err: ctx.Err()}
				return
			}

			go func(idx int, url string, ch chan prefetchStream) {
				diskKey := url
				if q := strings.IndexByte(url, '?'); q >= 0 {
					diskKey = url[:q]
				}

				// Cache hit: serve from memory; no connection to hold open.
				if cached, ok := GetCachedMVSegment(diskKey); ok {
					log.Printf("[dl] mv#%d prefetch cache HIT len=%d", idx, len(cached))
					<-sem
					ch <- prefetchStream{body: io.NopCloser(bytes.NewReader(cached))}
					return
				}

				fetchURL, rangeHdr := url, ""
				if k := strings.Index(url, "#bytes="); k >= 0 {
					fetchURL = url[:k]
					rangeHdr = "bytes=" + url[k+len("#bytes="):]
				}

				// Retry loop covers header acquisition only — no retry after
				// body starts flowing (partial bytes already in w).
				var (
					resp    *http.Response
					lastErr error
				)
				for attempt := 0; attempt < 3; attempt++ {
					if ctx.Err() != nil {
						lastErr = ctx.Err()
						break
					}
					req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
					if err != nil {
						lastErr = err
						break
					}
					if rangeHdr != "" {
						req.Header.Set("Range", rangeHdr)
					}
					resp, err = mvHTTPClient.Do(req)
					if err != nil {
						lastErr = fmt.Errorf("fetch: %w", err)
						resp = nil
						if !mvRetry(ctx, attempt, 3) {
							break
						}
						continue
					}
					if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
						resp.Body.Close()
						lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
						resp = nil
						if !mvRetry(ctx, attempt, 3) {
							break
						}
						continue
					}
					lastErr = nil
					break
				}

				if lastErr != nil || resp == nil {
					if lastErr == nil {
						lastErr = fmt.Errorf("all retries exhausted")
					}
					log.Printf("[dl] mv#%d prefetch error: %v", idx, lastErr)
					<-sem
					ch <- prefetchStream{err: lastErr}
					return
				}

				// Headers arrived — hand the open body to the main goroutine.
				// Hold sem until done fires so concurrent connections stay bounded.
				log.Printf("[dl] mv#%d prefetch headers ready", idx)
				done := make(chan struct{})
				ch <- prefetchStream{body: resp.Body, diskKey: diskKey, done: done}
				select {
				case <-done:
				case <-ctx.Done():
				}
				resp.Body.Close()
				<-sem
			}(i+1, url, ch)
		}

		// Wait for all goroutines to release their sem slots before closing ahead.
		for range effectivePrefetch {
			sem <- struct{}{}
		}
	}()

	// Drain prefetched segments in order. Each body is already open and bytes
	// are flowing from the CDN — no wait for a full segment to buffer in RAM.
	idx := 1
	for ch := range ahead {
		r := <-ch
		if r.err != nil {
			cancel()
			return fmt.Errorf("segment %d: %w", idx, r.err)
		}

		t1 := time.Now()
		var dst io.Writer = w
		var cacheBuf bytes.Buffer
		if MVCacheEnabled() && r.diskKey != "" {
			dst = io.MultiWriter(w, &cacheBuf)
		}

		n, copyErr := io.Copy(dst, r.body)
		// Signal goroutine to close the body and release sem.
		if r.done != nil {
			close(r.done)
		}

		if copyErr != nil {
			cancel()
			return fmt.Errorf("segment %d stream: %w", idx, copyErr)
		}
		if MVCacheEnabled() && cacheBuf.Len() > 0 {
			PutCachedMVSegment(r.diskKey, cacheBuf.Bytes())
		}
		log.Printf("[dl] mv#%d stream done size=%dB elapsed=%.2fs", idx, n, time.Since(t1).Seconds())
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
		data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20)) // 50 MB cap per MV segment
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
		data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20)) // 50 MB cap per MV segment
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
