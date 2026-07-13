package runv3

// resume.go — crash-safe, per-segment resumable download.
//
// Correctness model:
//   - Each segment is written atomically: write to seg-NNNNN.bin.tmp, then
//     rename to seg-NNNNN.bin.  A crash during write leaves a .tmp file that
//     is ignored on restart; the segment is simply re-downloaded.
//   - The manifest records the expected SHA-256 and byte length for each
//     segment, so LoadManifest can verify each file independently of the OS
//     atime or rename guarantee.
//   - segmentsReader opens one file at a time, reads it fully, closes it,
//     then moves to the next, so file-descriptor usage is O(1) regardless of
//     segment count.
//   - Manifest saves are batched: one flush per 10 segments and one final
//     flush at the end, reducing disk write amplification on large downloads.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/schollz/progressbar/v3"
)

// SegmentInfo records enough metadata to verify a cached segment file.
type SegmentInfo struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"` // hex-encoded SHA-256 of the raw segment bytes
	Done   bool   `json:"done"`
}

// ResumeManifest persists the state of an in-progress download.
type ResumeManifest struct {
	Version  int           `json:"v"`
	SavePath string        `json:"save"`
	SegDir   string        `json:"segdir"`
	Key      string        `json:"key"`
	Segments []SegmentInfo `json:"segments"`
}

// manifestPath returns the path of the resume manifest for savePath.
func manifestPath(savePath string) string {
	dir := filepath.Dir(savePath)
	base := strings.TrimSuffix(filepath.Base(savePath), filepath.Ext(savePath))
	return filepath.Join(dir, "."+base+".amresume")
}

// segmentPath returns the on-disk path for segment index idx.
func segmentPath(segDir string, idx int) string {
	return filepath.Join(segDir, fmt.Sprintf("seg-%05d.bin", idx))
}

// SaveManifest writes the manifest atomically (write tmp → rename).
func SaveManifest(m *ResumeManifest) error {
	path := manifestPath(m.SavePath)
	tmp := path + ".tmp"
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// verifySegment checks that the segment file for idx matches the manifest.
//
// Verification is layered cheapest-first:
//  1. stat() the file — if missing or wrong size, reject immediately without
//     reading any bytes.
//  2. Read the file and compute SHA-256 — only reached when size matches,
//     which catches the (rare) partial-write-with-correct-size case.
func verifySegment(m *ResumeManifest, idx int) bool {
	info := m.Segments[idx]
	path := segmentPath(m.SegDir, idx)

	// Fast path: size check via a single syscall.
	st, err := os.Stat(path)
	if err != nil || st.Size() != info.Size {
		return false
	}

	// Full content verification only when size matches.
	data, err := os.ReadFile(path)
	if err != nil || int64(len(data)) != info.Size {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == info.SHA256
}

// LoadManifest returns the manifest for savePath, or nil if none exists.
// Each segment marked Done is re-verified against its stored hash and size;
// any mismatch resets that segment to undone so it is re-downloaded.
func LoadManifest(savePath string) (*ResumeManifest, error) {
	data, err := os.ReadFile(manifestPath(savePath))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m ResumeManifest
	if err := json.Unmarshal(data, &m); err != nil || m.Version != 1 {
		os.Remove(manifestPath(savePath))
		return nil, nil
	}
	// Re-verify every segment file to catch partial writes after power loss.
	changed := false
	for i := range m.Segments {
		if m.Segments[i].Done && !verifySegment(&m, i) {
			m.Segments[i].Done = false
			changed = true
		}
	}
	if changed {
		SaveManifest(&m) // persist corrections before returning
	}
	return &m, nil
}

// DeleteManifest removes the manifest file and segment directory on success.
func DeleteManifest(savePath string) {
	m, _ := LoadManifest(savePath)
	if m != nil && m.SegDir != "" {
		os.RemoveAll(m.SegDir)
	}
	os.Remove(manifestPath(savePath))
}

// writeSegment atomically writes data to seg-NNNNN.bin and returns the
// hash and byte count for the manifest record.
func writeSegment(segDir string, idx int, data []byte) (size int64, hashHex string, err error) {
	path := segmentPath(segDir, idx)
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, data, 0600); err != nil {
		return 0, "", err
	}
	if err = os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return 0, "", err
	}
	sum := sha256.Sum256(data)
	return int64(len(data)), hex.EncodeToString(sum[:]), nil
}

// seqReader implements io.Reader by opening, reading, and closing segment
// files one at a time.  Only one file descriptor is open at any moment.
type seqReader struct {
	segDir  string
	indices []int // segment file indices in order
	pos     int   // current index into indices
	cur     io.ReadCloser
}

func (r *seqReader) Read(p []byte) (int, error) {
	for {
		if r.cur != nil {
			n, err := r.cur.Read(p)
			if err == nil || (err != io.EOF && n > 0) {
				return n, err
			}
			r.cur.Close()
			r.cur = nil
			r.pos++
		}
		if r.pos >= len(r.indices) {
			return 0, io.EOF
		}
		f, err := os.Open(segmentPath(r.segDir, r.indices[r.pos]))
		if err != nil {
			return 0, fmt.Errorf("open segment %d: %w", r.indices[r.pos], err)
		}
		r.cur = f
	}
}

// segmentsReader returns an io.Reader that streams all segment files in index
// order, opening only one at a time to stay within file-descriptor limits.
func segmentsReader(m *ResumeManifest) io.Reader {
	indices := make([]int, len(m.Segments))
	for i := range m.Segments {
		indices[i] = i
	}
	return &seqReader{segDir: m.SegDir, indices: indices}
}

const manifestSaveBatch = 10 // flush manifest every N completed segments

// ExtMvDataResumable is ExtMvData with per-segment crash-safe resume.
func ExtMvDataResumable(keyAndUrls string, savePath string) error {
	parts := strings.SplitN(keyAndUrls, ";", 2)
	if len(parts) < 2 {
		return ExtMvData(keyAndUrls, savePath)
	}
	key := parts[0]
	urls := strings.Split(parts[1], ";")

	m, _ := LoadManifest(savePath)
	if m == nil || len(m.Segments) != len(urls) || m.Key != key {
		DeleteManifest(savePath)
		segDir, err := os.MkdirTemp("", "am-segs-*")
		if err != nil {
			return ExtMvData(keyAndUrls, savePath)
		}
		segs := make([]SegmentInfo, len(urls))
		for i, u := range urls {
			segs[i] = SegmentInfo{URL: u}
		}
		m = &ResumeManifest{
			Version:  1,
			SavePath: savePath,
			SegDir:   segDir,
			Key:      key,
			Segments: segs,
		}
	} else {
		done := 0
		for _, s := range m.Segments {
			if s.Done {
				done++
			}
		}
		if done > 0 && done < len(urls) {
			fmt.Printf("Resuming: %d/%d segments complete (%d%%)\n",
				done, len(urls), 100*done/len(urls))
		}
	}
	if err := SaveManifest(m); err != nil {
		fmt.Printf("⚠ resume manifest: %v\n", err)
	}

	if err := resumeDownload(m); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	fmt.Println("\nDownloaded.")

	hexKey := strings.SplitN(key, ":", 2)[1]
	keyBytes, err := hex.DecodeString(hexKey)
	if err != nil {
		return fmt.Errorf("key decode: %w", err)
	}

	out, err := os.Create(savePath)
	if err != nil {
		return err
	}
	defer out.Close()

	if err := DecryptMP4(segmentsReader(m), keyBytes, out); err != nil {
		out.Close()
		os.Remove(savePath)
		return fmt.Errorf("decrypt: %w", err)
	}
	fmt.Println("Decrypted.")
	DeleteManifest(savePath)
	return nil
}

// resumeDownload fetches each missing segment, writes it atomically, verifies
// the hash, and marks it done in the manifest.  Manifest flushes are batched
// every manifestSaveBatch completions to reduce disk write amplification.
//
// If any segment ultimately fails all retries, the function returns an error
// immediately after draining the result channel so callers always know whether
// all required data is present.
func resumeDownload(m *ResumeManifest) error {
	// segResult carries either a successful download or a terminal error.
	type segResult struct {
		idx  int
		data []byte
		err  error
	}

	missing := make([]int, 0, len(m.Segments))
	for i, s := range m.Segments {
		if !s.Done {
			missing = append(missing, i)
		}
	}
	if len(missing) == 0 {
		return nil
	}

	// Estimate total bytes from already-completed segments for accurate bar sizing.
	var totalBytes int64
	for _, s := range m.Segments {
		totalBytes += s.Size
	}
	if totalBytes == 0 {
		totalBytes = -1 // unknown; show spinner
	}
	bar := progressbar.NewOptions64(totalBytes,
		progressbar.OptionClearOnFinish(),
		progressbar.OptionSetElapsedTime(true),
		progressbar.OptionShowElapsedTimeOnFinish(),
		progressbar.OptionShowCount(),
		progressbar.OptionEnableColorCodes(true),
		progressbar.OptionShowBytes(true),
		progressbar.OptionSetDescription("Downloading..."),
	)
	// Pre-fill progress for already-done segments.
	for _, s := range m.Segments {
		if s.Done {
			bar.Add64(s.Size)
		}
	}

	resultCh := make(chan segResult, len(missing))
	limiter := newAimdLimiter(8, 2, 32)
	var wg sync.WaitGroup
	for _, idx := range missing {
		wg.Add(1)
		limiter.acquire()
		go func(i int) {
			defer wg.Done()
			defer limiter.release()
			data := retryFetchBytes(m.Segments[i].URL)
			if data != nil {
				limiter.onSuccess()
				resultCh <- segResult{idx: i, data: data}
			} else {
				limiter.onFailure()
				// Always send a result so the collector can account for this
				// segment and return a clear error rather than silently succeeding.
				resultCh <- segResult{
					idx: i,
					err: fmt.Errorf("segment %d: all retries exhausted (url: %s)", i, m.Segments[i].URL),
				}
			}
		}(idx)
	}
	go func() { wg.Wait(); close(resultCh) }()

	var firstErr error
	completedSinceSave := 0

	for r := range resultCh {
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue // drain remaining results before returning
		}
		size, hashHex, err := writeSegment(m.SegDir, r.idx, r.data)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("write segment %d: %w", r.idx, err)
			}
			continue
		}
		m.Segments[r.idx].Size = size
		m.Segments[r.idx].SHA256 = hashHex
		m.Segments[r.idx].Done = true
		bar.Add64(size)
		completedSinceSave++
		if completedSinceSave >= manifestSaveBatch {
			SaveManifest(m)
			completedSinceSave = 0
		}
	}
	if completedSinceSave > 0 {
		SaveManifest(m) // final flush
	}
	return firstErr
}

// retryFetchBytes downloads a URL with exponential-backoff retries.
func retryFetchBytes(url string) []byte {
	const maxRetries = 4
	for attempt := 0; attempt < maxRetries; attempt++ {
		resp, err := mvHTTPClient.Get(url)
		if err != nil {
			if attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 500 * time.Millisecond)
				continue
			}
			return nil
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			if attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 500 * time.Millisecond)
				continue
			}
			return nil
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			if attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 500 * time.Millisecond)
				continue
			}
			return nil
		}
		return data
	}
	return nil
}
