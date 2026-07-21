package export

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"apple-music-cli/engine/pipeline"
	"apple-music-cli/engine/playback"
	"apple-music-cli/utils/ampapi"
	"apple-music-cli/utils/lyrics"
)

const (
	// DefaultWorkers is the number of concurrent export jobs.
	DefaultWorkers = 2

	// defaultArtworkSize is the square pixel dimension requested from Apple CDN.
	defaultArtworkSize = 3000
)

// EventSink receives export progress events.  apiserver.go injects an
// implementation that forwards them to SSE clients.
type EventSink func(ev ExportEvent)

// Manager enqueues and executes export jobs using a bounded worker pool.
// It is safe for concurrent use.
type Manager struct {
	mu       sync.RWMutex
	jobs     map[string]*ExportJob
	requests map[string]ExportRequest // original request per job, for Retry
	queue    chan *workItem
	sink     EventSink
	manager  *playback.Manager
}

type workItem struct {
	job *ExportJob
	req ExportRequest
	ctx context.Context
}

// NewManager creates an ExportManager that acquires media through pm and
// notifies ev on each state transition.
func NewManager(pm *playback.Manager, ev EventSink, workers int) *Manager {
	if workers <= 0 {
		workers = DefaultWorkers
	}
	m := &Manager{
		jobs:     make(map[string]*ExportJob),
		requests: make(map[string]ExportRequest),
		queue:    make(chan *workItem, 64),
		sink:     ev,
		manager:  pm,
	}
	for range workers {
		go m.worker()
	}
	return m
}

// Enqueue adds a new export job to the queue and returns its descriptor.
func (m *Manager) Enqueue(req ExportRequest) (*ExportJob, error) {
	if req.AssetID == "" {
		return nil, fmt.Errorf("assetId is required")
	}
	if req.OutputDir == "" {
		req.OutputDir = defaultOutputDir()
	}
	if req.Options.ArtworkSize <= 0 {
		req.Options.ArtworkSize = defaultArtworkSize
	}
	if req.Options.OverwritePolicy == "" {
		req.Options.OverwritePolicy = "skip"
	}
	if req.Options.LrcFormat == "" {
		req.Options.LrcFormat = "lrc"
	}
	if req.Options.LrcType == "" {
		req.Options.LrcType = "lyrics"
	}

	jobCtx, cancel := context.WithCancel(context.Background())
	job := &ExportJob{
		ID:        newExportID(),
		AssetID:   req.AssetID,
		Phase:     PhaseQueued,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		cancel:    cancel,
	}

	m.mu.Lock()
	m.jobs[job.ID] = job
	m.requests[job.ID] = req
	m.mu.Unlock()

	m.queue <- &workItem{job: job, req: req, ctx: jobCtx}
	m.emit(job, 0, "")
	return job, nil
}

// Get returns the current state of a job, or (nil, false) if unknown.
func (m *Manager) Get(id string) (*ExportJob, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[id]
	return j, ok
}

// List returns all known jobs.
func (m *Manager) List() []*ExportJob {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*ExportJob, 0, len(m.jobs))
	for _, j := range m.jobs {
		out = append(out, j)
	}
	return out
}

// Cancel requests cancellation of job id; returns false if not found.
func (m *Manager) Cancel(id string) bool {
	m.mu.RLock()
	j, ok := m.jobs[id]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	j.cancel()
	return true
}

// Retry re-enqueues the original request for a failed or cancelled job.
// Returns (newJob, true) on success, or (nil, false) if the job is unknown
// or not in a retryable state (failed or cancelled).
func (m *Manager) Retry(id string) (*ExportJob, bool) {
	m.mu.RLock()
	j, ok := m.jobs[id]
	req, hasReq := m.requests[id]
	m.mu.RUnlock()

	if !ok || !hasReq {
		return nil, false
	}
	if j.Phase != PhaseFailed && j.Phase != PhaseCancelled {
		return nil, false
	}
	newJob, err := m.Enqueue(req)
	if err != nil {
		return nil, false
	}
	return newJob, true
}

// worker processes items from the queue one at a time.
func (m *Manager) worker() {
	for item := range m.queue {
		m.execute(item)
	}
}

// execute runs one export job through the full pipeline.
func (m *Manager) execute(item *workItem) {
	job := item.job
	req := item.req
	ctx := item.ctx

	defer func() {
		if r := recover(); r != nil {
			m.fail(job, fmt.Errorf("panic: %v", r))
		}
	}()

	// ── Phase 1: Resolve catalog metadata ────────────────────────────────
	m.advance(job, PhaseResolving, 0)

	sf := req.Storefront
	if sf == "" {
		sf = "us"
	}
	lang := req.Language
	if lang == "" {
		lang = "en-US"
	}

	song, err := ampapi.GetSongRespContext(ctx, sf, req.AssetID, lang, req.Token)
	if err != nil || len(song.Data) == 0 {
		m.fail(job, fmt.Errorf("song %s not found in %s: %w", req.AssetID, sf, err))
		return
	}
	a := song.Data[0].Attributes

	genre := ""
	if len(a.GenreNames) > 0 {
		genre = a.GenreNames[0]
	}

	codec, ext := "aac", "m4a"
	switch {
	case req.Capabilities.Video:
		codec, ext = "mv", "mp4"
	case req.Capabilities.Atmos:
		codec = "atmos"
	case req.Capabilities.Lossless:
		codec = "alac"
	}
	if req.Options.ConvertToFLAC && req.Capabilities.Lossless {
		ext = "flac"
	}

	meta := TrackMeta{
		Title:         a.Name,
		ArtistName:    a.ArtistName,
		AlbumArtist:   a.ArtistName,
		AlbumName:     a.AlbumName,
		TrackNumber:   a.TrackNumber,
		DiscNumber:    a.DiscNumber,
		ReleaseDate:   a.ReleaseDate,
		Genre:         genre,
		Composer:      a.ComposerName,
		Isrc:          a.Isrc,
		ContentRating: a.ContentRating,
		DurationMs:    a.DurationInMillis,
		ArtworkURL:    a.Artwork.URL,
		HasLyrics:     a.HasLyrics,
	}

	vars := templateVar{
		Title:       a.Name,
		Artist:      a.ArtistName,
		AlbumArtist: a.ArtistName,
		Album:       a.AlbumName,
		TrackNumber: a.TrackNumber,
		DiscNumber:  a.DiscNumber,
		Year:        yearFromDate(a.ReleaseDate),
		Genre:       genre,
		Codec:       codec,
		Ext:         ext,
	}

	relPath := renderTemplate(req.FilenameTemplate, vars)
	outPath := filepath.Join(req.OutputDir, relPath)

	// ── Phase 2: Overwrite check ──────────────────────────────────────────
	finalPath, skip := overwritePath(outPath, req.Options.OverwritePolicy)
	if skip {
		m.setOutput(job, finalPath)
		m.advance(job, PhaseDone, 100)
		return
	}

	// ── Phase 3: Download + decrypt via engine ────────────────────────────
	m.advance(job, PhaseDownloading, 0)

	sess, err := m.manager.Open(ctx, playback.OpenRequest{
		AssetID:    req.AssetID,
		Storefront: sf,
		Token:      req.Token,
		MUT:        req.MUT,
		Language:   lang,
		Lossless:   req.Capabilities.Lossless,
		Atmos:      req.Capabilities.Atmos,
		Video:      req.Capabilities.Video,
	})
	if err != nil {
		m.fail(job, fmt.Errorf("open session: %w", err))
		return
	}
	defer m.manager.Release(sess.ID)

	kind := pipeline.KindAudio
	if req.Capabilities.Video {
		kind = pipeline.KindVideo
	}

	// Buffer decrypted audio in memory; then write to a temp file for tagging.
	// mp4tag.Open requires a seekable file path, so we cannot tag in-place
	// from a streaming write.
	var buf bytes.Buffer
	if err := m.manager.Stream(ctx, sess.ID, kind, &buf); err != nil {
		m.fail(job, fmt.Errorf("stream: %w", err))
		return
	}

	// ── Phase 4: Write to disk (temp file) ───────────────────────────────
	m.advance(job, PhaseTagging, 80)

	if err := ensureDir(filepath.Dir(finalPath)); err != nil {
		m.fail(job, fmt.Errorf("mkdir %s: %w", filepath.Dir(finalPath), err))
		return
	}
	tmpPath := finalPath + ".am-export.tmp"
	if err := os.WriteFile(tmpPath, buf.Bytes(), 0o644); err != nil {
		m.fail(job, fmt.Errorf("write temp: %w", err))
		return
	}
	buf.Reset()

	// ── Phase 5: Fetch lyrics if requested ───────────────────────────────
	var lrcStr string
	if req.Options.EmbedLyrics && a.HasLyrics {
		lrcStr, _ = lyrics.GetContext(ctx,
			sf, req.AssetID,
			req.Options.LrcType, lang, req.Options.LrcFormat,
			req.Token, req.MUT,
		)
	}

	// ── Phase 6: Tag (metadata, artwork, lyrics) ──────────────────────────
	if !req.Capabilities.Video {
		if err := TagFile(tmpPath, meta, TagOptions{
			EmbedArtwork: req.Options.EmbedArtwork,
			ArtworkSize:  req.Options.ArtworkSize,
			Lyrics:       lrcStr,
		}); err != nil {
			// Tagging failure is non-fatal: warn and continue.
			fmt.Printf("export %s: tag warning: %v\n", req.AssetID, err)
		}
	}

	// ── Phase 7: LRC sidecar ─────────────────────────────────────────────
	if req.Options.SaveLrcSidecar && lrcStr != "" {
		lrcExt := req.Options.LrcFormat
		if lrcExt == "" {
			lrcExt = "lrc"
		}
		lrcPath := strings.TrimSuffix(finalPath, filepath.Ext(finalPath)) + "." + lrcExt
		_ = os.WriteFile(lrcPath, []byte(lrcStr), 0o644)
	}

	// ── Phase 8: Format conversion (optional) ────────────────────────────
	if req.Options.ConvertToFLAC && req.Capabilities.Lossless {
		flacTmp := tmpPath + ".flac"
		if err := convertToFLAC(tmpPath, flacTmp, req.Options.FFmpegPath); err != nil {
			fmt.Printf("export %s: flac conversion failed: %v — keeping .m4a\n", req.AssetID, err)
			finalPath = strings.TrimSuffix(finalPath, ".flac") + ".m4a"
		} else {
			if !req.Options.KeepOriginal {
				os.Remove(tmpPath) //nolint:errcheck
			}
			tmpPath = flacTmp
		}
	}

	// ── Phase 9: Move temp → final ────────────────────────────────────────
	m.advance(job, PhaseMoving, 96)

	if err := os.Rename(tmpPath, finalPath); err != nil {
		// Cross-device move: fall back to copy+delete.
		if err2 := copyFile(tmpPath, finalPath); err2 != nil {
			os.Remove(tmpPath) //nolint:errcheck
			m.fail(job, fmt.Errorf("move to %s: %w", finalPath, err2))
			return
		}
		os.Remove(tmpPath) //nolint:errcheck
	}

	m.setOutput(job, finalPath)
	m.advance(job, PhaseDone, 100)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (m *Manager) advance(job *ExportJob, phase Phase, pct int) {
	m.mu.Lock()
	job.Phase = phase
	job.Percent = pct
	job.UpdatedAt = time.Now()
	m.mu.Unlock()
	m.emit(job, pct, "")
}

func (m *Manager) fail(job *ExportJob, err error) {
	m.mu.Lock()
	job.Phase = PhaseFailed
	job.Error = err.Error()
	job.UpdatedAt = time.Now()
	m.mu.Unlock()
	m.emit(job, 0, err.Error())
}

func (m *Manager) setOutput(job *ExportJob, path string) {
	m.mu.Lock()
	job.Output = path
	job.UpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *Manager) emit(job *ExportJob, pct int, errMsg string) {
	if m.sink == nil {
		return
	}
	m.mu.RLock()
	ev := ExportEvent{
		JobID:   job.ID,
		AssetID: job.AssetID,
		Phase:   job.Phase,
		Percent: pct,
		Output:  job.Output,
		Error:   errMsg,
	}
	m.mu.RUnlock()
	m.sink(ev)
}

func newExportID() string {
	b := make([]byte, 6)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	if err != nil {
		return err
	}
	return out.Close()
}

// convertToFLAC invokes ffmpeg to transcode src (ALAC .m4a) to dst (.flac).
func convertToFLAC(src, dst, ffmpegPath string) error {
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}
	// ffmpeg is an external dependency; check it exists before starting.
	// We construct the command but do not import os/exec directly here to keep
	// the dependency explicit.  The actual invocation is in ffmpeg.go.
	if err := runFFmpeg(ffmpegPath, src, dst); err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	return nil
}

// errFFmpegUnavailable is returned when ffmpeg is not on PATH.
var errFFmpegUnavailable = errors.New("ffmpeg not found; install ffmpeg or set FFmpegPath")
