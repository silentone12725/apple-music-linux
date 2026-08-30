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
	if req.Capabilities.Playlist {
		if req.Capabilities.LibraryPlaylist {
			// Library playlists (p.xxx) need the /me/library/playlists API.
			tracks, err := ampapi.GetLibraryPlaylistTracksContext(ctx, req.AssetID, lang, req.Token, req.MUT)
			if err != nil || len(tracks.Data) == 0 {
				m.fail(job, fmt.Errorf("library playlist %s: %w", req.AssetID, err))
				return
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
				return
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
		// Playlist expansion is complete — remove the routing job so the UI
		// only shows per-track jobs.
		m.mu.Lock()
		delete(m.jobs, job.ID)
		delete(m.requests, job.ID)
		m.mu.Unlock()
		return
	}

	// Normalized track attributes — filled from song or music-video API below.
	var (
		trackName     string
		artistName    string
		albumName     string
		artworkURL    string
		genreStr      string
		durationMs    int
		isrc          string
		trackNumber   int
		discNumber    int
		releaseDate   string
		contentRating string
		composerName  string
		hasLyrics     bool
		audioTraits   []string
		isMastered    bool
	)

	var trackTotal int
	var copyright, recordLabel, upc string

	if req.Capabilities.Video {
		mv, err := ampapi.GetMusicVideoRespContext(ctx, sf, req.AssetID, lang, req.Token)
		if err != nil || len(mv.Data) == 0 {
			m.fail(job, fmt.Errorf("music video %s not found in %s: %w", req.AssetID, sf, err))
			return
		}
		a := mv.Data[0].Attributes
		trackName, artistName, albumName = a.Name, a.ArtistName, a.AlbumName
		artworkURL = a.Artwork.URL
		if len(a.GenreNames) > 0 {
			genreStr = a.GenreNames[0]
		}
		durationMs, isrc = a.DurationInMillis, a.Isrc
		trackNumber, discNumber = a.TrackNumber, a.DiscNumber
		releaseDate, contentRating = a.ReleaseDate, a.ContentRating
		// MV API does not return HasLyrics; try fetching if user requested lyrics output.
		hasLyrics = req.Options.EmbedLyrics || req.Options.SaveLrcSidecar

		if len(mv.Data[0].Relationships.Albums.Data) > 0 {
			al := mv.Data[0].Relationships.Albums.Data[0].Attributes
			trackTotal = al.TrackCount
			copyright = al.Copyright
			recordLabel = al.RecordLabel
			upc = al.Upc
		}
	} else {
		song, err := ampapi.GetSongRespContext(ctx, sf, req.AssetID, lang, req.Token)
		if err != nil || len(song.Data) == 0 {
			// Try as an album/single — if it has tracks, expand to per-song jobs.
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
				// Album expansion job is a routing artifact — remove it from the
				// list so the UI only shows the per-track jobs.
				m.mu.Lock()
				delete(m.jobs, job.ID)
				delete(m.requests, job.ID)
				m.mu.Unlock()
				return
			}
			m.fail(job, fmt.Errorf("song %s not found in %s: %w", req.AssetID, sf, err))
			return
		}
		a := song.Data[0].Attributes
		trackName, artistName, albumName = a.Name, a.ArtistName, a.AlbumName
		artworkURL = a.Artwork.URL
		if len(a.GenreNames) > 0 {
			genreStr = a.GenreNames[0]
		}
		durationMs, isrc = a.DurationInMillis, a.Isrc
		trackNumber, discNumber = a.TrackNumber, a.DiscNumber
		releaseDate, contentRating = a.ReleaseDate, a.ContentRating
		composerName, hasLyrics, audioTraits = a.ComposerName, a.HasLyrics, a.AudioTraits
		isMastered = a.IsMasteredForItunes || a.IsAppleDigitalMaster

		if len(song.Data[0].Relationships.Albums.Data) > 0 {
			al := song.Data[0].Relationships.Albums.Data[0].Attributes
			trackTotal = al.TrackCount
			copyright = al.Copyright
			recordLabel = al.RecordLabel
			upc = al.Upc
		}
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
	// Only change the extension to FLAC for audio-only lossless exports.
	// Video exports are muxed into MP4; forcing ".flac" here can produce a
	// temp filename without a standard container extension and cause
	// ffmpeg to fail choosing an output format.
	if req.Options.ConvertToFLAC && req.Capabilities.Lossless && !req.Capabilities.Video {
		ext = "flac"
	}

	m.mu.Lock()
	job.Title = trackName
	job.ArtistName = artistName
	job.ArtworkURL = artworkURL
	m.mu.Unlock()

	meta := TrackMeta{
		Title:         trackName,
		ArtistName:    artistName,
		AlbumArtist:   artistName,
		AlbumName:     albumName,
		TrackNumber:   trackNumber,
		TrackTotal:    trackTotal,
		DiscNumber:    discNumber,
		ReleaseDate:   releaseDate,
		Genre:         genreStr,
		Composer:      composerName,
		Copyright:     copyright,
		RecordLabel:   recordLabel,
		Isrc:          isrc,
		UPC:           upc,
		ContentRating: contentRating,
		DurationMs:    durationMs,
		ArtworkURL:    artworkURL,
		HasLyrics:     hasLyrics,
	}

	// Derive {quality} from capabilities + audio traits
	quality := "AAC"
	switch {
	case req.Capabilities.Video:
		quality = "MV"
	case req.Capabilities.Atmos:
		quality = "Atmos"
	case req.Capabilities.Lossless:
		quality = "Lossless"
		for _, t := range audioTraits {
			if t == "hi-res-lossless" {
				quality = "Hi-Res Lossless"
				break
			}
		}
	}

	// Derive {tag} from ContentRating + Apple Digital Master flag.
	// Empty choice string means the marker is disabled by the client.
	tag := ""
	switch contentRating {
	case "explicit":
		tag = req.Options.ExplicitChoice
	case "clean":
		tag = req.Options.CleanChoice
	}
	if isMastered {
		tag += req.Options.MasterChoice
	}

	vars := templateVar{
		Title:       trackName,
		Artist:      artistName,
		AlbumArtist: artistName,
		Album:       albumName,
		TrackNumber: trackNumber,
		DiscNumber:  discNumber,
		Year:        yearFromDate(releaseDate),
		Genre:       genreStr,
		Quality:     quality,
		Tag:         tag,
		ReleaseDate: releaseDate,
		Isrc:        isrc,
		SongID:      req.AssetID,
		URLArtist:   slugify(artistName),
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

	// Estimate total bytes from duration × codec bitrate so the UI can render a
	// determinate progress bar.  The estimate is intentionally conservative so
	// the bar reaches ~100% just as the download finishes rather than stalling.
	if durationMs > 0 {
		var bitsPerSec int64
		switch {
		case req.Capabilities.Video:
			bitsPerSec = 8_000_000 // rough: 1080p MV ≈ 8 Mbps
		case req.Capabilities.Atmos:
			bitsPerSec = 768_000 // Dolby Atmos EC-3 ≈ 768 kbps
		case req.Capabilities.Lossless:
			bitsPerSec = 1_500_000 // ALAC 16/44.1 ≈ 1.5 Mbps (conservative)
		default:
			bitsPerSec = 256_000 // AAC 256 kbps
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
		return
	}

	// ── Phase 3a: Stream to buffer(s) ────────────────────────────────────
	// Music videos need separate video + audio streams muxed together.
	// Audio tracks use an in-memory buffer; video tracks write directly to
	// temp files to avoid holding the full video in RAM.

	if err := ensureDir(filepath.Dir(finalPath)); err != nil {
		m.manager.Release(sess.ID)
		m.fail(job, fmt.Errorf("mkdir %s: %w", filepath.Dir(finalPath), err))
		return
	}
	// Use job ID in tmp path so concurrent post-process goroutines never collide,
	// even when two tracks resolve to the same final filename.
	tmpPath := filepath.Join(filepath.Dir(finalPath), "."+job.ID+".am-export.tmp")

	if req.Capabilities.Video {
		// Stream video track to disk.
		videoTmp := tmpPath + ".video"
		vf, err := os.Create(videoTmp)
		if err != nil {
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("create video tmp: %w", err))
			return
		}
		vpw := &progressWriter{w: vf, mu: &m.mu, job: job}
		if err := m.manager.Stream(ctx, sess.ID, pipeline.KindVideo, vpw); err != nil {
			vf.Close()
			os.Remove(videoTmp)
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("stream video: %w", err))
			return
		}
		vf.Close()

		// Stream audio track to disk.
		audioTmp := tmpPath + ".audio"
		af, err := os.Create(audioTmp)
		if err != nil {
			os.Remove(videoTmp)
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("create audio tmp: %w", err))
			return
		}
		if err := m.manager.Stream(ctx, sess.ID, pipeline.KindAudio, af); err != nil {
			af.Close()
			os.Remove(videoTmp)
			os.Remove(audioTmp)
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("stream audio: %w", err))
			return
		}
		af.Close()
		m.manager.Release(sess.ID)

		// ── Phase 4: Mux video + audio ────────────────────────────────────
		// Mux happens in the post-process goroutine — release already done above.
		ffPath := req.Options.FFmpegPath
		if ffPath == "" {
			ffPath = "ffmpeg"
		}
		if err := muxVideoAudio(ffPath, videoTmp, audioTmp, tmpPath); err != nil {
			os.Remove(videoTmp)
			os.Remove(audioTmp)
			m.fail(job, fmt.Errorf("mux video+audio: %w (ffmpeg required)", err))
			return
		}
		os.Remove(videoTmp)
		os.Remove(audioTmp)
	} else {
		// Audio-only: buffer in memory then write once (allows mp4tag to tag it).
		var buf bytes.Buffer
		pw := &progressWriter{w: &buf, mu: &m.mu, job: job}
		if err := m.manager.Stream(ctx, sess.ID, pipeline.KindAudio, pw); err != nil {
			m.manager.Release(sess.ID)
			m.fail(job, fmt.Errorf("stream: %w", err))
			return
		}
		m.manager.Release(sess.ID) // release DRM session — next download can start now

		if err := os.WriteFile(tmpPath, buf.Bytes(), 0o644); err != nil {
			m.fail(job, fmt.Errorf("write temp: %w", err))
			return
		}
	}

	// ── Phases 5–9: post-process in background ────────────────────────────
	// Tagging/lyrics/move run concurrently with the next download.
	// context.WithoutCancel so a UI cancel doesn't abort an already-written file.
	ppCtx := context.WithoutCancel(ctx)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				m.fail(job, fmt.Errorf("post-process panic: %v", r))
			}
		}()
		m.advance(job, PhaseTagging, 80)

		// ── Phase 5: Fetch lyrics if requested ───────────────────────────
		var lrcStr string
		if (req.Options.EmbedLyrics || req.Options.SaveLrcSidecar) && hasLyrics {
			if req.Capabilities.Video {
				// MV: always fetch TTML so we can embed a subtitle track and
				// also produce the user's preferred sidecar format.
				ttml, lerr := lyrics.GetContext(ppCtx,
					sf, req.AssetID,
					req.Options.LrcType, lang, "ttml",
					req.Token, req.MUT,
				)
				if lerr == nil && ttml != "" {
					// Embed subtitle track (SRT → mov_text) in the muxed MP4.
					var srtStr string
					srtStr, _ = lyrics.TtmlToSrt(ttml)
					if srtStr != "" {
						srtTmp := tmpPath + ".srt"
						if werr := os.WriteFile(srtTmp, []byte(srtStr), 0o644); werr == nil {
							ffPath := req.Options.FFmpegPath
							if ffPath == "" {
								ffPath = "ffmpeg"
							}
							if serr2 := addSubtitleTrack(ffPath, tmpPath, srtTmp); serr2 != nil {
								fmt.Printf("export %s: subtitle embed warning: %v\n", req.AssetID, serr2)
							}
							os.Remove(srtTmp)
						}
					}
					// Prepare sidecar string in user's preferred format.
					switch req.Options.LrcFormat {
					case "ttml":
						lrcStr = ttml
					case "srt":
						lrcStr = srtStr
					case "vtt":
						lrcStr, _ = lyrics.TtmlToVtt(ttml)
					default:
						lrcStr, _ = lyrics.TtmlToLrc(ttml)
					}
				}
			} else {
				lrcStr, _ = lyrics.GetContext(ppCtx,
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
		// Skip FLAC conversion for music-video exports (video tracks).
		if req.Options.ConvertToFLAC && req.Capabilities.Lossless && !req.Capabilities.Video {
			flacTmp := tmpPath + ".flac"
			ffpathFlac := req.Options.FFmpegPath
			if ffpathFlac == "" {
				ffpathFlac = "ffmpeg"
			}

			// Prefer VLC for ALAC→FLAC decode: VLC's native MP4 demuxer processes
			// all fragments in Apple's fMP4 regardless of tfdt timestamps, while
			// ffmpeg's mov demuxer drops fragments with duplicate tfdts.
			vlcBin, hasVLC := findVLC(req.Options.VLCPath)
			converted := false
			if hasVLC {
				// VLC decodes ALAC fMP4 → raw FLAC. VLC's MP4 demuxer handles
				// Apple's identical-tfdt fragments correctly (ffmpeg's mov demuxer
				// does not). The raw FLAC has correct audio but STREAMINFO.total_samples=0;
				// tagFLAC re-encodes it with ffmpeg to fix that and embed tags.
				rawFlac := flacTmp + ".raw.flac"
				if err := runVLCToFLAC(vlcBin, tmpPath, rawFlac); err != nil {
					fmt.Printf("export %s: vlc transcode failed: %v — trying ffmpeg\n", req.AssetID, err)
					os.Remove(rawFlac) //nolint:errcheck
				} else {
					// Download artwork fresh from the Apple CDN URL rather than
					// extracting from the m4a — more reliable across codec variants.
					artTmp := rawFlac + ".art.jpg"
					hasArt := false
					if req.Options.EmbedArtwork && meta.ArtworkURL != "" {
						if artBytes, _, aerr := downloadArtworkBytes(meta.ArtworkURL, req.Options.ArtworkSize); aerr == nil {
							if werr := os.WriteFile(artTmp, artBytes, 0o644); werr == nil {
								hasArt = true
							}
						}
					}
					artArg := ""
					if hasArt {
						artArg = artTmp
					}

					// tagFLAC re-encodes rawFlac → FLAC so ffmpeg writes correct
					// STREAMINFO.total_samples (fixes Duration: N/A) and embeds
					// metadata + artwork in a single pass.
					if tagErr := tagFLAC(ffpathFlac, rawFlac, artArg, flacTmp, meta); tagErr != nil {
						// Artwork embed failed — retry without artwork.
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
					if hasArt {
						os.Remove(artTmp) //nolint:errcheck
					}
					if !req.Options.KeepOriginal {
						os.Remove(tmpPath) //nolint:errcheck
					}
					tmpPath = flacTmp
					converted = true
				}
			}
			if !converted {
				// Fallback: ffmpeg all-in-one (conversion + tagging). Works when
				// the fMP4 has correct monotonic tfdts (AAC path, or patched ALAC).
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
	}()
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
