package main

// apiserver.go — HTTP API adapter for the Apple Music media engine.
//
// This file is the thinnest possible HTTP layer.  All business logic lives in
// engine/playback; this file only:
//   - Parses and validates HTTP requests
//   - Calls the PlaybackManager
//   - Writes HTTP responses
//
// No DRM material, no runv3, no HLS, no key bytes cross this file.
//
// Route map:
//   GET    /api/v1/status                → health check
//   GET    /api/v1/capabilities          → feature flags for frontends
//   GET    /api/v1/events                → SSE push channel
//
//   POST   /api/v1/playback              → create session
//   GET    /api/v1/playback/{id}/audio   → stream audio (ALAC / AAC / Atmos)
//   GET    /api/v1/playback/{id}/video   → stream video (MV only)
//   DELETE /api/v1/playback/{id}         → release session
//   PUT    /api/v1/playback/context      → signal user context; triggers cache warming
//
//   GET    /api/v1/jobs/{id}             → cache-warm job status (debug/progress UI)
//   DELETE /api/v1/jobs/{id}             → cancel cache-warm job (navigation away)
//
//   PUT    /api/v1/cache/config          → push user-configured cache limits
//   GET    /api/v1/cache/stats           → prewarm / persistent cache usage
//   DELETE /api/v1/cache/playback        → clear all pre-warmed sessions
//
//   GET    /api/v1/metadata/{id}?sf=     → track info + available qualities
//   GET    /api/v1/artwork/{id}?sf=&size=
//   GET    /api/v1/lyrics/{id}?sf=

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"apple-music-cli/engine/apple"
	"apple-music-cli/engine/diskcache"
	"apple-music-cli/engine/drm"
	"apple-music-cli/engine/export"
	"apple-music-cli/engine/pipeline"
	"apple-music-cli/engine/playback"
	"apple-music-cli/engine/prefetch"
	"apple-music-cli/engine/vlc"
	"apple-music-cli/utils/ampapi"
	"apple-music-cli/utils/lyrics"
)

// ── Request / response types ──────────────────────────────────────────────────

// PlaybackRequest is the POST /api/v1/playback request body.
type PlaybackRequest struct {
	AssetID    string `json:"assetId"`
	Storefront string `json:"storefront"`
	// Token and MUT are optional per-request overrides for the Apple Music API
	// bearer JWT and media-user-token. When provided they take priority over
	// Config.AuthorizationToken and Config.MediaUserToken. This lets browser
	// renderers (e.g. electron-playback) supply the tokens they already have
	// from MusicKit without requiring them to be hard-coded in config.yaml.
	Token string `json:"token"`
	MUT   string `json:"mediaUserToken"`
	Capabilities struct {
		Lossless bool `json:"lossless"`
		Video    bool `json:"video"`
		Atmos    bool `json:"atmos"`
	} `json:"capabilities"`
}

// StreamInfo describes one available stream quality returned by GET /metadata.
type StreamInfo struct {
	Codec      string `json:"codec"`
	SampleRate int    `json:"sampleRate,omitempty"`
	BitDepth   int    `json:"bitDepth,omitempty"`
	Bitrate    int    `json:"bitrate,omitempty"`
}

// ── Engine epoch ──────────────────────────────────────────────────────────────

// EpochReason is a typed constant for why the engine epoch advanced.
// A distinct type catches category mistakes at compile time and makes call
// sites searchable and metrics-friendly.
type EpochReason string

const (
	EpochEngineStart    EpochReason = "engine-start"
	EpochSessionChanged EpochReason = "session-changed"
	EpochPlaybackReset  EpochReason = "playback-reset"
)

// EpochInfo is an immutable snapshot of the current engine epoch.
// Returning a value type keeps the interface clean and future-proof:
// adding NodeID, EngineVersion, RestartCount, etc. never changes the
// method signature.
type EpochInfo struct {
	Generation uint64      `json:"generation"`
	Reason     EpochReason `json:"reason"`
	Since      time.Time   `json:"since"` // when this epoch began
}

// EngineEpoch tracks the engine's authoritative state generation.
// The event bus reads it; subsystems advance it through engineLifecycle.
type EngineEpoch interface {
	Current() EpochInfo
	Advance(reason EpochReason) EpochInfo
}

type epochManager struct {
	mu   sync.Mutex
	info EpochInfo
}

func newEpochManager() *epochManager {
	// Start at 1 so generation=0 is unambiguously "client has never seen a snapshot".
	return &epochManager{info: EpochInfo{
		Generation: 1,
		Reason:     EpochEngineStart,
		Since:      time.Now(),
	}}
}

func (e *epochManager) Advance(reason EpochReason) EpochInfo {
	e.mu.Lock()
	e.info = EpochInfo{Generation: e.info.Generation + 1, Reason: reason, Since: time.Now()}
	info := e.info
	e.mu.Unlock()
	return info
}

func (e *epochManager) Current() EpochInfo {
	e.mu.Lock()
	info := e.info
	e.mu.Unlock()
	return info
}

// ── Engine lifecycle ──────────────────────────────────────────────────────────

// engineLifecycle is the single coordinator through which subsystems signal
// authoritative engine state changes.  Callers never reference the epoch
// directly; they call named methods, which advance it with the correct reason.
// This keeps epoch semantics in one place as the engine grows.
type engineLifecycle struct {
	epoch          EngineEpoch
	lastDRMSession atomic.Value // stores string; tracks session transitions
}

func newEngineLifecycle(epoch EngineEpoch) *engineLifecycle {
	l := &engineLifecycle{epoch: epoch}
	l.lastDRMSession.Store("")
	return l
}

// OnDRMStateChanged advances the epoch when the DRM session string changes.
// Idempotent — repeated calls with the same value are no-ops.
func (l *engineLifecycle) OnDRMStateChanged(sessionStr string) {
	if prev, _ := l.lastDRMSession.Load().(string); sessionStr != prev {
		l.lastDRMSession.Store(sessionStr)
		l.epoch.Advance(EpochSessionChanged)
	}
}

// OnPlaybackReset advances the epoch when the playback graph is rebuilt.
func (l *engineLifecycle) OnPlaybackReset() { l.epoch.Advance(EpochPlaybackReset) }

// ── SSE event bus ─────────────────────────────────────────────────────────────

// sseEvent carries one SSE frame through the event bus.
// The wire format is:  id: N\nevent: Type\ndata: {Data as JSON}\n\n
// Generation is the engine epoch when this event was emitted; clients can
// discard any event whose Generation is less than the last engine.snapshot they
// received, since it belongs to a previous engine lifecycle.
type sseEvent struct {
	ID         int64
	Type       string
	Data       any
	Generation uint64
}

// ringSize is the number of events kept in the replay buffer.
// Must be a power of two so we can use bitwise AND instead of modulo.
const (
	ringSize = 256
	ringMask = ringSize - 1
)

type eventBus struct {
	mu      sync.Mutex
	clients map[string]chan sseEvent
	seq     int64              // monotonic event ID; ALL allocations go through mu
	epoch   EngineEpoch        // engine epoch; advanced by subsystems, not by the bus
	ring    [ringSize]sseEvent // circular replay buffer
	ringPos int                // next write slot (unbounded; masked on access)
	ringLen int                // valid entries (0 .. ringSize)
}

func newEventBus(epoch EngineEpoch) *eventBus {
	return &eventBus{
		clients: make(map[string]chan sseEvent),
		epoch:   epoch,
	}
}

// nextID allocates one ID under the bus lock so it is strictly ordered
// with respect to ring writes from emit.
func (b *eventBus) nextID() int64 {
	b.mu.Lock()
	b.seq++
	id := b.seq
	b.mu.Unlock()
	return id
}

func (b *eventBus) unsubscribe(id string) {
	b.mu.Lock()
	if ch, ok := b.clients[id]; ok {
		close(ch)
		delete(b.clients, id)
	}
	b.mu.Unlock()
}

// emit assigns an ID, appends to the ring buffer, and broadcasts to all
// subscribed channels.  Everything happens under a single lock acquisition
// so IDs, ring writes, and fan-out are atomic with respect to each other.
func (b *eventBus) emit(typ string, data any) {
	// Read epoch outside the bus lock — no nested acquisition needed.
	// An event emitted just before an epoch advance gets the old generation,
	// which is correct: it was produced before the boundary.
	epochInfo := b.epoch.Current()
	b.mu.Lock()
	b.seq++
	ev := sseEvent{ID: b.seq, Type: typ, Data: data, Generation: epochInfo.Generation}
	b.ring[b.ringPos&ringMask] = ev
	b.ringPos++
	if b.ringLen < ringSize {
		b.ringLen++
	}
	for _, ch := range b.clients {
		select {
		case ch <- ev:
		default: // slow consumer: drop rather than block
		}
	}
	b.mu.Unlock()
}

// ringBounds returns the IDs of the oldest and newest events currently in the
// ring buffer.  Both values are 0 when the ring is empty.
func (b *eventBus) ringBounds() (oldest, newest int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ringLen == 0 {
		return 0, 0
	}
	oldestSlot := b.ringPos - b.ringLen
	oldest = b.ring[oldestSlot&ringMask].ID
	newest = b.ring[(b.ringPos-1)&ringMask].ID
	return oldest, newest
}

// subscribeAndReplay atomically registers a new subscriber AND returns all
// ring-buffered events with ID > afterID.  Holding a single lock for both
// operations ensures no events can be emitted in the gap — the channel will
// receive exactly the events that follow the replayed ones.
//
// Pass afterID = -1 to skip replay (first-time connect).
//
// truncated is true when the client requested replay (afterID >= 0) but the
// ring has already evicted some of the events they missed — i.e. the oldest
// event in the ring has an ID > afterID+1.  Callers should emit a
// replay.truncated control event so clients know to resync state rather than
// silently applying a partial replay.
func (b *eventBus) subscribeAndReplay(afterID int64) (subID string, ch <-chan sseEvent, replay []sseEvent, truncated bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	id := randID()
	c := make(chan sseEvent, 64) // larger buffer absorbs events emitted during replay write
	b.clients[id] = c

	if afterID >= 0 && b.ringLen > 0 {
		oldestSlot := b.ringPos - b.ringLen
		oldestID := b.ring[oldestSlot&ringMask].ID
		if afterID < oldestID-1 {
			// Gap: events between afterID+1 and oldestID-1 were evicted.
			truncated = true
		} else {
			for i := 0; i < b.ringLen; i++ {
				ev := b.ring[(oldestSlot+i)&ringMask]
				if ev.ID > afterID {
					replay = append(replay, ev)
				}
			}
		}
	}
	return id, c, replay, truncated
}

// ── Server ────────────────────────────────────────────────────────────────────

// APIServer is the long-running HTTP daemon started by --api <port>.
type APIServer struct {
	srv         *http.Server
	port        int
	pm          *playback.Manager
	em          *export.Manager
	dm          *drm.DRMManager
	session     *drm.SessionManager // canonical source for MUT + storefront
	epoch       EngineEpoch         // shared engine epoch; advanced by subsystems
	lifecycle   *engineLifecycle    // single coordinator for epoch advancement
	events      *eventBus
	drmReady    bool   // true when drm binary was found at startup
	eagerStart  bool   // launch the drm binary at Start() when a session exists
	sessionDir  string // session/credential directory guarded by sessionLock
	sessionLock *drm.SessionLock
	backendName string               // configured preferred backend (single-backend case)
	backendSel  drm.BackendSelection // non-nil when a fallback composite is in use
	scheduler   *prefetch.Scheduler  // background cache-warming scheduler
	diskCache   *diskcache.Cache     // per-track decrypted audio disk cache
	vlcPlayer   *vlc.Player          // nil when libvlc is not available
	vlcSessionID string              // session backing the current VLC stream
}

// NewAPIServer wires all routes.
func NewAPIServer(port int) *APIServer {
	epoch := newEpochManager()
	s := &APIServer{
		port:      port,
		epoch:     epoch,
		lifecycle: newEngineLifecycle(epoch),
		events:    newEventBus(epoch),
	}

	// DRM subsystem constructed first: DRMManager is passed to the PlaybackManager
	// as a fairplay.CBCSDialer so cbcs.go has no knowledge of the TCP transport.
	// ProcessConfig owns all transport details (binary path, TCP addresses).
	// BackendConfig carries only what both backends share (BaseDir, DeviceInfo).
	// Resolve drm binary path: use config if set, otherwise auto-discover
	// from drm/drm-rootless relative to the working directory.
	// The binary lives inside the repo at a canonical location so no config
	// entry is needed for the common case.
	drmBinaryPath := Config.DRMBinaryPath
	if drmBinaryPath == "" {
		if abs, err := filepath.Abs("drm/drm-rootless"); err == nil {
			if _, err := os.Stat(abs); err == nil {
				drmBinaryPath = abs
			}
		}
	}

	// Derive the drm session directory from the binary path when not
	// explicitly configured. With OmitBaseDir=true no --base-dir flag is passed,
	// so the drm binary uses its compiled-in default:
	//   /data/data/com.apple.android.music/files  (inside the chroot)
	// From the host that resolves to rootfs/data/data/com.apple.android.music/files
	// relative to the binary's parent directory.
	drmBaseDir := Config.DRMBaseDir
	if drmBaseDir == "" && drmBinaryPath != "" {
		drmBaseDir = filepath.Join(
			filepath.Dir(drmBinaryPath),
			"rootfs", "data", "data", "com.apple.android.music", "files",
		)
	}
	drmSession := drm.NewSessionManager(drmBaseDir)

	// Backend selection follows the backend policy (preferred + optional
	// fallback). Default: prefer EmbeddedBackend (CGO launcher, no external
	// drm-rootless binary needed at runtime) with an automatic startup
	// fallback to ProcessBackend if Embedded can't start on this system.
	// The benchmark (CLAUDE.md) showed no significant performance difference,
	// so the choice is by architecture, not speed. Fallback is startup-only —
	// no runtime hot-swap (see docs/design/backend-supervisor.md).
	preferred, fallbackName := drm.ResolveBackendPolicy(
		drmBinaryPath != "", Config.Backend.Preferred, Config.Backend.Fallback, Config.UseEmbeddedBackend)
	s.backendName = preferred
	drmBackend := buildDRMBackend(preferred, drmBinaryPath)
	if fallbackName != "" && fallbackName != preferred {
		if fb := buildDRMBackend(fallbackName, drmBinaryPath); fb != nil && drmBackend != nil {
			composite := drm.NewFallbackBackend(drmBackend, preferred, fb, fallbackName)
			drmBackend = composite
			if sel, ok := composite.(drm.BackendSelection); ok {
				s.backendSel = sel
			}
			fmt.Printf("DRM backend: preferred=%s, fallback=%s\n", preferred, fallbackName)
		}
	} else {
		fmt.Printf("DRM backend: %s (no fallback)\n", preferred)
	}

	s.dm = drm.NewDRMManager(
		drmBackend,
		drmSession,
		func(snap drm.DRMSnapshot) {
			s.lifecycle.OnDRMStateChanged(snap.State.Session.String())
			s.events.emit("drm", snap)
		},
		drm.BackendConfig{BaseDir: drmBaseDir},
		drm.DefaultRestartPolicy,
	)
	s.session = drmSession
	s.drmReady = drmBinaryPath != ""
	s.sessionDir = drmBaseDir

	// Eager-start decision (executed in Start(), after the session lock is held):
	// if a session DB exists, launch the drm binary immediately so process/fairplay
	// state is visible without waiting for the first playback request.
	s.eagerStart = s.drmReady && drmSession.HasSession()

	// PlaybackManager receives DRMManager as the CBCSDialer for ALAC/Atmos.
	// DRMManager.DialCBCS auto-starts the drm binary if a session exists, then
	// opens a TCP connection for the FairPlay wire protocol.
	s.pm = playback.NewWithProvider(apple.NewProviderWithCBCS(s.dm))

	// Prefetch scheduler — credentials are resolved lazily at Submit time
	// so token rotations are picked up automatically.
	// Use ev.Kind as the SSE event name so clients can subscribe to specific
	// phases (prefetch.cached, prefetch.done, …) without filtering JSON.
	s.scheduler = prefetch.NewScheduler(s.pm, bearerToken, s.mediaUserToken, func(ev prefetch.Event) {
		s.events.emit(string(ev.Kind), ev)
	}, prefetch.DefaultWorkers)
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for range t.C {
			s.scheduler.PruneExpiredPreWarmed()
		}
	}()

	// Disk cache — decrypted per-track audio; falls back gracefully on error.
	// Limits (persistLimitMB, persistTTLDays) are pushed by the frontend on
	// startup via PUT /api/v1/cache/config; zero means unlimited / no TTL.
	if cacheBase, err := os.UserCacheDir(); err == nil {
		if dc, err := diskcache.New(filepath.Join(cacheBase, "apple-music-linux", "playback")); err == nil {
			s.diskCache = dc
			go func() {
				t := time.NewTicker(time.Hour)
				defer t.Stop()
				for range t.C {
					s.diskCache.EvictExpired()
				}
			}()
		}
	}

	s.em = export.NewManager(s.pm, func(ev export.ExportEvent) {
		s.events.emit("export", ev)
	}, export.DefaultWorkers)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/status", cors(s.handleStatus))
	mux.HandleFunc("GET /api/v1/capabilities", cors(s.handleCapabilities))
	mux.HandleFunc("GET /api/v1/events", cors(s.handleEvents))

	mux.HandleFunc("POST /api/v1/playback", cors(s.handleCreatePlayback))
	mux.HandleFunc("GET /api/v1/playback/{id}/audio", cors(s.handlePlaybackAudio))
	mux.HandleFunc("GET /api/v1/playback/{id}/video", cors(s.handlePlaybackVideo))
	mux.HandleFunc("DELETE /api/v1/playback/{id}", cors(s.handleDeletePlayback))

	// Playback context — renderer signals user intent; scheduler decides what to warm.
	mux.HandleFunc("PUT /api/v1/playback/context", cors(s.handlePlaybackContext))

	// Cache endpoints — config, stats, and clear.
	mux.HandleFunc("PUT /api/v1/cache/config", cors(s.handleCacheConfig))
	mux.HandleFunc("GET /api/v1/cache/stats", cors(s.handleCacheStats))
	mux.HandleFunc("DELETE /api/v1/cache/playback", cors(s.handleCachePlaybackDelete))

	// Job status and cancellation for cache-warming jobs.
	mux.HandleFunc("GET /api/v1/jobs/{id}", cors(s.handleJobStatus))
	mux.HandleFunc("DELETE /api/v1/jobs/{id}", cors(s.handleJobCancel))

	mux.HandleFunc("GET /api/v1/metadata/{id}", cors(s.handleMetadata))
	mux.HandleFunc("GET /api/v1/artwork/{id}", cors(s.handleArtwork))
	mux.HandleFunc("GET /api/v1/lyrics/{id}", cors(s.handleLyrics))

	mux.HandleFunc("POST /api/v1/export", cors(s.handleExportCreate))
	mux.HandleFunc("GET /api/v1/export", cors(s.handleExportList))
	mux.HandleFunc("GET /api/v1/export/{id}", cors(s.handleExportGet))
	mux.HandleFunc("DELETE /api/v1/export/{id}", cors(s.handleExportCancel))
	mux.HandleFunc("POST /api/v1/export/{id}/retry", cors(s.handleExportRetry))

	// DRM subsystem — wrapper lifecycle, authentication, session management.
	// The frontend expresses intent (login, submit 2FA); the engine orchestrates.
	mux.HandleFunc("GET /api/v1/drm/status", cors(s.handleDRMStatus))
	mux.HandleFunc("POST /api/v1/drm/authenticate", cors(s.handleDRMAuthenticate))
	mux.HandleFunc("POST /api/v1/drm/challenge", cors(s.handleDRMChallenge))
	mux.HandleFunc("POST /api/v1/drm/logout", cors(s.handleDRMLogout))
	mux.HandleFunc("DELETE /api/v1/drm/session", cors(s.handleDRMClearSession))

	// Catalog — search and entity detail endpoints for frontend UIs.
	// These are purely additive and proxy the Apple Music catalog API.
	mux.HandleFunc("GET /api/v1/catalog/search", cors(s.handleCatalogSearch))
	mux.HandleFunc("GET /api/v1/catalog/albums/{id}", cors(s.handleCatalogAlbum))
	mux.HandleFunc("GET /api/v1/catalog/playlists/{id}", cors(s.handleCatalogPlaylist))
	mux.HandleFunc("GET /api/v1/catalog/artists/{id}", cors(s.handleCatalogArtist))

	// VLC player — libvlc-backed playback for ALAC/Atmos that the browser cannot decode.
	// Routes are no-ops when libvlc is not installed; frontend falls back to MSE.
	s.vlcPlayer, _ = vlc.New() // nil if libvlc unavailable
	mux.HandleFunc("POST /api/v1/vlc/load",  cors(s.handleVLCLoad))
	mux.HandleFunc("POST /api/v1/vlc/pause", cors(s.handleVLCPause))
	mux.HandleFunc("POST /api/v1/vlc/resume",cors(s.handleVLCResume))
	mux.HandleFunc("GET /api/v1/vlc/time",   cors(s.handleVLCTime))
	mux.HandleFunc("POST /api/v1/vlc/seek",  cors(s.handleVLCSeek))
	mux.HandleFunc("POST /api/v1/vlc/volume",cors(s.handleVLCVolume))

	// Benchmark/diagnostics surface (additive; no effect on playback).
	// /api/v1/debug/runtime exposes scalar runtime metrics the harness samples
	// (goroutines, heap, GC) — things only the engine process itself can report.
	// /debug/pprof/* serves standard profiles for flamegraphs.
	mux.HandleFunc("GET /api/v1/debug/runtime", cors(s.handleRuntimeStats))
	mux.HandleFunc("GET /debug/pprof/", httppprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("GET /debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("GET /debug/pprof/trace", httppprof.Trace)

	// Wrap the mux so that every OPTIONS request is handled before route
	// matching.  Go 1.22+ method-prefixed routes ("GET /path") never match
	// OPTIONS, causing preflights to 405.  Chrome also requires the response
	// to include Access-Control-Allow-Private-Network: true when fetching
	// across localhost ports (CORS-RFC1918 / Private Network Access).
	s.srv = &http.Server{Handler: corsPreflightHandler(mux)}
	return s
}

// Start acquires the exclusive session lock, binds the listener, and serves in
// the background. If another engine instance already owns the session, Start
// returns an error so this instance refuses to run (preventing dual ownership
// of the single-user Apple session).
func (s *APIServer) Start() error {
	if s.drmReady {
		lock, err := drm.AcquireSessionLock(s.sessionDir)
		if err != nil {
			return fmt.Errorf("acquire session lock: %w", err)
		}
		s.sessionLock = lock
	}

	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.port))
	if err != nil {
		s.sessionLock.Release()
		s.sessionLock = nil
		return err
	}

	// Eager-start now that the session lock is held.
	// Retry with exponential backoff: the backend forks and exec's the Android
	// binary synchronously, but the DRM ports (:10020/:30020) open ~10-20s
	// later. A single immediate GetAccount would always hit "connection refused"
	// and log a misleading error. We retry until the port comes up or the
	// 30-second budget is exhausted.
	if s.eagerStart {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			delay := 500 * time.Millisecond
			var lastErr error
			for {
				_, lastErr = s.dm.GetAccount(ctx)
				if lastErr == nil {
					return
				}
				select {
				case <-ctx.Done():
					fmt.Printf("DRM auto-start: backend not ready after 30s: %v\n", lastErr)
					return
				case <-time.After(delay):
					if delay < 5*time.Second {
						delay *= 2
					}
				}
			}
		}()
	}

	fmt.Printf("🎵 Apple Music API → http://127.0.0.1:%d\n", s.port)
	go s.srv.Serve(l) //nolint:errcheck
	return nil
}

// Stop gracefully shuts down the HTTP server and the DRM backend.
// The session DB is preserved so the next start reuses the session.
func (s *APIServer) Stop() {
	// Stop the wrapper process first so it doesn't keep running as an orphan.
	// Session files are NOT cleared — they persist for the next server start.
	s.dm.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.srv.Shutdown(ctx) //nolint:errcheck
	// Release the session lock last, after the wrapper is fully stopped.
	s.sessionLock.Release()
	s.sessionLock = nil
}

// ── Backend policy ──────────────────────────────────────────────────────────
//
// Policy resolution itself (drm.ResolveBackendPolicy) is a pure function that
// lives in engine/drm so it can be unit tested — package main cannot be
// (`go test .` fails: "module main" import restriction, see CLAUDE.md).

// buildDRMBackend constructs a single backend by name. Both backends share the
// same transport addresses; EmbeddedBackend needs the drm directory, while
// ProcessBackend execs the drm-rootless binary at drmBinaryPath.
func buildDRMBackend(name, drmBinaryPath string) drm.DRMBackend {
	if name == "embedded" {
		return drm.NewEmbeddedBackend(drm.EmbedConfig{
			WrapperDir:  filepath.Dir(drmBinaryPath),
			OmitBaseDir: true,
			DecryptAddr: Config.DecryptM3u8Port,
			M3U8Addr:    Config.GetM3u8Port,
		})
	}
	return drm.NewProcessBackend(drm.ProcessConfig{
		BinaryPath:  drmBinaryPath,
		OmitBaseDir: true, // drm-rootless resolves BaseDir relative to its cwd; absolute path breaks anisette init
		DecryptAddr: Config.DecryptM3u8Port,
		M3U8Addr:    Config.GetM3u8Port,
	})
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleRuntimeStats reports scalar Go runtime metrics for the benchmark
// harness. These are process-internal (goroutine count, heap, GC) and cannot be
// observed from outside via /proc, so the engine self-reports them here.
func (s *APIServer) handleRuntimeStats(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	resp := map[string]any{
		"goroutines":      runtime.NumGoroutine(),
		"heapAllocBytes":  m.HeapAlloc,
		"heapSysBytes":    m.HeapSys,
		"stackSysBytes":   m.StackSys,
		"totalAllocBytes": m.TotalAlloc,
		"numGC":           m.NumGC,
		"gcPauseTotalNs":  m.PauseTotalNs,
		"nextGCBytes":     m.NextGC,
	}
	if s.scheduler != nil {
		resp["prefetch"] = s.scheduler.Stats()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *APIServer) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	// Capabilities now reflect DRMManager state rather than a raw TCP probe.
	// DRMManager.Status() gives a complete snapshot including whether FairPlay
	// is initialised and what content types are available.
	snap := s.dm.Status()
	cap := snap.Capabilities
	writeJSON(w, http.StatusOK, map[string]any{
		"lossless":   cap.ALAC,
		"hiRes":      cap.HiRes,
		"atmos":      cap.Atmos,
		"musicVideo": true,
		"downloads":  true,
		"lyrics":     true,
		"queue":      false,
		"radio":      false,
		// DRM status detail for frontends that want to show granular state.
		"drm": map[string]any{
			"process":  snap.State.Process.String(),
			"fairplay": snap.State.FairPlay.String(),
			"session":  snap.State.Session.String(),
			"cbcs":     cap.CBCS,
		},
	})
}

// ── DRM handlers ──────────────────────────────────────────────────────────────

func (s *APIServer) handleDRMStatus(w http.ResponseWriter, r *http.Request) {
	// Surface which backend is active and, if a fallback occurred, why — so an
	// operator sees "selected: process, reason: embedded startup failed: …"
	// even though the fallback was transparent to clients.
	selected := s.backendName
	reason := ""
	if s.backendSel != nil {
		if n := s.backendSel.ActiveName(); n != "" {
			selected = n
		}
		reason = s.backendSel.FallbackReason()
	}
	writeJSON(w, http.StatusOK, drmStatusResponse{
		DRMSnapshot: s.dm.Status(),
		Backend:     backendStatus{Selected: selected, FallbackReason: reason},
	})
}

// drmStatusResponse embeds the DRM snapshot and adds backend-selection info.
type drmStatusResponse struct {
	drm.DRMSnapshot
	Backend backendStatus `json:"backend"`
}

type backendStatus struct {
	Selected       string `json:"selected"`
	FallbackReason string `json:"fallbackReason,omitempty"`
}

func (s *APIServer) handleDRMAuthenticate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Email == "" || req.Password == "" {
		http.Error(w, "email and password required", http.StatusBadRequest)
		return
	}
	if !s.drmReady {
		http.Error(w, "DRM backend not available — drm binary not found at startup", http.StatusServiceUnavailable)
		return
	}
	go func() {
		// Use context.Background: r.Context() is cancelled the moment the 202
		// response is written, which would abort the login mid-flight.
		// Authentication is long-running; progress arrives via SSE instead.
		if err := s.dm.Authenticate(context.Background(), drm.Credentials{
			Email:    req.Email,
			Password: req.Password,
		}); err != nil {
			fmt.Printf("drm login error: %v\n", err)
		}
	}()
	// Return immediately; authentication completion arrives via SSE.
	writeJSON(w, http.StatusAccepted, s.dm.Status())
}

func (s *APIServer) handleDRMChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reply string `json:"reply"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Reply == "" {
		http.Error(w, "reply required", http.StatusBadRequest)
		return
	}
	if err := s.dm.SubmitChallenge(r.Context(), req.Reply); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}

func (s *APIServer) handleDRMLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.dm.Logout(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, s.dm.Status())
}

func (s *APIServer) handleDRMClearSession(w http.ResponseWriter, r *http.Request) {
	if err := s.dm.ClearSession(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *APIServer) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl.Flush()

	// Parse Last-Event-ID sent by reconnecting clients.
	var replayAfter int64 = -1 // -1 = first-time connect; skip replay
	if lei := r.Header.Get("Last-Event-ID"); lei != "" {
		if id, err := strconv.ParseInt(lei, 10, 64); err == nil && id >= 0 {
			replayAfter = id
		}
	}

	// Atomically subscribe and snapshot replay events in one lock acquisition.
	// Any event emitted after this point goes into `ch`; events emitted before
	// it are in the ring.  No gap can form between the two sets.
	subID, ch, replayEvents, replayTruncated := s.events.subscribeAndReplay(replayAfter)
	defer s.events.unsubscribe(subID)

	// envelopeMeta carries transport metadata present in every event.
	// reason and snapshot are omitted on non-snapshot events.
	// Separating meta from payload makes it trivial to add future fields
	// (NodeID, EngineVersion, TraceID) without touching payload schemas.
	type envelopeMeta struct {
		ID         int64       `json:"id"`
		Generation uint64      `json:"generation"`
		Reason     EpochReason `json:"reason,omitempty"`
		Snapshot   bool        `json:"snapshot,omitempty"`
	}
	type wireEnvelope struct {
		Meta    envelopeMeta    `json:"meta"`
		Payload json.RawMessage `json:"payload"`
	}

	// Helper: marshal data → raw bytes → wrap in envelope → write SSE frame.
	// json.RawMessage avoids a second encode of the payload bytes.
	// isSnapshot=true adds reason + snapshot flag to meta; false omits both.
	writeEv := func(id int64, typ string, data any, gen uint64, isSnapshot bool, reason EpochReason) {
		raw, _ := json.Marshal(data)
		meta := envelopeMeta{ID: id, Generation: gen}
		if isSnapshot {
			meta.Reason = reason
			meta.Snapshot = true
		}
		env, _ := json.Marshal(wireEnvelope{Meta: meta, Payload: raw})
		fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, typ, env)
		fl.Flush()
	}

	// engine.snapshot reports current epoch + the reason it last advanced so
	// clients can answer "why did generation jump?" without a separate query.
	epochInfo := s.epoch.Current()

	drmSnap := s.dm.Status()
	cap := drmSnap.Capabilities
	snapshotState := map[string]any{
		"drm": map[string]any{
			"state":    drmSnap.State,
			"session":  drmSnap.State.Session.String(),
			"cbcs":     cap.CBCS,
			"lossless": cap.ALAC,
			"hiRes":    cap.HiRes,
			"atmos":    cap.Atmos,
		},
		"capabilities": map[string]any{
			"lossless":   cap.ALAC,
			"hiRes":      cap.HiRes,
			"atmos":      cap.Atmos,
			"musicVideo": true,
		},
	}
	if s.scheduler != nil {
		snapshotState["prefetch"] = s.scheduler.Stats()
	}
	writeEv(s.events.nextID(), "engine.snapshot", map[string]any{
		"version":  1,
		"snapshot": snapshotState,
	}, epochInfo.Generation, true, epochInfo.Reason)

	// If the ring evicted events the client missed, signal resync rather than
	// silently applying an incomplete delta replay.
	if replayTruncated {
		oldest, newest := s.events.ringBounds()
		writeEv(s.events.nextID(), "replay.truncated", map[string]any{
			"requestedAfter":  replayAfter,
			"oldestAvailable": oldest,
			"newestAvailable": newest,
			"reason":          "history_evicted",
		}, epochInfo.Generation, false, "")
	} else {
		// Replay missed events from the ring buffer (empty on first connect).
		// Replayed events carry their original generation so the client can
		// order them relative to the current snapshot.
		for _, ev := range replayEvents {
			writeEv(ev.ID, ev.Type, ev.Data, ev.Generation, false, "")
		}
	}

	// 30-second named ping event keeps proxies from closing idle connections
	// and gives clients a watchdog signal they can act on.
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			writeEv(s.events.nextID(), "ping", map[string]int64{"ts": time.Now().UnixMilli()}, epochInfo.Generation, false, "")
		case ev, ok := <-ch:
			if !ok {
				return
			}
			writeEv(ev.ID, ev.Type, ev.Data, ev.Generation, false, "")
		}
	}
}

func (s *APIServer) handleCreatePlayback(w http.ResponseWriter, r *http.Request) {
	var req PlaybackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.AssetID == "" {
		http.Error(w, "assetId is required", http.StatusBadRequest)
		return
	}

	// Prefer request-level tokens (supplied by the browser renderer from MusicKit)
	// over config-level tokens so that the renderer's live session is used without
	// requiring them to be duplicated in config.yaml.
	token := req.Token
	if token == "" {
		token = bearerToken()
	}
	mut := req.MUT
	if mut == "" {
		mut = s.mediaUserToken()
	}
	if token == "" || mut == "" {
		http.Error(w, "not authenticated — provide token+mediaUserToken in request body or configure them", http.StatusUnauthorized)
		return
	}

	sf := req.Storefront
	if sf == "" {
		sf = s.storefront()
	}

	// Use a pre-warmed session if the prefetch scheduler already opened one
	// for this asset. This skips the webplayback API round-trip (~1–2 s) and
	// lets playback start immediately. Only applicable for AAC (non-lossless,
	// non-atmos) since prefetch workers open default-quality sessions.
	var sess *playback.Session
	if !req.Capabilities.Lossless && !req.Capabilities.Atmos && !req.Capabilities.Video {
		if sessionID, ok := s.scheduler.TakePreWarmed(req.AssetID); ok {
			if preOpened, found := s.pm.GetSession(sessionID); found {
				sess = preOpened
			}
		}
	}

	if sess == nil {
		var err error
		sess, err = s.pm.Open(r.Context(), playback.OpenRequest{
			AssetID:    req.AssetID,
			Storefront: sf,
			Token:      token,
			MUT:        mut,
			Lossless:   req.Capabilities.Lossless,
			Video:      req.Capabilities.Video,
			Atmos:      req.Capabilities.Atmos,
			Language:   Config.Language,
		})
		if err != nil {
			http.Error(w, "playback resolution failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}

	s.events.emit("playback.created", map[string]any{
		"sessionId": sess.ID,
		"assetId":   sess.AssetID,
		"codec":     sess.Codec,
	})
	writeJSON(w, http.StatusCreated, sess)
}

func (s *APIServer) handlePlaybackAudio(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	log.Printf("[audio] GET id=%s t=%q Range=%q", id, r.URL.Query().Get("t"), r.Header.Get("Range"))
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Audio {
		http.Error(w, "no audio stream in this session", http.StatusNotFound)
		return
	}

	// ?t=<seconds> — seek to an approximate time offset.
	// The response header X-Actual-Start reports the real segment start time so
	// the frontend can set audio.currentTime accurately after a seek.
	var seekSec float64
	if tStr := r.URL.Query().Get("t"); tStr != "" {
		if v, err := strconv.ParseFloat(tStr, 64); err == nil && v > 0 {
			seekSec = v
		}
	}

	// Disk cache: pre-download the full track so the response has
	// Accept-Ranges: bytes and VLC can seek natively without a URL reload.
	if seekSec == 0 && s.diskCache != nil {
		qualifier := sess.Codec
		if f, ok := s.diskCache.Get(sess.AssetID, qualifier); ok {
			defer f.Close()
			w.Header().Set("Content-Type", "audio/mp4")
			http.ServeContent(w, r, "", time.Time{}, f)
			return
		}
		// Cache miss: download the whole track to disk, then serve.
		if pw, _ := s.diskCache.BeginPut(sess.AssetID, qualifier); pw != nil {
			err := s.pm.Stream(r.Context(), id, pipeline.KindAudio, pw)
			if err != nil {
				pw.Discard()
			} else if pw.Commit() == nil {
				if f, ok := s.diskCache.Get(sess.AssetID, qualifier); ok {
					defer f.Close()
					w.Header().Set("Content-Type", "audio/mp4")
					http.ServeContent(w, r, "", time.Time{}, f)
					return
				}
			}
		}
		// Fallback: stream without caching (no byte-range seek support).
		streamMedia(w, r, func(dst io.Writer) error {
			return s.pm.Stream(r.Context(), id, pipeline.KindAudio, dst)
		}, "audio/mp4")
		return
	}

	if seekSec > 0 {
		log.Printf("[engine] seek id=%s codec=%s seekSec=%.3f", id, sess.Codec, seekSec)
		seekCtx := r.Context()
		if actual, ok := s.pm.GetSeekStart(id, pipeline.KindAudio, seekSec); ok {
			w.Header().Set("X-Actual-Start", strconv.FormatFloat(actual, 'f', 3, 64))
			log.Printf("[engine] seek actualStart=%.3f (requested=%.3f)", actual, seekSec)
			seekCtx = pipeline.ContextWithActualStart(seekCtx, actual)
			// Pass the exact requested time so PassthroughStreaming can trim
			// leading fragments within the segment for sub-segment accuracy.
			seekCtx = pipeline.ContextWithSeekTarget(seekCtx, seekSec)
		}
		streamMedia(w, r, func(dst io.Writer) error {
			_, err := s.pm.StreamFrom(seekCtx, id, pipeline.KindAudio, seekSec, dst)
			return err
		}, "audio/mp4")
		return
	}

	streamMedia(w, r, func(dst io.Writer) error {
		return s.pm.Stream(r.Context(), id, pipeline.KindAudio, dst)
	}, "audio/mp4")
}

func (s *APIServer) handlePlaybackVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.pm.GetSession(id)
	if !ok {
		http.Error(w, "session not found or expired", http.StatusNotFound)
		return
	}
	if !sess.Capabilities.Video {
		http.Error(w, "no video stream in this session", http.StatusNotFound)
		return
	}
	streamMedia(w, r, func(dst io.Writer) error {
		return s.pm.Stream(r.Context(), id, pipeline.KindVideo, dst)
	}, "video/mp4")
}

// streamMedia runs fn into a firstByteWriter so that:
//   - If fn produces no bytes and returns an error, the client receives a
//     502 JSON error instead of a silent empty 200 response.
//   - If fn produces at least one byte before failing, headers are already
//     committed; the partial stream is what the client sees (best effort).
func streamMedia(w http.ResponseWriter, r *http.Request, fn func(io.Writer) error, ct string) {
	bw := &firstByteWriter{w: w, ct: ct}
	if err := fn(bw); err != nil {
		if r.Context().Err() != nil {
			return // client disconnected — not an error
		}
		if !bw.started {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		// Headers already committed; log and let the client handle the truncated stream.
		fmt.Printf("stream error (partial): %v\n", err)
	}
}

// firstByteWriter defers writing Content-Type + 200 headers until the first
// byte arrives.  This lets the handler return a proper error if the pipeline
// fails before producing any output.
type firstByteWriter struct {
	w       http.ResponseWriter
	ct      string
	started bool
}

func (b *firstByteWriter) SetHeader(key, value string) {
	if !b.started {
		b.w.Header().Set(key, value)
	}
}

func (b *firstByteWriter) Write(p []byte) (int, error) {
	if !b.started {
		b.started = true
		b.w.Header().Set("Content-Type", b.ct)
		b.w.Header().Set("Accept-Ranges", "none")
		b.w.WriteHeader(http.StatusOK)
	}
	n, err := b.w.Write(p)
	// Flush the ResponseWriter's internal buffer to the network immediately.
	// Without this, Go's HTTP server buffers data in a 4KB internal buffer and
	// the player (mpv, VLC) stalls between fragments waiting for more bytes.
	if err == nil {
		if f, ok := b.w.(http.Flusher); ok {
			f.Flush()
		}
	}
	return n, err
}

func (s *APIServer) handleDeletePlayback(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.pm.Release(id)
	s.events.emit("playback.deleted", map[string]string{"sessionId": id})
	w.WriteHeader(http.StatusNoContent)
}

// handlePlaybackContext accepts a PUT /api/v1/playback/context payload and
// submits a cache-warming job to the prefetch scheduler.
// The renderer is telling the engine "the user is looking at this content."
// All scheduling policy (which tracks, order, concurrency) is engine-internal.
func (s *APIServer) handlePlaybackContext(w http.ResponseWriter, r *http.Request) {
	var payload prefetch.ContextPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	jobID := s.scheduler.Submit(payload)
	writeJSON(w, http.StatusAccepted, map[string]string{"jobId": jobID})
}

func (s *APIServer) handleCacheConfig(w http.ResponseWriter, r *http.Request) {
	var cfg prefetch.CacheConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.scheduler.SetCacheConfig(cfg)
	if s.diskCache != nil {
		s.diskCache.SetConfig(cfg.PersistLimitMB, cfg.PersistTTLDays)
	}
	writeJSON(w, http.StatusOK, s.scheduler.GetCacheConfig())
}

func (s *APIServer) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	cfg := s.scheduler.GetCacheConfig()
	prewarmLimitBytes := cfg.PrewarmLimitMB * 1024 * 1024
	if prewarmLimitBytes == 0 {
		prewarmLimitBytes = 1024 * 1024 * 1024 // 1 GB default shown in UI
	}

	persistSection := map[string]any{"available": false}
	if s.diskCache != nil {
		sizeBytes, count := s.diskCache.Stats()
		limitBytes := cfg.PersistLimitMB * 1024 * 1024
		if limitBytes == 0 {
			limitBytes = 500 * 1024 * 1024 // 500 MB default shown in UI
		}
		persistSection = map[string]any{
			"available":  true,
			"sizeBytes":  sizeBytes,
			"limitBytes": limitBytes,
			"ttlDays":    cfg.PersistTTLDays,
			"count":      count,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"persistent": persistSection,
		"prewarm": map[string]any{
			"entries":    s.scheduler.PrewarmCount(),
			"sizeBytes":  0,
			"limitBytes": prewarmLimitBytes,
		},
	})
}

func (s *APIServer) handleCachePlaybackDelete(w http.ResponseWriter, r *http.Request) {
	what := r.URL.Query().Get("what") // "prewarm", "persistent", or "" (both)
	if what == "" || what == "prewarm" {
		s.scheduler.ClearPreWarmed()
	}
	if what == "" || what == "persistent" {
		if s.diskCache != nil {
			s.diskCache.Clear()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleJobStatus returns a snapshot of a cache-warming job.
// Intended for debugging and progress UI; do not poll in normal operation.
func (s *APIServer) handleJobStatus(w http.ResponseWriter, r *http.Request) {
	job, ok := s.scheduler.Status(r.PathValue("id"))
	if !ok {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, &job) // job is a snapshot copy; pointer avoids copying the zero mutex
}

// handleJobCancel cancels remaining work for a cache-warming job.
// Called by the renderer on navigation away (per-slot cancellation).
func (s *APIServer) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	if !s.scheduler.Cancel(r.PathValue("id")) {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *APIServer) handleMetadata(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	tok := bearerToken()

	type Meta struct {
		ID               string       `json:"id"`
		Type             string       `json:"type"`
		Title            string       `json:"title"`
		ArtistName       string       `json:"artistName"`
		AlbumName        string       `json:"albumName,omitempty"`
		DurationMs       int          `json:"durationMs"`
		ArtworkURL       string       `json:"artworkUrl"`
		HasLyrics        bool         `json:"hasLyrics,omitempty"`
		Has4K            bool         `json:"has4k,omitempty"`
		HasHDR           bool         `json:"hasHdr,omitempty"`
		AvailableStreams []StreamInfo `json:"availableStreams"`
	}

	if song, err := ampapi.GetSongRespContext(r.Context(), sf, id, Config.Language, tok); err == nil && len(song.Data) > 0 {
		a := song.Data[0].Attributes
		writeJSON(w, http.StatusOK, Meta{
			ID:               id,
			Type:             "song",
			Title:            a.Name,
			ArtistName:       a.ArtistName,
			AlbumName:        a.AlbumName,
			DurationMs:       a.DurationInMillis,
			ArtworkURL:       fmtArtworkURL(a.Artwork.URL, 500),
			HasLyrics:        a.HasLyrics,
			AvailableStreams: streamsFromTraits(a.AudioTraits),
		})
		return
	}

	if mv, err := ampapi.GetMusicVideoRespContext(r.Context(), sf, id, Config.Language, tok); err == nil && len(mv.Data) > 0 {
		a := mv.Data[0].Attributes
		writeJSON(w, http.StatusOK, Meta{
			ID:         id,
			Type:       "mv",
			Title:      a.Name,
			ArtistName: a.ArtistName,
			AlbumName:  a.AlbumName,
			DurationMs: a.DurationInMillis,
			ArtworkURL: fmtArtworkURL(a.Artwork.URL, 500),
			Has4K:      a.Has4K,
			HasHDR:     a.HasHDR,
			AvailableStreams: []StreamInfo{
				{Codec: "H.264"},
				{Codec: "AAC"},
			},
		})
		return
	}

	http.Error(w, "asset not found", http.StatusNotFound)
}

func (s *APIServer) handleArtwork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	size := 500
	fmt.Sscanf(r.URL.Query().Get("size"), "%d", &size)
	tok := bearerToken()

	var rawURL string
	if song, err := ampapi.GetSongRespContext(r.Context(), sf, id, Config.Language, tok); err == nil && len(song.Data) > 0 {
		rawURL = song.Data[0].Attributes.Artwork.URL
	} else if mv, err := ampapi.GetMusicVideoRespContext(r.Context(), sf, id, Config.Language, tok); err == nil && len(mv.Data) > 0 {
		rawURL = mv.Data[0].Attributes.Artwork.URL
	} else {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	imgResp, err := http.Get(fmtArtworkURL(rawURL, size))
	if err != nil {
		http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer imgResp.Body.Close()
	w.Header().Set("Content-Type", imgResp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.Copy(w, imgResp.Body) //nolint:errcheck
}

func (s *APIServer) handleLyrics(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = Config.LrcFormat
	}
	if format == "" {
		format = "lrc"
	}
	lrcType := r.URL.Query().Get("type")
	if lrcType == "" {
		lrcType = Config.LrcType
	}
	if lrcType == "" {
		lrcType = "lyrics"
	}

	tok := strings.TrimPrefix(Config.AuthorizationToken, "Bearer ")
	mut := s.mediaUserToken()

	lrc, err := lyrics.GetContext(r.Context(), sf, id, lrcType, Config.Language, format, tok, mut)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if format == "ttml" {
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	fmt.Fprint(w, lrc)
}

// ── Export handlers ───────────────────────────────────────────────────────────

func (s *APIServer) handleExportCreate(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w) {
		return
	}
	var req export.ExportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	// Inject auth from server config if caller omitted them.
	if req.Token == "" {
		req.Token = bearerToken()
	}
	if req.MUT == "" {
		req.MUT = s.mediaUserToken()
	}
	if req.Storefront == "" {
		req.Storefront = s.storefront()
	}
	if req.Language == "" {
		req.Language = Config.Language
	}
	job, err := s.em.Enqueue(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *APIServer) handleExportList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.em.List())
}

func (s *APIServer) handleExportGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := s.em.Get(id)
	if !ok {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *APIServer) handleExportCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.em.Cancel(id) {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *APIServer) handleExportRetry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := s.em.Retry(id)
	if !ok {
		// Distinguish not-found from wrong-state.
		if _, exists := s.em.Get(id); !exists {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		http.Error(w, "job is not in a retryable state (must be failed or cancelled)", http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

// ── Catalog handlers ──────────────────────────────────────────────────────────

func (s *APIServer) handleCatalogSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "q is required", http.StatusBadRequest)
		return
	}
	types := r.URL.Query().Get("types")
	if types == "" {
		types = "songs,albums,artists"
	}
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	if sf == "" {
		sf = "us"
	}
	limitStr := r.URL.Query().Get("limit")
	limit := 25
	fmt.Sscanf(limitStr, "%d", &limit)
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tok := bearerToken()
	results, err := ampapi.Search(sf, q, types, Config.Language, tok, limit, 0)
	if err != nil {
		http.Error(w, "search failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, results)
}

func (s *APIServer) handleCatalogAlbum(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	if sf == "" {
		sf = "us"
	}
	tok := bearerToken()
	album, err := ampapi.GetAlbumResp(sf, id, Config.Language, tok)
	if err != nil {
		http.Error(w, "album fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, album)
}

func (s *APIServer) handleCatalogPlaylist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	if sf == "" {
		sf = "us"
	}
	tok := bearerToken()
	playlist, err := ampapi.GetPlaylistResp(sf, id, Config.Language, tok)
	if err != nil {
		http.Error(w, "playlist fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, playlist)
}

func (s *APIServer) handleCatalogArtist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sf := r.URL.Query().Get("sf")
	if sf == "" {
		sf = s.storefront()
	}
	if sf == "" {
		sf = "us"
	}
	tok := bearerToken()
	// Apple Music catalog API for artists.
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/artists/%s", sf, id), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	req.Header.Set("Origin", "https://music.apple.com")
	query := req.URL.Query()
	query.Set("include", "albums,songs")
	query.Set("limit[albums]", "20")
	query.Set("limit[songs]", "10")
	query.Set("l", Config.Language)
	req.URL.RawQuery = query.Encode()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "artist fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck
}

// ── CORS ──────────────────────────────────────────────────────────────────────

// corsPreflightHandler wraps a handler so that every OPTIONS request is
// answered with the full CORS header set before route matching occurs.
// Go 1.22+ method-prefixed patterns ("GET /path") never match OPTIONS, so
// preflights 405 without this wrapper.  Chrome Private Network Access
// (CORS-RFC1918) also requires Access-Control-Allow-Private-Network: true
// when fetching across localhost ports (e.g. 5500 → 8080).
func corsPreflightHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// setCORSHeaders writes all CORS response headers onto w based on the request origin.
func setCORSHeaders(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	switch {
	case origin == "https://music.apple.com",
		strings.HasPrefix(origin, "http://localhost"),
		strings.HasPrefix(origin, "http://127.0.0.1"):
		w.Header().Set("Access-Control-Allow-Origin", origin)
	case origin == "null":
		w.Header().Set("Access-Control-Allow-Origin", "null")
	default:
		w.Header().Set("Access-Control-Allow-Origin", "https://music.apple.com")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range, Last-Event-ID, Cache-Control")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length")
	if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
}

// ── Per-route CORS middleware ─────────────────────────────────────────────────

func cors(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Headers are already set by corsPreflightHandler for OPTIONS.
		// For non-OPTIONS requests the per-route wrapper re-sets them so
		// that responses to same-origin GET/POST also carry the Allow-Origin
		// header (required for browsers that skip the preflight).
		setCORSHeaders(w, r)
		h(w, r)
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (s *APIServer) checkAuth(w http.ResponseWriter) bool {
	if bearerToken() == "" || s.mediaUserToken() == "" {
		http.Error(w, "not authenticated — check config", http.StatusUnauthorized)
		return false
	}
	return true
}

// mediaUserToken returns the Media User Token.
//
// Precedence: Config.MediaUserToken (explicit override) > session MUSIC_TOKEN file.
// The session is the canonical runtime source; Config is an escape hatch for
// manual configuration and testing. This avoids duplicated state and picks up
// wrapper token refreshes automatically on every call.
func (s *APIServer) mediaUserToken() string {
	if Config.MediaUserToken != "" {
		return Config.MediaUserToken
	}
	if s.session != nil {
		if mt := s.session.ReadMusicToken(); mt != "" {
			return mt
		}
	}
	return ""
}

// storefront returns the storefront identifier.
//
// Precedence: Config.Storefront (explicit override) > session STOREFRONT_ID file.
// The raw session value is normalized via drm.NormalizeStorefrontID before use
// (strips the platform/content-class suffix the wrapper appends, e.g.
// "143467-2,31" → "143467"). If Config.Storefront is set it is used verbatim
// (expected to already be normalized, e.g. "us", "in", "143467").
func (s *APIServer) storefront() string {
	if Config.Storefront != "" {
		return Config.Storefront
	}
	if s.session != nil {
		if sf := s.session.ReadStorefrontID(); sf != "" {
			return drm.NormalizeStorefrontID(sf)
		}
	}
	return ""
}

func bearerToken() string {
	return strings.TrimPrefix(Config.AuthorizationToken, "Bearer ")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func flushHeaders(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func fmtArtworkURL(template string, size int) string {
	s := fmt.Sprintf("%d", size)
	out := strings.ReplaceAll(template, "{w}", s)
	return strings.ReplaceAll(out, "{h}", s)
}

func streamsFromTraits(traits []string) []StreamInfo {
	set := make(map[string]bool, len(traits))
	for _, t := range traits {
		set[t] = true
	}
	var out []StreamInfo
	if set["hi-res-lossless"] {
		sr, bd := 96000, 24
		for _, t := range traits {
			parts := strings.Split(t, "-")
			if len(parts) >= 2 {
				fmt.Sscanf(parts[len(parts)-2], "%d", &sr)
				fmt.Sscanf(parts[len(parts)-1], "%d", &bd)
				if sr > 0 && bd > 0 {
					break
				}
			}
		}
		out = append(out, StreamInfo{Codec: "ALAC", SampleRate: sr, BitDepth: bd})
	} else if set["lossless"] {
		out = append(out, StreamInfo{Codec: "ALAC", SampleRate: 44100, BitDepth: 16})
	}
	if set["atmos"] {
		out = append(out, StreamInfo{Codec: "E-AC-3"})
	}
	out = append(out, StreamInfo{Codec: "AAC", Bitrate: 256000})
	return out
}

func randID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

// ── VLC handlers ──────────────────────────────────────────────────────────────


func (s *APIServer) handleVLCLoad(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		AssetID   string `json:"assetId"`
		StartMs   int64  `json:"startMs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "sessionId required", http.StatusBadRequest)
		return
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/api/v1/playback/%s/audio?raw=1", s.port, req.SessionID)
	if req.StartMs > 0 {
		url += fmt.Sprintf("&t=%.3f", float64(req.StartMs)/1000.0)
	}
	if err := s.vlcPlayer.Load(url); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.vlcSessionID = req.SessionID
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCPause(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	s.vlcPlayer.Pause()
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCResume(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	s.vlcPlayer.Resume()
	w.WriteHeader(http.StatusOK)
}

func (s *APIServer) handleVLCTime(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	posMs, lengthMs, state := s.vlcPlayer.Time()
	writeJSON(w, http.StatusOK, map[string]any{
		"posMs":    posMs,
		"lengthMs": lengthMs,
		"state":    state,
	})
}

func (s *APIServer) handleVLCSeek(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		PosMs     int64  `json:"posMs"`
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.vlcPlayer.Seek(req.PosMs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	actualStartMs := req.PosMs
	if req.SessionID != "" {
		if actual, ok := s.pm.GetSeekStart(req.SessionID, pipeline.KindAudio, float64(req.PosMs)/1000.0); ok {
			actualStartMs = int64(actual * 1000)
		}
	}
	// Fast-forward past the HLS segment boundary gap.
	if offsetMs := req.PosMs - actualStartMs; offsetMs > 200 {
		s.vlcPlayer.SetTime(offsetMs)
	}
	writeJSON(w, http.StatusOK, map[string]any{"actualStartMs": actualStartMs})
}

func (s *APIServer) handleVLCVolume(w http.ResponseWriter, r *http.Request) {
	if s.vlcPlayer == nil {
		http.Error(w, "libvlc not available", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Volume int `json:"volume"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.vlcPlayer.SetVolume(req.Volume)
	w.WriteHeader(http.StatusOK)
}
