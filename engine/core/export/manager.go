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
	"sync/atomic"
	"time"

	"engine/core/pipeline"
	"engine/core/playback"
	"engine/utils/ampapi"
	"engine/utils/lyrics"
)

const (
	// defaultArtworkSize is the square pixel dimension requested from Apple CDN.
	defaultArtworkSize = 3000
)

// EventSink receives export progress events.  apiserver.go injects an
// implementation that forwards them to SSE clients.
type EventSink func(ev ExportEvent)

// Manager enqueues and executes export jobs one at a time in FIFO order.
// It is safe for concurrent use.
type Manager struct {
	mu       sync.RWMutex
	jobs     map[string]*ExportJob
	requests map[string]ExportRequest // original request per job, for Retry
	queue    chan *workItem
	sink     EventSink
	manager  *playback.Manager
	seq      atomic.Int64 // monotonically increasing enqueue counter
}

type workItem struct {
	job *ExportJob
	req ExportRequest
	ctx context.Context
}

// NewManager creates an ExportManager that acquires media through pm and
// notifies ev on each state transition. Jobs are processed one at a time
// in the order they were enqueued.
func NewManager(pm *playback.Manager, ev EventSink, _ int) *Manager {
	m := &Manager{
		jobs:     make(map[string]*ExportJob),
		requests: make(map[string]ExportRequest),
		queue:    make(chan *workItem, 256),
		sink:     ev,
		manager:  pm,
	}
	go m.worker()
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
		ID:         newExportID(),
		AssetID:    req.AssetID,
		Phase:      PhaseQueued,
		QueuePos:   m.seq.Add(1),
		Title:      req.HintTitle,
		ArtistName: req.HintArtist,
		ArtworkURL: req.HintArtwork,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
		cancel:     cancel,
	}

	m.mu.Lock()
	m.jobs[job.ID] = job
	m.requests[job.ID] = req
	m.mu.Unlock()

	m.queue <- &workItem{job: job, req: req, ctx: jobCtx}
	m.emit(job, 0, "")
	return job, nil
}

// worker processes items from the queue one at a time in FIFO order.
func (m *Manager) worker() {
	for item := range m.queue {
		m.execute(item)
	}
}

// Get returns a snapshot of a job's current state, or (nil, false) if unknown.
// Returns a copy so the caller can safely serialise it without holding the lock.
func (m *Manager) Get(id string) (*ExportJob, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[id]
	if !ok {
		return nil, false
	}
	cp := *j
	return &cp, true
}

// List returns snapshots of all known jobs.
// Returns copies so callers can safely serialise them without holding the lock.
func (m *Manager) List() []*ExportJob {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*ExportJob, 0, len(m.jobs))
	for _, j := range m.jobs {
		cp := *j
		out = append(out, &cp)
	}
	return out
}

// Cancel cancels or removes a job by id.
// For in-progress jobs (queued/resolving/downloading/tagging/moving) it
// signals cancellation and leaves the row visible so the UI can show the
// cancelled state.  For terminal jobs (done/failed/cancelled) it removes the
// job from the map entirely — this is what the "Clear done" button uses.
// Returns false if the job is not found.
func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return false
	}
	phase := j.Phase
	switch phase {
	case PhaseDone, PhaseFailed, PhaseCancelled:
		delete(m.jobs, id)
		delete(m.requests, id)
		m.mu.Unlock()
	default:
		m.mu.Unlock()
		j.cancel()
	}
	return true
}

// Retry re-enqueues the original request for a failed or cancelled job.
// Returns (newJob, true) on success, or (nil, false) if the job is unknown
// or not in a retryable state (failed or cancelled).
func (m *Manager) Retry(id string) (*ExportJob, bool) {
	m.mu.RLock()
	j, ok := m.jobs[id]
	req, hasReq := m.requests[id]
	var phase Phase
	if j != nil {
		phase = j.Phase
	}
	m.mu.RUnlock()

	if !ok || !hasReq {
		return nil, false
	}
	if phase != PhaseFailed && phase != PhaseCancelled {
		return nil, false
	}
	newJob, err := m.Enqueue(req)
	if err != nil {
		return nil, false
	}
	return newJob, true
}

// resolvedAttrs holds normalized track metadata populated from either the
// music-video or song catalog API response.
type resolvedAttrs struct {
	trackName, artistName, albumName string
	artworkURL, genreStr             string
	releaseDate, contentRating       string
	composerName, isrc               string
	audioTraits                      []string
	durationMs, trackNumber          int
	discNumber, trackTotal           int
	copyright, recordLabel, upc      string
	hasLyrics, isMastered            bool
}

// fetchVideoAttrs resolves track metadata from the music-video API.
func fetchVideoAttrs(ctx context.Context, sf, assetID, lang, token string, opts ExportOptions) (resolvedAttrs, error) {
	mv, err := ampapi.GetMusicVideoRespContext(ctx, sf, assetID, lang, token)
	if err != nil || len(mv.Data) == 0 {
		return resolvedAttrs{}, fmt.Errorf("music video %s not found in %s: %w", assetID, sf, err)
	}
	a := mv.Data[0].Attributes
	ra := resolvedAttrs{
		trackName:      a.Name,
		artistName:     a.ArtistName,
		albumName:      a.AlbumName,
		artworkURL:     a.Artwork.URL,
		durationMs:     a.DurationInMillis,
		isrc:           a.Isrc,
		trackNumber:    a.TrackNumber,
		discNumber:     a.DiscNumber,
		releaseDate:    a.ReleaseDate,
		contentRating:  a.ContentRating,
		hasLyrics:      opts.EmbedLyrics || opts.SaveLrcSidecar,
	}
	if len(a.GenreNames) > 0 {
		ra.genreStr = a.GenreNames[0]
	}
	if len(mv.Data[0].Relationships.Albums.Data) > 0 {
		al := mv.Data[0].Relationships.Albums.Data[0].Attributes
		ra.trackTotal = al.TrackCount
		ra.copyright = al.Copyright
		ra.recordLabel = al.RecordLabel
		ra.upc = al.Upc
	}
	return ra, nil
}

// fetchSongAttrsOrExpand resolves song metadata, or expands an album/single
// into per-track jobs. Returns (attrs, true, nil) when the asset was expanded
// (caller should return immediately), (attrs, false, nil) on success,
// or (zero, false, err) on failure.
func (m *Manager) fetchSongAttrsOrExpand(ctx context.Context, sf string, req ExportRequest, job *ExportJob, lang string) (resolvedAttrs, bool, error) {
	song, err := ampapi.GetSongRespContext(ctx, sf, req.AssetID, lang, req.Token)
	if err != nil || len(song.Data) == 0 {
		album, aerr := ampapi.GetAlbumRespContext(ctx, sf, req.AssetID, lang, req.Token)
		if aerr == nil && len(album.Data) > 0 && len(album.Data[0].Relationships.Tracks.Data) > 0 {
			for _, track := range album.Data[0].Relationships.Tracks.Data {
				if track.Type != "songs" && track.Type != "music-videos" {
					continue
				}
				trackReq := req
				trackReq.AssetID = track.ID
				if track.Type == "music-videos" {
					trackReq.Capabilities.Video = true
				}
				m.Enqueue(trackReq) //nolint:errcheck
			}
			m.mu.Lock()
			delete(m.jobs, job.ID)
			delete(m.requests, job.ID)
			m.mu.Unlock()
			return resolvedAttrs{}, true, nil
		}
		return resolvedAttrs{}, false, fmt.Errorf("song %s not found in %s: %w", req.AssetID, sf, err)
	}
	a := song.Data[0].Attributes
	ra := resolvedAttrs{
		trackName:     a.Name,
		artistName:    a.ArtistName,
		albumName:     a.AlbumName,
		artworkURL:    a.Artwork.URL,
		durationMs:    a.DurationInMillis,
		isrc:          a.Isrc,
		trackNumber:   a.TrackNumber,
		discNumber:    a.DiscNumber,
		releaseDate:   a.ReleaseDate,
		contentRating: a.ContentRating,
		composerName:  a.ComposerName,
		hasLyrics:     a.HasLyrics,
		audioTraits:   a.AudioTraits,
		isMastered:    a.IsMasteredForItunes || a.IsAppleDigitalMaster,
	}
	if len(a.GenreNames) > 0 {
		ra.genreStr = a.GenreNames[0]
	}
	if len(song.Data[0].Relationships.Albums.Data) > 0 {
		al := song.Data[0].Relationships.Albums.Data[0].Attributes
		ra.trackTotal = al.TrackCount
		ra.copyright = al.Copyright
		ra.recordLabel = al.RecordLabel
		ra.upc = al.Upc
	}
	return ra, false, nil
}

// deriveCodecExt returns codec label and file extension for the export capabilities.
func deriveCodecExt(cap ExportCapabilities, opts ExportOptions) (codec, ext string) {
	codec, ext = "aac", "m4a"
	switch {
	case cap.Video:
		codec, ext = "mv", "mp4"
	case cap.Atmos:
		codec = "atmos"
	case cap.Lossless:
		codec = "alac"
	}
	if opts.ConvertToFLAC && cap.Lossless && !cap.Video {
		ext = "flac"
	}
	return codec, ext
}

// deriveQuality returns the quality label for template and display use.
func deriveQuality(cap ExportCapabilities, audioTraits []string) string {
	switch {
	case cap.Video:
		return "MV"
	case cap.Atmos:
		return "Atmos"
	case cap.Lossless:
		for _, t := range audioTraits {
			if t == "hi-res-lossless" {
				return "Hi-Res Lossless"
			}
		}
		return "Lossless"
	default:
		return "AAC"
	}
}

// bitrateForCapabilities returns a conservative bytes-per-millisecond estimate.
func bitrateForCapabilities(cap ExportCapabilities) int64 {
	switch {
	case cap.Video:
		return 8_000_000 / 8_000 // ~1 MB/s
	case cap.Atmos:
		return 768_000 / 8_000 // ~96 B/ms
	case cap.Lossless:
		return 1_500_000 / 8_000 // ~188 B/ms
	default:
		return 256_000 / 8_000 // ~32 B/ms
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

	// ── Playlist expansion (before per-track resolution) ─────────────────
	if m.expandCollection(ctx, req, job, sf, lang) {
		return
	}

	var ra resolvedAttrs
	if req.Capabilities.Video {
		var err error
		ra, err = fetchVideoAttrs(ctx, sf, req.AssetID, lang, req.Token, req.Options)
		if err != nil {
			m.fail(job, err)
			return
		}
	} else {
		var expanded bool
		var err error
		ra, expanded, err = m.fetchSongAttrsOrExpand(ctx, sf, req, job, lang)
		if expanded {
			return
		}
		if err != nil {
			m.fail(job, err)
			return
		}
	}

	codec, ext := deriveCodecExt(req.Capabilities, req.Options)

	m.mu.Lock()
	job.Title = ra.trackName
	job.ArtistName = ra.artistName
	job.ArtworkURL = ra.artworkURL
	m.mu.Unlock()

	meta := TrackMeta{
		Title:         ra.trackName,
		ArtistName:    ra.artistName,
		AlbumArtist:   ra.artistName,
		AlbumName:     ra.albumName,
		TrackNumber:   ra.trackNumber,
		TrackTotal:    ra.trackTotal,
		DiscNumber:    ra.discNumber,
		ReleaseDate:   ra.releaseDate,
		Genre:         ra.genreStr,
		Composer:      ra.composerName,
		Copyright:     ra.copyright,
		RecordLabel:   ra.recordLabel,
		Isrc:          ra.isrc,
		UPC:           ra.upc,
		ContentRating: ra.contentRating,
		DurationMs:    ra.durationMs,
		ArtworkURL:    ra.artworkURL,
		HasLyrics:     ra.hasLyrics,
	}

	quality := deriveQuality(req.Capabilities, ra.audioTraits)

	// Derive {tag} from ContentRating + Apple Digital Master flag.
	tag := ""
	switch ra.contentRating {
	case "explicit":
		tag = req.Options.ExplicitChoice
	case "clean":
		tag = req.Options.CleanChoice
	}
	if ra.isMastered {
		tag += req.Options.MasterChoice
	}

	vars := templateVar{
		Title:       ra.trackName,
		Artist:      ra.artistName,
		AlbumArtist: ra.artistName,
		Album:       ra.albumName,
		TrackNumber: ra.trackNumber,
		DiscNumber:  ra.discNumber,
		Year:        yearFromDate(ra.releaseDate),
		Genre:       ra.genreStr,
		Quality:     quality,
		Tag:         tag,
		ReleaseDate: ra.releaseDate,
		Isrc:        ra.isrc,
		SongID:      req.AssetID,
		URLArtist:   slugify(ra.artistName),
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

	if ra.durationMs > 0 {
		m.mu.Lock()
		job.BytesTotal = int64(ra.durationMs) * bitrateForCapabilities(req.Capabilities)
		m.mu.Unlock()
	}

	tmpPath, ok := m.downloadToTemp(ctx, req, job, sf, lang, finalPath, ra.durationMs)
	if !ok {
		return
	}

	ppCtx := context.WithoutCancel(ctx)
	go m.runPostProcess(ppCtx, req, job, meta, tmpPath, finalPath)
}

// downloadToTemp opens a playback session, streams to a temp file, and returns
// the temp file path. Returns ("", false) on any error (already called m.fail).
func (m *Manager) downloadToTemp(ctx context.Context, req ExportRequest, job *ExportJob, sf, lang, finalPath string, durationMs int) (string, bool) {
	if durationMs > 0 {
		var bitsPerSec int64
		switch {
		case req.Capabilities.Video:
			bitsPerSec = 8_000_000
		case req.Capabilities.Atmos:
			bitsPerSec = 768_000
		case req.Capabilities.Lossless:
			bitsPerSec = 1_500_000
		default:
			bitsPerSec = 256_000
		}
		m.mu.Lock()
		job.BytesTotal = int64(durationMs) * bitsPerSec / 8_000
		m.mu.Unlock()
	}

	sess, err := m.manager.Open(ctx, playback.OpenRequest{
		AssetID:     req.AssetID,
		Storefront:  sf,
		Token:       req.Token,
		MUT:         req.MUT,
		Language:    lang,
		Lossless:    req.Capabilities.Lossless,
		Atmos:       req.Capabilities.Atmos,
		Video:       req.Capabilities.Video,
		MVMaxHeight: req.MVMaxHeight,
	})
	if err != nil {
		m.fail(job, fmt.Errorf("open session: %w", err))
		return "", false
	}

	if err := ensureDir(filepath.Dir(finalPath)); err != nil {
		m.manager.Release(sess.ID)
		m.fail(job, fmt.Errorf("mkdir %s: %w", filepath.Dir(finalPath), err))
		return "", false
	}
	tmpPath := filepath.Join(filepath.Dir(finalPath), "."+job.ID+".am-export.tmp")

	if req.Capabilities.Video {
		if err := m.streamVideoAudio(ctx, req, job, sess.ID, tmpPath); err != nil {
			return "", false
		}
	} else {
		var buf bytes.Buffer
		pw := &progressWriter{w: &buf, mu: &m.mu, job: job}
		if err := m.manager.Stream(ctx, sess.ID, pipeline.KindAudio, pw); err != nil {
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("stream: %w", err))
			return "", false
		}
		m.manager.Release(sess.ID)
		if err := os.WriteFile(tmpPath, buf.Bytes(), 0o644); err != nil {
			m.fail(job, fmt.Errorf("write temp: %w", err))
			return "", false
		}
	}
	return tmpPath, true
}

// streamVideoAudio streams video+audio tracks to separate temp files, muxes them,
// and leaves the result at tmpPath. Returns error (already called m.fail) on failure.
func (m *Manager) streamVideoAudio(ctx context.Context, req ExportRequest, job *ExportJob, sessID, tmpPath string) error {
	videoTmp := tmpPath + ".video"
	vf, err := os.Create(videoTmp)
	if err != nil {
		m.manager.Release(sessID)
		m.fail(job, fmt.Errorf("create video tmp: %w", err))
		return err
	}
	vpw := &progressWriter{w: vf, mu: &m.mu, job: job}
	if err := m.manager.Stream(ctx, sessID, pipeline.KindVideo, vpw); err != nil {
		vf.Close()
		os.Remove(videoTmp)
		m.manager.Release(sessID)
		m.fail(job, fmt.Errorf("stream video: %w", err))
		return err
	}
	vf.Close()

	audioTmp := tmpPath + ".audio"
	af, err := os.Create(audioTmp)
	if err != nil {
		os.Remove(videoTmp)
		m.manager.Release(sessID)
		m.fail(job, fmt.Errorf("create audio tmp: %w", err))
		return err
	}
	if err := m.manager.Stream(ctx, sessID, pipeline.KindAudio, af); err != nil {
		af.Close()
		os.Remove(videoTmp)
		os.Remove(audioTmp)
		m.manager.Release(sessID)
		m.fail(job, fmt.Errorf("stream audio: %w", err))
		return err
	}
	af.Close()
	m.manager.Release(sessID)

	ffPath := req.Options.FFmpegPath
	if ffPath == "" {
		ffPath = "ffmpeg"
	}
	if err := muxVideoAudio(ffPath, videoTmp, audioTmp, tmpPath); err != nil {
		os.Remove(videoTmp)
		os.Remove(audioTmp)
		m.fail(job, fmt.Errorf("mux video+audio: %w (ffmpeg required)", err))
		return err
	}
	os.Remove(videoTmp)
	os.Remove(audioTmp)
	return nil
}

// fetchMVLyrics fetches TTML lyrics for a music video, embeds a subtitle track
// into tmpPath if possible, and returns the sidecar string in the requested format.
func fetchMVLyrics(ctx context.Context, sf, assetID, lang, token, mut, tmpPath string, opts ExportOptions) string {
	ttml, lerr := lyrics.GetContext(ctx, sf, assetID, opts.LrcType, lang, "ttml", token, mut)
	if lerr != nil || ttml == "" {
		return ""
	}
	srtStr, _ := lyrics.TtmlToSrt(ttml)
	if srtStr != "" {
		srtTmp := tmpPath + ".srt"
		if werr := os.WriteFile(srtTmp, []byte(srtStr), 0o644); werr == nil {
			ffPath := opts.FFmpegPath
			if ffPath == "" {
				ffPath = "ffmpeg"
			}
			if serr := addSubtitleTrack(ffPath, tmpPath, srtTmp); serr != nil {
				fmt.Printf("export %s: subtitle embed warning: %v\n", assetID, serr)
			}
			os.Remove(srtTmp)
		}
	}
	switch opts.LrcFormat {
	case "ttml":
		return ttml
	case "srt":
		return srtStr
	case "vtt":
		vtt, _ := lyrics.TtmlToVtt(ttml)
		return vtt
	default:
		lrc, _ := lyrics.TtmlToLrc(ttml)
		return lrc
	}
}

func (m *Manager) runPostProcess(ctx context.Context, req ExportRequest, job *ExportJob, meta TrackMeta, tmpPath, finalPath string) {
	defer func() {
		if r := recover(); r != nil {
			m.fail(job, fmt.Errorf("post-process panic: %v", r))
		}
	}()
	sf := req.Storefront
	if sf == "" {
		sf = "us"
	}
	lang := req.Language
	if lang == "" {
		lang = "en-US"
	}
	m.advance(job, PhaseTagging, 80)

		// ── Phase 5: Fetch lyrics if requested ───────────────────────────
		var lrcStr string
		if (req.Options.EmbedLyrics || req.Options.SaveLrcSidecar) && meta.HasLyrics {
			if req.Capabilities.Video {
				lrcStr = fetchMVLyrics(ctx, sf, req.AssetID, lang, req.Token, req.MUT, tmpPath, req.Options)
			} else {
				lrcStr, _ = lyrics.GetContext(ctx,
					sf, req.AssetID,
					req.Options.LrcType, lang, req.Options.LrcFormat,
					req.Token, req.MUT,
				)
			}
		}

		// ── Phase 6: Tag (metadata, artwork, lyrics) ──────────────────────
		if !req.Capabilities.Video {
			if err := TagFile(tmpPath, meta, TagOptions{
				EmbedArtwork: req.Options.EmbedArtwork,
				ArtworkSize:  req.Options.ArtworkSize,
				Lyrics:       lrcStr,
			}); err != nil {
				fmt.Printf("export %s: tag warning: %v\n", req.AssetID, err)
			}
		}

		// ── Phase 7: LRC sidecar ─────────────────────────────────────────
		if req.Options.SaveLrcSidecar && lrcStr != "" {
			lrcExt := req.Options.LrcFormat
			if lrcExt == "" {
				lrcExt = "lrc"
			}
			lrcPath := strings.TrimSuffix(finalPath, filepath.Ext(finalPath)) + "." + lrcExt
			_ = os.WriteFile(lrcPath, []byte(lrcStr), 0o644)
		}

		// ── Phase 8: Format conversion (optional) ────────────────────────
		if req.Options.ConvertToFLAC && req.Capabilities.Lossless && !req.Capabilities.Video {
			tmpPath, finalPath = convertFLAC(req, meta, tmpPath, finalPath)
		}

		// ── Phase 9: Move temp → final ────────────────────────────────────
		m.advance(job, PhaseMoving, 96)
		if err := os.Rename(tmpPath, finalPath); err != nil {
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

// expandCollection handles playlist and library-playlist expansion. Returns true
// when the job was a collection router (caller should return immediately).
func (m *Manager) expandCollection(ctx context.Context, req ExportRequest, job *ExportJob, sf, lang string) bool {
	if !req.Capabilities.Playlist {
		return false
	}
	if req.Capabilities.LibraryPlaylist {
		tracks, err := ampapi.GetLibraryPlaylistTracksContext(ctx, req.AssetID, lang, req.Token, req.MUT)
		if err != nil || len(tracks.Data) == 0 {
			m.fail(job, fmt.Errorf("library playlist %s: %w", req.AssetID, err))
			return true
		}
		for _, track := range tracks.Data {
			catalogID := track.Attributes.PlayParams.CatalogId
			if catalogID == "" {
				continue
			}
			trackReq := req
			trackReq.AssetID = catalogID
			trackReq.Capabilities.Playlist = false
			trackReq.Capabilities.LibraryPlaylist = false
			if track.Type == "library-music-videos" {
				trackReq.Capabilities.Video = true
			}
			m.Enqueue(trackReq) //nolint:errcheck
		}
	} else {
		pl, err := ampapi.GetPlaylistRespContext(ctx, sf, req.AssetID, lang, req.Token, req.MUT)
		if err != nil || len(pl.Data) == 0 || len(pl.Data[0].Relationships.Tracks.Data) == 0 {
			m.fail(job, fmt.Errorf("playlist %s: %w", req.AssetID, err))
			return true
		}
		for _, track := range pl.Data[0].Relationships.Tracks.Data {
			if track.Type != "songs" && track.Type != "music-videos" {
				continue
			}
			trackReq := req
			trackReq.AssetID = track.ID
			trackReq.Capabilities.Playlist = false
			if track.Type == "music-videos" {
				trackReq.Capabilities.Video = true
			}
			m.Enqueue(trackReq) //nolint:errcheck
		}
	}
	m.mu.Lock()
	delete(m.jobs, job.ID)
	delete(m.requests, job.ID)
	m.mu.Unlock()
	return true
}

// convertFLAC converts tmpPath (ALAC fMP4) to FLAC, returning the updated
// tmpPath and finalPath. Prefers VLC decode → ffmpeg tag; falls back to
// ffmpeg all-in-one.
func convertFLAC(req ExportRequest, meta TrackMeta, tmpPath, finalPath string) (string, string) {
	flacTmp := tmpPath + ".flac"
	ffpathFlac := req.Options.FFmpegPath
	if ffpathFlac == "" {
		ffpathFlac = "ffmpeg"
	}
	vlcBin, hasVLC := findVLC(req.Options.VLCPath)
	converted := false
	if hasVLC {
		rawFlac := flacTmp + ".raw.flac"
		if err := runVLCToFLAC(vlcBin, tmpPath, rawFlac); err != nil {
			fmt.Printf("export %s: vlc transcode failed: %v — trying ffmpeg\n", req.AssetID, err)
			os.Remove(rawFlac) //nolint:errcheck
		} else {
			artArg := downloadArtworkToTemp(req, meta, rawFlac)
			if tagErr := tagFLAC(ffpathFlac, rawFlac, artArg, flacTmp, meta); tagErr != nil {
				fmt.Printf("export %s: flac tag failed: %v — retrying without art\n", req.AssetID, tagErr)
				os.Remove(flacTmp) //nolint:errcheck
				if tagErr2 := tagFLAC(ffpathFlac, rawFlac, "", flacTmp, meta); tagErr2 != nil {
					fmt.Printf("export %s: flac tag failed (no art): %v — keeping raw\n", req.AssetID, tagErr2)
					if renErr := os.Rename(rawFlac, flacTmp); renErr != nil {
						os.Remove(rawFlac) //nolint:errcheck
					}
				} else {
					os.Remove(rawFlac) //nolint:errcheck
				}
			} else {
				os.Remove(rawFlac) //nolint:errcheck
			}
			if artArg != "" {
				os.Remove(artArg) //nolint:errcheck
			}
			if !req.Options.KeepOriginal {
				os.Remove(tmpPath) //nolint:errcheck
			}
			tmpPath = flacTmp
			converted = true
		}
	}
	if !converted {
		if err := runFFmpeg(ffpathFlac, tmpPath, "", flacTmp, meta); err != nil {
			fmt.Printf("export %s: flac conversion failed: %v — keeping .m4a\n", req.AssetID, err)
			finalPath = strings.TrimSuffix(finalPath, ".flac") + ".m4a"
		} else {
			if !req.Options.KeepOriginal {
				os.Remove(tmpPath) //nolint:errcheck
			}
			tmpPath = flacTmp
		}
	}
	return tmpPath, finalPath
}

// downloadArtworkToTemp downloads artwork to a temp file alongside rawFlac and
// returns its path (empty string if skipped or failed).
func downloadArtworkToTemp(req ExportRequest, meta TrackMeta, rawFlac string) string {
	if !req.Options.EmbedArtwork || meta.ArtworkURL == "" {
		return ""
	}
	artTmp := rawFlac + ".art.jpg"
	artBytes, _, err := downloadArtworkBytes(meta.ArtworkURL, req.Options.ArtworkSize)
	if err != nil {
		return ""
	}
	if err := os.WriteFile(artTmp, artBytes, 0o644); err != nil {
		return ""
	}
	return artTmp
}

// progressWriter wraps an io.Writer and updates job.BytesDone + Percent on
// each write so the UI can show live byte-based download progress.
type progressWriter struct {
	w   io.Writer
	mu  *sync.RWMutex
	job *ExportJob
}

func (pw *progressWriter) Write(p []byte) (int, error) {
	n, err := pw.w.Write(p)
	if n > 0 {
		pw.mu.Lock()
		pw.job.BytesDone += int64(n)
		if total := pw.job.BytesTotal; total > 0 {
			pct := int(pw.job.BytesDone * 79 / total)
			if pct > 79 {
				pct = 79
			}
			pw.job.Percent = pct
		}
		pw.mu.Unlock()
	}
	return n, err
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
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// errFFmpegUnavailable is returned when ffmpeg is not on PATH.
var errFFmpegUnavailable = errors.New("ffmpeg not found; install ffmpeg or set FFmpegPath")
