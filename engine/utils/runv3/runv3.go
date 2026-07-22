package runv3

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"github.com/go-resty/resty/v2"
	"google.golang.org/protobuf/proto"

	cdm "apple-music-cli/utils/runv3/cdm"
	key "apple-music-cli/utils/runv3/key"
	"os"

	"bytes"
	"errors"
	"io"

	"github.com/itouakirai/mp4ff/mp4"

	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grafov/m3u8"
	"github.com/schollz/progressbar/v3"
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
		fmt.Println(err)
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
		fmt.Println("Error encoding JSON:", err)
		return "", "", "", err
	}
	req, err := http.NewRequest("POST", url, bytes.NewBuffer([]byte(jsonData)))
	if err != nil {
		fmt.Println("Error creating request:", err)
		return "", "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	req.Header.Set("Referer", "https://music.apple.com/")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", authtoken))
	req.Header.Set("x-apple-music-user-token", mutoken)
	// 创建 HTTP 客户端
	//client := &http.Client{}
	resp, err := http.DefaultClient.Do(req)
	// 发送请求
	//resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error sending request:", err)
		return "", "", "", err
	}
	defer resp.Body.Close()
	//fmt.Println("Response Status:", resp.Status)
	obj := new(Songlist)
	err = json.NewDecoder(resp.Body).Decode(&obj)
	if err != nil {
		fmt.Println("json err:", err)
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
	resp, err := http.Get(b)
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
			//fmt.Println("Extracted URI:", mediaPlaylist.Map.URI)
			if mvmode {
				for _, segment := range mediaPlaylist.Segments {
					if segment != nil {
						//fmt.Println("Extracted URI:", segment.URI)
						urlBuilder.WriteString(";")
						urlBuilder.WriteString(b[:lastSlashIndex])
						urlBuilder.WriteString("/")
						urlBuilder.WriteString(segment.URI)
						//fileurl = fileurl + ";" + b[:lastSlashIndex] + "/" + segment.URI
					}
				}
			}
		} else {
			fmt.Println("No key information found")
		}
	} else {
		fmt.Println("Not a media playlist")
	}
	return kidbase64, urlBuilder.String(), uriPrefix, nil
}
func extsong(b string) bytes.Buffer {
	const maxRetries = 3
	var buffer bytes.Buffer
	for attempt := range maxRetries {
		buffer.Reset()
		resp, err := mvHTTPClient.Get(b)
		if err != nil {
			if attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 500 * time.Millisecond)
				continue
			}
			fmt.Printf("下载文件失败: %v\n", err)
			return buffer
		}
		bar := progressbar.NewOptions64(
			resp.ContentLength,
			progressbar.OptionClearOnFinish(),
			progressbar.OptionSetElapsedTime(false),
			progressbar.OptionSetPredictTime(false),
			progressbar.OptionShowElapsedTimeOnFinish(),
			progressbar.OptionShowCount(),
			progressbar.OptionEnableColorCodes(true),
			progressbar.OptionShowBytes(true),
			progressbar.OptionSetDescription("Downloading..."),
			progressbar.OptionSetTheme(progressbar.Theme{
				Saucer:        "",
				SaucerHead:    "",
				SaucerPadding: "",
				BarStart:      "",
				BarEnd:        "",
			}),
		)
		_, copyErr := io.Copy(io.MultiWriter(&buffer, bar), resp.Body)
		resp.Body.Close()
		if copyErr == nil {
			return buffer
		}
		if attempt < maxRetries-1 {
			fmt.Printf("⚠ Download attempt %d failed (%v), retrying...\n", attempt+1, copyErr)
			time.Sleep(time.Duration(1<<attempt) * 500 * time.Millisecond)
		} else {
			fmt.Printf("下载文件失败: %v\n", copyErr)
		}
	}
	return buffer
}
func Run(adamId string, trackpath string, authtoken string, mutoken string, mvmode bool, serverUrl string) (string, error) {
	var keystr string //for mv key
	var fileurl string
	var kidBase64 string
	var uriPrefix string
	var err error
	if mvmode {
		kidBase64, fileurl, uriPrefix, err = extractKidBase64(trackpath, true)
		if err != nil {
			return "", err
		}
	} else {
		fileurl, kidBase64, uriPrefix, err = GetWebplayback(adamId, authtoken, mutoken, false)
		if err != nil {
			return "", err
		}
	}
	ctx := context.Background()
	ctx = context.WithValue(ctx, "pssh", kidBase64)
	ctx = context.WithValue(ctx, "adamId", adamId)
	ctx = context.WithValue(ctx, "uriPrefix", uriPrefix)
	pssh, err := getPSSH("", kidBase64)
	//fmt.Println(pssh)
	if err != nil {
		fmt.Println(err)
		return "", err
	}
	headers := map[string]string{
		"authorization":            "Bearer " + authtoken,
		"x-apple-music-user-token": mutoken,
	}
	client := resty.New()
	client.SetHeaders(headers)
	key := key.Key{
		ReqCli:        client,
		BeforeRequest: BeforeRequest,
		AfterRequest:  AfterRequest,
	}
	key.CdmInit()
	var keybt []byte
	if serverUrl != "" {
		keystr, keybt, err = key.GetKey(ctx, serverUrl, pssh, nil)
		if err != nil {
			fmt.Println(err)
			return "", err
		}
	} else {
		keystr, keybt, err = key.GetKey(ctx, "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense", pssh, nil)
		if err != nil {
			fmt.Println(err)
			return "", err
		}
	}
	if mvmode {
		keyAndUrls := "1:" + keystr + ";" + fileurl
		return keyAndUrls, nil
	}
	body := extsong(fileurl)
	fmt.Print("Downloaded\n")
	//bodyReader := bytes.NewReader(body)
	var buffer bytes.Buffer

	err = DecryptMP4(&body, keybt, &buffer)
	if err != nil {
		fmt.Print("Decryption failed\n")
		return "", err
	} else {
		fmt.Print("Decrypted\n")
	}
	// create output file
	ofh, err := os.Create(trackpath)
	if err != nil {
		fmt.Printf("创建文件失败: %v\n", err)
		return "", err
	}
	defer ofh.Close()

	_, err = ofh.Write(buffer.Bytes())
	if err != nil {
		fmt.Printf("写入文件失败: %v\n", err)
		return "", err
	}
	return "", nil
}

// Segment 结构体用于在 Channel 中传递分段数据
type Segment struct {
	Index int
	Data  []byte
}

// RunStream streams a track directly to an io.Writer without saving to disk.
// Decryption happens on-the-fly as the download progresses.
func RunStream(adamId string, authtoken string, mutoken string, w io.Writer) error {
	fileurl, kidBase64, uriPrefix, err := GetWebplayback(adamId, authtoken, mutoken, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	ctx = context.WithValue(ctx, "pssh", kidBase64)
	ctx = context.WithValue(ctx, "adamId", adamId)
	ctx = context.WithValue(ctx, "uriPrefix", uriPrefix)
	pssh, err := getPSSH("", kidBase64)
	if err != nil {
		return err
	}
	headers := map[string]string{
		"authorization":            "Bearer " + authtoken,
		"x-apple-music-user-token": mutoken,
	}
	client := resty.New()
	client.SetHeaders(headers)
	k := key.Key{
		ReqCli:        client,
		BeforeRequest: BeforeRequest,
		AfterRequest:  AfterRequest,
	}
	k.CdmInit()
	_, keybt, err := k.GetKey(ctx, "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense", pssh, nil)
	if err != nil {
		return err
	}
	resp, err := http.Get(fileurl)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return DecryptMP4(resp.Body, keybt, w)
}

// aimdLimiter implements Additive-Increase / Multiplicative-Decrease
// concurrency control. On each successful segment download the limit grows
// by 1 (up to max); on each failure it halves (down to min).
type aimdLimiter struct {
	mu      sync.Mutex
	cond    *sync.Cond
	current int
	active  int
	min     int
	max     int
}

func newAimdLimiter(initial, min, max int) *aimdLimiter {
	l := &aimdLimiter{current: initial, min: min, max: max}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *aimdLimiter) acquire() {
	l.mu.Lock()
	for l.active >= l.current {
		l.cond.Wait()
	}
	l.active++
	l.mu.Unlock()
}

func (l *aimdLimiter) release() {
	l.mu.Lock()
	l.active--
	l.cond.Signal()
	l.mu.Unlock()
}

func (l *aimdLimiter) onSuccess() {
	l.mu.Lock()
	if l.current < l.max {
		l.current++
		l.cond.Signal()
	}
	l.mu.Unlock()
}

func (l *aimdLimiter) onFailure() {
	l.mu.Lock()
	if next := l.current / 2; next >= l.min {
		l.current = next
	} else {
		l.current = l.min
	}
	l.mu.Unlock()
}

// Workers returns the current concurrency level (for progress display).
func (l *aimdLimiter) Workers() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current
}

// downloadAndAssemble downloads all urls concurrently using the supplied
// aimdLimiter, reassembles segments in order, and writes the result to w.
// ctx is propagated into every segment request so that caller cancellation
// aborts in-flight HTTP requests promptly.
func downloadAndAssemble(ctx context.Context, urls []string, w io.Writer, limiter *aimdLimiter) {
	var downloadWg, writerWg sync.WaitGroup
	segmentsChan := make(chan Segment, len(urls))

	writerWg.Add(1)
	go fileWriter(&writerWg, segmentsChan, w, len(urls))

	for i, url := range urls {
		if ctx.Err() != nil {
			break
		}
		limiter.acquire()
		downloadWg.Add(1)
		go downloadSegment(ctx, url, i, &downloadWg, segmentsChan, mvHTTPClient, limiter)
	}

	downloadWg.Wait()
	close(segmentsChan)
	writerWg.Wait()
}

func downloadSegment(ctx context.Context, url string, index int, wg *sync.WaitGroup, segmentsChan chan<- Segment, client *http.Client, limiter *aimdLimiter) {
	defer func() {
		limiter.release()
		wg.Done()
	}()

	// Check segment cache before hitting the network.
	if cached, ok := GetCachedSegment(url); ok {
		limiter.onSuccess()
		segmentsChan <- Segment{Index: index, Data: cached}
		return
	}

	const maxRetries = 4
	var data []byte
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			limiter.onFailure()
			return
		}
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			fmt.Printf("segment %d: create request: %v\n", index, err)
			limiter.onFailure()
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			limiter.onFailure()
			if attempt < maxRetries-1 && ctx.Err() == nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(1<<attempt) * 500 * time.Millisecond):
				}
				continue
			}
			if ctx.Err() == nil {
				fmt.Printf("segment %d: download failed: %v\n", index, err)
			}
			return
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			limiter.onFailure()
			if attempt < maxRetries-1 && ctx.Err() == nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(1<<attempt) * 500 * time.Millisecond):
				}
				continue
			}
			if ctx.Err() == nil {
				fmt.Printf("segment %d: HTTP %d\n", index, resp.StatusCode)
			}
			return
		}
		data, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			limiter.onFailure()
			if attempt < maxRetries-1 && ctx.Err() == nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(1<<attempt) * 500 * time.Millisecond):
				}
				continue
			}
			if ctx.Err() == nil {
				fmt.Printf("segment %d: read body: %v\n", index, err)
			}
			return
		}
		limiter.onSuccess()
		break
	}
	if len(data) > 0 {
		PutCachedSegment(url, data) // persist for future runs
	}
	segmentsChan <- Segment{Index: index, Data: data}
}

// fileWriter 从 Channel 接收分段并按顺序写入文件
func fileWriter(wg *sync.WaitGroup, segmentsChan <-chan Segment, outputFile io.Writer, totalSegments int) {
	defer wg.Done()

	// 缓冲区，用于存放乱序到达的分段
	// key 是分段序号，value 是分段数据
	segmentBuffer := make(map[int][]byte)
	nextIndex := 0 // 期望写入的下一个分段的序号

	for segment := range segmentsChan {
		// 检查收到的分段是否是当前期望的
		if segment.Index == nextIndex {
			//fmt.Printf("写入分段 %d\n", segment.Index)
			_, err := outputFile.Write(segment.Data)
			if err != nil {
				fmt.Printf("错误(分段 %d): 写入文件失败: %v\n", segment.Index, err)
			}
			nextIndex++

			// 检查缓冲区中是否有下一个连续的分段
			for {
				data, ok := segmentBuffer[nextIndex]
				if !ok {
					break // 缓冲区里没有下一个，跳出循环，等待下一个分段到达
				}

				//fmt.Printf("从缓冲区写入分段 %d\n", nextIndex)
				_, err := outputFile.Write(data)
				if err != nil {
					fmt.Printf("错误(分段 %d): 从缓冲区写入文件失败: %v\n", nextIndex, err)
				}
				// 从缓冲区删除已写入的分段，释放内存
				delete(segmentBuffer, nextIndex)
				nextIndex++
			}
		} else {
			// 如果不是期望的分段，先存入缓冲区
			//fmt.Printf("缓冲分段 %d (等待 %d)\n", segment.Index, nextIndex)
			segmentBuffer[segment.Index] = segment.Data
		}
	}

	// 确保所有分段都已写入
	if nextIndex != totalSegments {
		fmt.Printf("警告: 写入完成，但似乎有分段丢失。期望 %d 个, 实际写入 %d 个。\n", totalSegments, nextIndex)
	}
}

var mvHTTPClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     true,
	},
	Timeout: 60 * time.Second,
}

func ExtMvData(keyAndUrls string, savePath string) error {
	parts := strings.SplitN(keyAndUrls, ";", 2)
	key := parts[0]
	urls := strings.Split(parts[1], ";")

	tempFile, err := os.CreateTemp("", "enc_mv_data-*.mp4")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)

	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	limiter := newAimdLimiter(8, 2, 32)
	bar := progressbar.NewOptions64(-1,
		progressbar.OptionClearOnFinish(),
		progressbar.OptionSetElapsedTime(true),
		progressbar.OptionSetPredictTime(false),
		progressbar.OptionShowElapsedTimeOnFinish(),
		progressbar.OptionShowBytes(true),
		progressbar.OptionShowCount(),
		progressbar.OptionEnableColorCodes(true),
		progressbar.OptionSetDescription("Downloading..."),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer: "", SaucerHead: "", SaucerPadding: "", BarStart: "", BarEnd: "",
		}),
	)
	barWriter := io.MultiWriter(tempFile, bar)

	// Background goroutine refreshes the bar description with live stats.
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				hits, misses := CacheStats()
				total := hits + misses
				hitPct := 0
				if total > 0 {
					hitPct = int(100 * hits / total)
				}
				bar.Describe(fmt.Sprintf(
					"[workers:%d cache:%d%%]",
					limiter.Workers(), hitPct,
				))
			}
		}
	}()

	downloadAndAssemble(context.Background(), urls, barWriter, limiter)
	close(done)

	if err := tempFile.Close(); err != nil {
		fmt.Printf("close temp: %v\n", err)
		return err
	}
	fmt.Println("\nDownloaded.")

	// Parse hex key from "1:hexstring" format
	hexKey := strings.SplitN(key, ":", 2)[1]
	keyBytes, err := hex.DecodeString(hexKey)
	if err != nil {
		return fmt.Errorf("invalid key format: %w", err)
	}

	// Reopen temp file for reading and decrypt in-process
	enc, err := os.Open(tempFile.Name())
	if err != nil {
		return err
	}
	defer enc.Close()

	out, err := os.Create(savePath)
	if err != nil {
		return err
	}
	defer out.Close()

	if err := DecryptMP4(enc, keyBytes, out); err != nil {
		out.Close()
		os.Remove(savePath)
		return fmt.Errorf("decrypt failed: %w", err)
	}
	fmt.Println("Decrypted.")
	return nil
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
	cl := resty.New()
	cl.SetHeaders(headers)
	k := key.Key{
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

// DownloadSegments streams each URL one at a time, writing each segment to w
// immediately after it is fetched. This gives the lowest possible startup
// latency: the caller receives the first segment as soon as it is downloaded,
// rather than waiting for the full track to arrive.
// Segments are cached on disk so subsequent calls for the same track are
// served from cache without any network round-trips.
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
		if cached, ok := GetCachedSegment(cacheKey); ok {
			if _, err := w.Write(cached); err != nil {
				return err
			}
			continue
		}
		// Decode optional byte-range encoded as "#bytes=<offset>-<end>" fragment.
		fetchURL, rangeHdr := cacheKey, ""
		if idx := strings.Index(cacheKey, "#bytes="); idx >= 0 {
			fetchURL = cacheKey[:idx]
			rangeHdr = "bytes=" + cacheKey[idx+len("#bytes="):]
		}
		req, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
		if err != nil {
			return fmt.Errorf("segment %d: %w", i, err)
		}
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		resp, err := mvHTTPClient.Do(req)
		if err != nil {
			return fmt.Errorf("segment %d fetch: %w", i, err)
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			return fmt.Errorf("segment %d: HTTP %d", i, resp.StatusCode)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("segment %d read: %w", i, err)
		}
		PutCachedSegment(cacheKey, data)
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return nil
}


// SelectVariantForCodec resolves a master HLS playlist URL to the media
// playlist URL whose codec tag matches the given string (e.g. "alac",
// "mp4a.40.2", "ec-3").  When multiple matching variants exist the one with
// the highest bandwidth is returned.  If no variant matches, the highest-
// bandwidth variant is returned as a fallback.
// Pass codec="" to get the highest-bandwidth variant regardless of codec.
func SelectVariantForCodec(masterURL, codec string) (string, error) {
	resp, err := http.Get(masterURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(string(body)), true)
	if err != nil || listType != m3u8.MASTER {
		return masterURL, nil // already a media playlist
	}
	master := from.(*m3u8.MasterPlaylist)
	base := masterURL[:strings.LastIndex(masterURL, "/")+1]

	resolveURI := func(uri string) string {
		if strings.HasPrefix(uri, "http") {
			return uri
		}
		return base + uri
	}

	var bestURL string
	var bestBW uint32
	var fallbackURL string
	var fallbackBW uint32

	for _, v := range master.Variants {
		if v == nil {
			continue
		}
		if v.Bandwidth > fallbackBW {
			fallbackBW = v.Bandwidth
			fallbackURL = resolveURI(v.URI)
		}
		if codec == "" || strings.EqualFold(v.Codecs, codec) {
			if v.Bandwidth > bestBW {
				bestBW = v.Bandwidth
				bestURL = resolveURI(v.URI)
			}
		}
	}
	if bestURL != "" {
		return bestURL, nil
	}
	if fallbackURL != "" {
		return fallbackURL, nil
	}
	return "", fmt.Errorf("no variants found in master playlist")
}


// DecryptMP4 decrypts a fragmented MP4 file with keys from widevice license. Supports CENC and CBCS schemes.
func DecryptMP4(r io.Reader, key []byte, w io.Writer) error {
	// Initialization
	inMp4, err := mp4.DecodeFile(r)
	if err != nil {
		return fmt.Errorf("failed to decode file: %w", err)
	}
	if !inMp4.IsFragmented() {
		return errors.New("file is not fragmented")
	}
	// Handle init segment
	if inMp4.Init == nil {
		return errors.New("no init part of file")
	}
	decryptInfo, err := mp4.DecryptInit(inMp4.Init)
	if err != nil {
		return fmt.Errorf("failed to decrypt init: %w", err)
	}
	if err = inMp4.Init.Encode(w); err != nil {
		return fmt.Errorf("failed to write init: %w", err)
	}
	// Decode segments
	for _, seg := range inMp4.Segments {
		if err = mp4.DecryptSegment(seg, decryptInfo, key); err != nil {
			if isNoSencBox(err) {
				// Unencrypted segment; no senc box present. See:
				// https://github.com/iyear/gowidevine/pull/26#issuecomment-2385960551
				err = nil
			} else {
				return fmt.Errorf("failed to decrypt segment: %w", err)
			}
		}
		if err = seg.Encode(w); err != nil {
			return fmt.Errorf("failed to encode segment: %w", err)
		}
	}
	return nil
}
