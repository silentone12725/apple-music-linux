package main

// apiserver.go — HTTP API adapter for the Apple Music media engine.
//
// This file is the thinnest possible HTTP layer.  All business logic lives in
// engine/playback; this file only:
//   - Parses and validates HTTP requests
//   - Calls the PlaybackManager
//   - Writes HTTP responses
//
// No DRM material, no HLS parsing, no key bytes cross this file.
//
// Route map:
//   GET    /api/v1/status                → health check
//   GET    /api/v1/capabilities          → feature flags for frontends
//   GET    /api/v1/events                → SSE push channel
//
//   POST   /api/v1/playback              → create session
//   GET    /api/v1/playback/{id}/audio   → stream audio (ALAC / AAC / Atmos)
//   GET    /api/v1/playback/{id}/video   → stream video (MV only)
//   POST   /api/v1/playback/{id}/precache → background disk-cache download (gapless)
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
	"log/slog"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"engine/core/apple"
	"engine/core/diskcache"
	"engine/core/drm"
	"engine/core/export"
	"engine/core/fairplay"
	"engine/core/library"
	"engine/core/playback"
	"engine/core/prefetch"
	"engine/core/vlc"
	"engine/internal/ring"
	"engine/utils/ampapi"
)

// artworkClient is used for proxying artwork and catalog API responses.
// http.DefaultClient has no timeout and can hang indefinitely on slow CDN responses.
var artworkClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        20,
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConnsPerHost: 10,
	},
}

// drmAccountAdapter adapts *drm.DRMManager to apple.AccountTokenSource so the
// apple package stays decoupled from the drm package's concrete types.
type drmAccountAdapter struct{ dm *drm.DRMManager }

func (a *drmAccountAdapter) GetMusicToken(ctx context.Context) (devToken, musicToken string, err error) {
	info, err := a.dm.GetAccount(ctx)
	return info.DevToken, info.MusicToken, err
}

func (a *drmAccountAdapter) GetProgressiveMVURL(ctx context.Context, adamID uint64) (string, string, error) {
	return a.dm.GetProgressiveMVURL(ctx, adamID)
}

func (a *drmAccountAdapter) DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
	return a.dm.DecryptItunSamples(ctx, adamID, samples)
}

// ── Request / response types ──────────────────────────────────────────────────

// PlaybackRequest is the POST /api/v1/playback request body.
type PlaybackRequest struct {
	AssetID    string `json:"assetId"`
	Storefront string `json:"storefront"`
	// Token and MUT are optional per-request overrides for the Apple Music API
	// bearer JWT and media-user-token. When provided they take priority over the
	// engine's cached token and the DRM session's media-user-token, so the
	// renderer can supply the tokens MusicKit already has.
	Token        string `json:"token"`
	MUT          string `json:"mediaUserToken"`
	Capabilities struct {
		Lossless bool `json:"lossless"`
		Video    bool `json:"video"`
		Atmos    bool `json:"atmos"`
	} `json:"capabilities"`
	MVMaxHeight int `json:"mvMaxHeight"` // 0 = auto (defaults to 1080 in provider)
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
	epoch          *epochManager
	lastDRMSession atomic.Value // stores string; tracks session transitions

	// Proactive DRM session tracking
	drmReadyMu      sync.Mutex
	drmReadySince   time.Time   // when FairPlayReady was last achieved
	drmRefreshAt    time.Time   // scheduled proactive-refresh fire time
	drmRefreshTimer *time.Timer // cancels previous timer on new FairPlayReady
}

// drmSessionTTL is Apple's approximate FairPlay session lifetime.
// We schedule a proactive refresh event 5 minutes before expiry.
const drmSessionTTL = 24 * time.Hour
const drmRefreshLeadTime = 5 * time.Minute

func newEngineLifecycle(epoch *epochManager) *engineLifecycle {
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

// OnFairPlayReady is called by the event watcher when the DRM backend
// transitions to FairPlayReady. It resets the session-age clock and
// schedules a proactive drm.refresh_due event (via onRefreshDue) so the
// JS can pre-warm before the session expires and avoid the losslessWait stall.
func (l *engineLifecycle) OnFairPlayReady(onRefreshDue func()) {
	l.drmReadyMu.Lock()
	defer l.drmReadyMu.Unlock()
	l.drmReadySince = time.Now()
	l.drmRefreshAt = l.drmReadySince.Add(drmSessionTTL - drmRefreshLeadTime)
	if l.drmRefreshTimer != nil {
		l.drmRefreshTimer.Stop()
	}
	l.drmRefreshTimer = time.AfterFunc(drmSessionTTL-drmRefreshLeadTime, onRefreshDue)
}

// DRMReadySince returns when FairPlayReady was last achieved (zero if never).
func (l *engineLifecycle) DRMReadySince() time.Time {
	l.drmReadyMu.Lock()
	t := l.drmReadySince
	l.drmReadyMu.Unlock()
	return t
}

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
	epoch   *epochManager      // engine epoch; advanced by subsystems, not by the bus
	ring    [ringSize]sseEvent // circular replay buffer
	ringPos int                // next write slot (unbounded; masked on access)
	ringLen int                // valid entries (0 .. ringSize)
}

func newEventBus(epoch *epochManager) *eventBus {
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
	for id, ch := range b.clients {
		select {
		case ch <- ev:
		default:
			// A consumer that can't keep up must not stall the bus, and silently dropping
			// events would leave it believing a stale state is current. Disconnect it: the
			// handler sees the closed channel, tells the client, and the client reconnects
			// with Last-Event-ID — getting a replay, or a replay.truncated resync signal.
			close(ch)
			delete(b.clients, id)
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

	if afterID > b.seq {
		// The client has seen events this bus never issued: the engine restarted and its
		// IDs started over. Nothing it remembers applies; make it resync.
		truncated = true
	} else if afterID >= 0 && b.ringLen > 0 {
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

// circuitBreaker is a simple three-state breaker for session-open failures.
// States: closed (normal) → open (fast-fail) → closed (after resetAfter).
type circuitBreaker struct {
	mu         sync.Mutex
	failures   int
	openUntil  time.Time
	threshold  int           // consecutive failures to trip
	resetAfter time.Duration // how long to stay open before auto-reset
}

func newCircuitBreaker(threshold int, resetAfter time.Duration) *circuitBreaker {
	return &circuitBreaker{threshold: threshold, resetAfter: resetAfter}
}

// Allow returns false when the breaker is open (fast-fail mode).
func (cb *circuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if !cb.openUntil.IsZero() && time.Now().Before(cb.openUntil) {
		return false
	}
	return true
}

// RecordSuccess resets the failure counter and closes the breaker.
func (cb *circuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	cb.failures = 0
	cb.openUntil = time.Time{}
	cb.mu.Unlock()
}

// RecordFailure increments the counter and trips the breaker at threshold.
func (cb *circuitBreaker) RecordFailure() {
	cb.mu.Lock()
	cb.failures++
	if cb.failures >= cb.threshold {
		cb.openUntil = time.Now().Add(cb.resetAfter)
	}
	cb.mu.Unlock()
}

// State returns "closed", "open", or "half-open" for status reporting.
// Half-open: the cooldown elapsed but no success has reset the counter yet,
// so the next request is a trial and one more failure re-opens the breaker.
func (cb *circuitBreaker) State() string {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	switch {
	case !cb.openUntil.IsZero() && time.Now().Before(cb.openUntil):
		return "open"
	case cb.failures >= cb.threshold:
		return "half-open"
	default:
		return "closed"
	}
}

// APIServer is the long-running HTTP daemon started by --api <port>.
type APIServer struct {
	// Per-instance playback bookkeeping. These used to be package-level maps, which made two
	// servers in one process share state; they belong to the server that owns the sessions.
	vsegStates  sync.Map // sessionID → *vsegState: segmented-video producers
	mvPreparing sync.Map // assetID → struct{}: faststart caches being built, so the info endpoint can say "preparing" and duplicate jobs are avoided
	mvEphemeral sync.Map // assetID → struct{}: mv-dl files written under "caching disabled", deleted on session release

	srv         *http.Server
	tlsSrv      *http.Server // HTTPS listener on port+1 for <video src> byte-range seeking
	port        int
	pm          *playback.Manager
	em          *export.Manager
	dm          *drm.DRMManager
	session     *drm.SessionManager // canonical source for MUT + storefront
	epoch       *epochManager       // shared engine epoch; advanced by subsystems
	lifecycle   *engineLifecycle    // single coordinator for epoch advancement
	events      *eventBus
	drmReady    bool   // true when a DRM backend was constructed (native build + drm dir found)
	eagerStart  bool   // launch the drm binary at Start() when a session exists
	sessionDir  string // session/credential directory guarded by sessionLock
	sessionLock *drm.SessionLock
	backendName string              // configured backend name ("native")
	scheduler   *prefetch.Scheduler // background cache-warming scheduler
	diskCache   *diskcache.Cache    // per-track decrypted audio disk cache
	alac        *alacGate           // parks background ALAC downloads while the player's track starts
	libStore    *library.Store      // local library metadata cache (songs, playlists)
	vlcPlayer   *vlc.Player         // nil when libvlc is not available

	tokenMu     sync.RWMutex
	cachedToken string // bearer token cached from the most recent browser request

	mkTokenMu    sync.RWMutex
	mkMusicToken string // MusicKit JS Music-User-Token (web auth, not Android DRM)

	// Observability
	openLatency *ring.Buffer    // session-open latency ring buffer (last 100 opens)
	openCB      *circuitBreaker // circuit breaker for session-open failures

	// shutdownCtx is cancelled in Stop() to signal background goroutines to exit.
	shutdownCtx  context.Context
	shutdownStop context.CancelFunc
}

// ServerConfig holds infrastructure values resolved once at startup.
// All fields are optional: zero values fall back to sensible defaults.
type ServerConfig struct {
	DRMBinaryPath string
	DRMBaseDir    string
	// ExportFloorKbps is the minimum export rate (KiB/s) while playback
	// streams; 0 selects the export package default.
	ExportFloorKbps int
}

// NewAPIServer wires all routes.
func NewAPIServer(port int, cfg ServerConfig) *APIServer {
	initMVPrefs()
	epoch := newEpochManager()
	shutCtx, shutStop := context.WithCancel(context.Background())
	s := &APIServer{
		port:         port,
		epoch:        epoch,
		lifecycle:    newEngineLifecycle(epoch),
		events:       newEventBus(epoch),
		openLatency:  ring.New(100),
		openCB:       newCircuitBreaker(3, 60*time.Second),
		shutdownCtx:  shutCtx,
		shutdownStop: shutStop,
	}

	// DRM subsystem constructed first: DRMManager is passed to the PlaybackManager
	// as a fairplay.CBCSDialer so cbcs.go uses in-process decryption via NativeBackend.
	// BackendConfig carries what NativeBackend needs (BaseDir, DeviceInfo).
	// Resolve the DRM directory marker: use config if set, otherwise auto-discover
	// drm/drm-native relative to the working directory. Only its directory is
	// used (NativeBackend runs in-process; nothing is executed).
	drmBinaryPath := cfg.DRMBinaryPath
	if drmBinaryPath == "" {
		// Prefer drm directory with libdrm_client.so when present.
		for _, candidate := range []string{"drm"} {
			if abs, err := filepath.Abs(candidate); err == nil {
				if _, err := os.Stat(abs); err == nil {
					drmBinaryPath = abs
					break
				}
			}
		}
	}

	// Derive the DRM session directory from the marker path when not explicitly
	// configured: files/ directory next to libdrm_client.so.
	drmBaseDir := cfg.DRMBaseDir
	if drmBaseDir == "" && drmBinaryPath != "" {
		drmBaseDir = filepath.Join(drmBinaryPath, "files")
	}
	// For native backend, use a default path if not set
	if drmBaseDir == "" {
		drmBaseDir = "/tmp/aml-drm/files"
	}
	drmSession := drm.NewSessionManager(drmBaseDir)

	// NativeBackend (in-process CGO, libdrm_client.so) is the DRM backend.
	// NewNativeBackend returns nil when the native_backend build tag is absent.
	var drmBackend drm.DRMBackend
	var drmDir string // directory containing libdrm_client.so and files/
	if drmBinaryPath != "" {
		drmDir = drmBinaryPath
	}
	if drmDir == "" {
		drmDir = "/tmp/aml-drm"
	}
	drmBackend = drm.NewNativeBackend(drmDir)
	if drmBackend != nil {
		s.backendName = "native"
		slog.Info("DRM backend", "name", "native")
		s.dm = drm.NewDRMManager(
			drmBackend,
			drmSession,
			func(snap drm.DRMSnapshot) {
				s.lifecycle.OnDRMStateChanged(snap.State.Session.String())
				if snap.State.FairPlay == drm.FairPlayReady {
					s.lifecycle.OnFairPlayReady(func() {
						// Fired ~5min before the expected 24h FairPlay session expiry.
						// Emit a drm.refresh_due SSE event so the JS can pre-warm a
						// session while the current one is still valid — avoiding the
						// losslessWait stall that would otherwise happen after expiry.
						s.events.emit("drm.refresh_due", map[string]any{
							"readySinceMs": s.lifecycle.DRMReadySince().UnixMilli(),
							"refreshAtMs":  s.lifecycle.DRMReadySince().Add(drmSessionTTL - drmRefreshLeadTime).UnixMilli(),
						})
					})
				}
				s.events.emit("drm", snap)
			},
			drm.BackendConfig{BaseDir: drmBaseDir, DisableHiRes: os.Getenv("AML_DISABLE_HIRES") == "1"},
			drm.DefaultRestartPolicy,
		)
	} else {
		slog.Warn("DRM backend unavailable (native_backend build tag not set); DRM features disabled")
	}
	s.session = drmSession
	s.drmReady = drmBackend != nil
	s.sessionDir = drmBaseDir

	// Eager-start decision (executed in Start(), after the session lock is held):
	// if a session DB exists, initialise DRM immediately so process/fairplay
	// state is visible without waiting for the first playback request.
	s.eagerStart = s.drmReady && drmSession.HasSession()

	// PlaybackManager receives DRMManager as the CBCSDialer for ALAC/Atmos.
	// DRMManager.DialCBCS auto-starts DRM if a session exists, then returns an
	// in-process pipe speaking the FairPlay sample wire protocol.
	// Pass nil interfaces explicitly when DRM is unavailable — a (*DRMManager)(nil)
	// passed as a non-nil interface would panic on first method call.
	var cbcsDialer fairplay.CBCSDialer
	var acctSource apple.AccountTokenSource
	if s.dm != nil {
		cbcsDialer = s.dm
		acctSource = &drmAccountAdapter{s.dm}
	}
	s.pm = playback.NewWithProvider(apple.NewProviderWithCBCS(cbcsDialer, acctSource))
	s.installReleaseHook()

	// Prefetch scheduler — credentials are resolved lazily at Submit time
	// so token rotations are picked up automatically.
	// Use ev.Kind as the SSE event name so clients can subscribe to specific
	// phases (prefetch.cached, prefetch.done, …) without filtering JSON.
	s.scheduler = prefetch.NewScheduler(s.pm, s.token, s.mediaUserToken, func(ev prefetch.Event) {
		s.events.emit(string(ev.Kind), ev)
	}, prefetch.DefaultWorkers)
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-s.shutdownCtx.Done():
				return
			case <-t.C:
				s.scheduler.PruneExpiredPreWarmed()
			}
		}
	}()

	// Pre-warm TLS connection to Apple's FairPlay license server so the first
	// AcquireKey call skips the handshake latency. Mirrors Android
	// FootHillDecryptionKeyController pre-warming the CDM at player init time.
	go fairplay.WarmLicensePool(s.shutdownCtx)

	// Disk cache — decrypted per-track audio; falls back gracefully on error.
	// Limits (persistLimitMB, persistTTLDays) are pushed by the frontend on
	// startup via PUT /api/v1/cache/config; zero means unlimited / no TTL.
	if cacheBase, err := os.UserCacheDir(); err == nil {
		if dc, err := diskcache.New(filepath.Join(cacheBase, "apple-music-linux", "playback")); err == nil {
			s.diskCache = dc
			s.alac = newALACGate()
			go func() {
				t := time.NewTicker(time.Hour)
				defer t.Stop()
				for {
					select {
					case <-s.shutdownCtx.Done():
						return
					case <-t.C:
						s.diskCache.EvictExpired()
					}
				}
			}()
		}

		// Library metadata cache — songs + playlist membership for instant queue ops.
		libCacheDir := filepath.Join(cacheBase, "apple-music-linux")
		if err := os.MkdirAll(libCacheDir, 0o700); err == nil { // holds library.key
			s.libStore = library.New(libCacheDir)
			// Auto-sync removed: the Go-side API client cannot authenticate with
			// Apple's API (GetToken is broken; Android DRM tokens don't pair with
			// the web developer JWT). Sync is now driven by the JS layer via
			// POST /api/v1/library/ingest — trigger it from Settings → Library.
		}
	}

	var exportCache export.AudioCache // nil interface when the disk cache is disabled
	if s.diskCache != nil {
		exportCache = diskAudioCache{s.diskCache}
	}
	s.em = export.NewManager(s.pm, func(ev export.ExportEvent) {
		s.events.emit("export", ev)
	}, export.Options{Cache: exportCache, FloorBps: int64(cfg.ExportFloorKbps) << 10, OutputRoots: exportRoots()})

	mux := http.NewServeMux()

	// Bundled fonts — served from fonts/ next to the engine binary so the
	// webview can load SF Pro via @font-face without depending on system fonts.
	if exe, err := os.Executable(); err == nil {
		fontsDir := filepath.Join(filepath.Dir(exe), "fonts")
		mux.Handle("/fonts/", http.StripPrefix("/fonts/", http.FileServer(http.Dir(fontsDir))))
	}

	mux.HandleFunc("GET /api/v1/status", cors(s.handleStatus))
	mux.HandleFunc("GET /api/v1/tools", cors(s.handleTools))
	mux.HandleFunc("GET /api/v1/capabilities", cors(s.handleCapabilities))
	mux.HandleFunc("GET /api/v1/events", cors(s.handleEvents))
	mux.HandleFunc("GET /api/v1/metrics", cors(s.handleMetrics))

	mux.HandleFunc("POST /api/v1/playback", cors(s.handleCreatePlayback))
	mux.HandleFunc("GET /api/v1/playback/{id}/audio", cors(s.handlePlaybackAudio))
	mux.HandleFunc("GET /api/v1/playback/{id}/video", cors(s.handlePlaybackVideo))
	mux.HandleFunc("GET /api/v1/playback/{id}/video-dl", cors(s.handlePlaybackVideoNative))
	mux.HandleFunc("GET /api/v1/playback/{id}/video-dl-info", cors(s.handlePlaybackVideoNativeInfo))
	mux.HandleFunc("GET /api/v1/playback/{id}/video-raw", cors(s.handlePlaybackVideoRaw))
	mux.HandleFunc("GET /api/v1/playback/{id}/video-es", cors(s.handlePlaybackVideoES))
	mux.HandleFunc("GET /api/v1/playback/{id}/vseg/init", cors(s.handlePlaybackVsegInit))
	mux.HandleFunc("GET /api/v1/playback/{id}/vseg/seg/{n}", cors(s.handlePlaybackVsegSeg))
	mux.HandleFunc("GET /api/v1/playback/{id}/vseg/manifest", cors(s.handlePlaybackVsegManifest))
	mux.HandleFunc("GET /api/v1/playback/{id}/vseg/seek", cors(s.handlePlaybackVsegSeek))
	mux.HandleFunc("DELETE /api/v1/playback/{id}/vseg", cors(s.handlePlaybackVsegStop))
	mux.HandleFunc("POST /api/v1/playback/{id}/precache", cors(s.handlePlaybackPrecache))
	mux.HandleFunc("DELETE /api/v1/playback/{id}", cors(s.handleDeletePlayback))

	// Playback context — renderer signals user intent; scheduler decides what to warm.
	mux.HandleFunc("PUT /api/v1/playback/context", cors(s.handlePlaybackContext))

	// Cache endpoints — config, stats, clear, and MV-specific settings.
	mux.HandleFunc("PUT /api/v1/cache/config", cors(s.handleCacheConfig))
	mux.HandleFunc("GET /api/v1/cache/stats", cors(s.handleCacheStats))
	mux.HandleFunc("DELETE /api/v1/cache/playback", cors(s.handleCachePlaybackDelete))
	mux.HandleFunc("GET /api/v1/cache/mv", cors(s.handleMVCacheGet))
	mux.HandleFunc("PUT /api/v1/cache/mv", cors(s.handleMVCachePut))
	mux.HandleFunc("DELETE /api/v1/cache/mv", cors(s.handleMVCacheClear))

	// Job status and cancellation for cache-warming jobs.
	mux.HandleFunc("GET /api/v1/jobs/{id}", cors(s.handleJobStatus))
	mux.HandleFunc("DELETE /api/v1/jobs/{id}", cors(s.handleJobCancel))

	mux.HandleFunc("GET /api/v1/metadata/{id}", cors(s.handleMetadata))
	mux.HandleFunc("GET /api/v1/artwork/{id}", cors(s.handleArtwork))
	mux.HandleFunc("GET /api/v1/lyrics/{id}", cors(s.handleLyrics))
	mux.HandleFunc("GET /api/v1/audioanalysis/{id}", cors(s.handleAudioAnalysis))

	mux.HandleFunc("POST /api/v1/export", cors(s.handleExportCreate))
	mux.HandleFunc("GET /api/v1/export", cors(s.handleExportList))
	mux.HandleFunc("GET /api/v1/export/{id}", cors(s.handleExportGet))
	mux.HandleFunc("DELETE /api/v1/export/{id}", cors(s.handleExportCancel))
	mux.HandleFunc("POST /api/v1/export/{id}/retry", cors(s.handleExportRetry))
	mux.HandleFunc("POST /api/v1/export/{id}/priority", cors(s.handleExportPriority))

	// DRM subsystem — wrapper lifecycle, authentication, session management.
	// The frontend expresses intent (login, submit 2FA); the engine orchestrates.
	mux.HandleFunc("GET /api/v1/drm/status", cors(s.handleDRMStatus))
	mux.HandleFunc("POST /api/v1/drm/authenticate", cors(s.handleDRMAuthenticate))
	mux.HandleFunc("POST /api/v1/drm/challenge", cors(s.handleDRMChallenge))
	mux.HandleFunc("POST /api/v1/drm/logout", cors(s.handleDRMLogout))
	mux.HandleFunc("DELETE /api/v1/drm/session", cors(s.handleDRMClearSession))

	// Library — local metadata cache (songs, playlists, playlist tracks).
	// Mirrors what Android's MediaLibrary and Windows' AMPLibraryAgent provide:
	// instant queue building from local SQLite instead of live Apple Music API calls.
	mux.HandleFunc("POST /api/v1/library/token", cors(s.handleLibraryToken))
	mux.HandleFunc("POST /api/v1/library/sync", cors(s.handleLibrarySync))
	mux.HandleFunc("POST /api/v1/library/ingest", cors(s.handleLibraryIngest))
	mux.HandleFunc("GET /api/v1/library/status", cors(s.handleLibraryStatus))
	mux.HandleFunc("GET /api/v1/library/playlists", cors(s.handleLibraryPlaylists))
	mux.HandleFunc("GET /api/v1/library/playlists/{id}/tracks", cors(s.handleLibraryPlaylistTracks))
	mux.HandleFunc("GET /api/v1/library/albums/{id}/tracks", cors(s.handleLibraryAlbumTracks))

	// Catalog — search and entity detail endpoints for frontend UIs.
	// These are purely additive and proxy the Apple Music catalog API.
	mux.HandleFunc("GET /api/v1/catalog/albums/{id}", cors(s.handleCatalogAlbum))
	mux.HandleFunc("GET /api/v1/catalog/playlists/{id}", cors(s.handleCatalogPlaylist))
	mux.HandleFunc("GET /api/v1/catalog/artists/{id}", cors(s.handleCatalogArtist))

	// Personalised feeds (dormant: no bundled frontend uses them; see
	// handlers_recommendations.go and docs/api.md).
	mux.HandleFunc("GET /api/v1/recommendations", cors(s.recommendationsHandler(ampapi.KindRecommendations)))
	mux.HandleFunc("GET /api/v1/recommendations/heavy-rotation", cors(s.recommendationsHandler(ampapi.KindHeavyRotation)))
	mux.HandleFunc("GET /api/v1/recommendations/recently-played", cors(s.recommendationsHandler(ampapi.KindRecentlyPlayed)))

	// VLC player — libvlc-backed playback for ALAC/Atmos that the browser cannot decode.
	// Routes are no-ops when libvlc is not installed; frontend falls back to MSE.
	s.vlcPlayer, _ = vlc.New() // nil if libvlc unavailable
	mux.HandleFunc("POST /api/v1/vlc/load", cors(s.handleVLCLoad))
	mux.HandleFunc("POST /api/v1/vlc/pause", cors(s.handleVLCPause))
	mux.HandleFunc("POST /api/v1/vlc/resume", cors(s.handleVLCResume))
	mux.HandleFunc("POST /api/v1/vlc/stop", cors(s.handleVLCStop))
	mux.HandleFunc("GET /api/v1/vlc/time", cors(s.handleVLCTime))
	mux.HandleFunc("POST /api/v1/vlc/seek", cors(s.handleVLCSeek))
	mux.HandleFunc("POST /api/v1/vlc/volume", cors(s.handleVLCVolume))

	// Benchmark/diagnostics surface (additive; no effect on playback).
	// /api/v1/debug/runtime exposes scalar runtime metrics the harness samples
	// (goroutines, heap, GC) — things only the engine process itself can report.
	// /debug/pprof/* serves standard profiles for flamegraphs.
	mux.HandleFunc("GET /api/v1/debug/runtime", cors(s.handleRuntimeStats))
	// pprof heap dumps expose in-memory key material; only register when AML_DEBUG=1.
	if os.Getenv("AML_DEBUG") == "1" {
		mux.HandleFunc("GET /debug/pprof/", httppprof.Index)
		mux.HandleFunc("GET /debug/pprof/cmdline", httppprof.Cmdline)
		mux.HandleFunc("GET /debug/pprof/profile", httppprof.Profile)
		mux.HandleFunc("GET /debug/pprof/symbol", httppprof.Symbol)
		mux.HandleFunc("GET /debug/pprof/trace", httppprof.Trace)
	}

	// Wrap the mux so that every OPTIONS request is handled before route
	// matching.  Go 1.22+ method-prefixed routes ("GET /path") never match
	// OPTIONS, causing preflights to 405.  Chrome also requires the response
	// to include Access-Control-Allow-Private-Network: true when fetching
	// across localhost ports (CORS-RFC1918 / Private Network Access).
	s.srv = &http.Server{
		Handler:           corsPreflightHandler(requireToken(os.Getenv("AML_API_TOKEN"), mux)),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
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
	if err == nil {
		l = guardListener(l)
	}
	if err != nil {
		if s.sessionLock != nil {
			s.sessionLock.Release()
			s.sessionLock = nil
		}
		return err
	}

	// Eager-start now that the session lock is held.
	// Retry with exponential backoff: NativeBackend initializes drm_init
	// asynchronously and FairPlay may not be ready immediately. A single immediate
	// GetAccount would fail with "not ready". We retry until ready or the
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
					slog.Warn("DRM auto-start: backend not ready after 30s", "err", lastErr)
					return
				case <-time.After(delay):
					if delay < 5*time.Second {
						delay *= 2
					}
				}
			}
		}()
	}

	// TLS listener on the configured port (primary API endpoint).
	// All internal engine communication is encrypted via TLS on localhost.
	// Electron trusts this loopback cert via session.setCertificateVerifyProc.
	tlsCfg, err := loopbackTLSConfig()
	if err != nil {
		slog.Error("loopback TLS setup failed", "err", err)
		return fmt.Errorf("TLS setup failed: %w", err)
	}
	s.tlsSrv = &http.Server{
		Handler:           s.srv.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
		TLSConfig:         tlsCfg,
	}
	slog.Info("Apple Music API (TLS) ready", "addr", fmt.Sprintf("https://127.0.0.1:%d", s.port))
	go s.tlsSrv.ServeTLS(l, "", "") //nolint:errcheck

	return nil
}

// Stop gracefully shuts down the HTTP server and the DRM backend.
// The session DB is preserved so the next start reuses the session.
func (s *APIServer) Stop() {
	// Stop VLC immediately so audio cuts off before the rest of the shutdown sequence.
	if s.vlcPlayer != nil {
		s.vlcPlayer.Close()
	}
	// Cancel the server lifetime context to stop background goroutines.
	s.shutdownStop()
	// Stop the export worker before shutting down playback.
	if s.em != nil {
		s.em.Stop()
	}
	if s.scheduler != nil {
		s.scheduler.Stop()
	}
	// Stop the wrapper process first so it doesn't keep running as an orphan.
	// Session files are NOT cleared — they persist for the next server start.
	if s.dm != nil {
		s.dm.Shutdown()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.srv.Shutdown(ctx) //nolint:errcheck
	if s.tlsSrv != nil {
		s.tlsSrv.Shutdown(ctx) //nolint:errcheck
	}
	// Release the session lock last, after the wrapper is fully stopped.
	// Guard nil: when drmReady==false, Start() never acquires the lock.
	if s.sessionLock != nil {
		s.sessionLock.Release()
		s.sessionLock = nil
	}
}

// corsPreflightHandler is the outermost handler. The API is unauthenticated on
// a fixed port, so it rejects any request a foreign web page could forge:
// a non-loopback Host (DNS rebinding) or a browser Origin outside the
// allowlist (cross-site "simple" POSTs skip CORS preflight entirely).
// Media elements and the Electron main process send no Origin and pass.
func corsPreflightHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isAllowedOrigin(origin) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		setCORSHeaders(w, r)
		// Responses carry catalog text (lyrics as XML/VTT, metadata) — never let
		// a browser sniff them into an executable type.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// isAllowedOrigin matches origins exactly by scheme and hostname — a prefix
// test would also accept e.g. http://localhost.attacker.example.
func isAllowedOrigin(origin string) bool {
	if origin == "https://music.apple.com" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" {
		return false
	}
	return isLoopbackHost(u.Host)
}

// setCORSHeaders writes all CORS response headers onto w based on the request origin.
func setCORSHeaders(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	switch {
	case origin != "" && isAllowedOrigin(origin):
		w.Header().Set("Access-Control-Allow-Origin", origin)
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

// ── Library metadata cache handlers ──────────────────────────────────────────

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

// mediaUserToken returns the Media User Token from the DRM session file.
// Refreshed on every call so wrapper token rotations are picked up automatically.
func (s *APIServer) mediaUserToken() string {
	if s.session != nil {
		if mt := s.session.ReadMusicToken(); mt != "" {
			return mt
		}
	}
	return ""
}

// storefront returns the storefront identifier from the DRM session file.
// The raw session value is normalized (strips the platform/content-class suffix
// the wrapper appends, e.g. "143467-2,31" → "143467").
func (s *APIServer) storefront() string {
	if s.session != nil {
		if sf := s.session.ReadStorefrontID(); sf != "" {
			return drm.NormalizeStorefrontID(sf)
		}
	}
	return ""
}

// token returns the bearer token cached from the most recent browser request.
func (s *APIServer) token() string {
	s.tokenMu.RLock()
	t := s.cachedToken
	s.tokenMu.RUnlock()
	return t
}

// setToken caches a bearer token received from the browser renderer so
// unauthenticated handlers (metadata, lyrics, catalog) can use it without
// requiring a config entry.
func (s *APIServer) setToken(tok string) {
	if tok == "" {
		return
	}
	s.tokenMu.Lock()
	s.cachedToken = tok
	s.tokenMu.Unlock()
}

// musicUserToken returns the MusicKit JS Music-User-Token if one has been
// pushed from the renderer, otherwise falls back to the DRM session token.
func (s *APIServer) musicUserToken() string {
	s.mkTokenMu.RLock()
	t := s.mkMusicToken
	s.mkTokenMu.RUnlock()
	if t != "" {
		return t
	}
	return s.mediaUserToken()
}

func (s *APIServer) setMusicUserToken(tok string) {
	if tok == "" {
		return
	}
	s.mkTokenMu.Lock()
	s.mkMusicToken = tok
	s.mkTokenMu.Unlock()
}

func (s *APIServer) lang(r *http.Request) string {
	if al := r.Header.Get("Accept-Language"); al != "" {
		tag := strings.SplitN(al, ",", 2)[0]
		tag = strings.SplitN(tag, ";", 2)[0]
		if tag = strings.TrimSpace(tag); tag != "" {
			return tag
		}
	}
	return "en-US"
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(append(b, '\n')) //nolint:errcheck
}

func randID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

// exportRoots returns the directories exports may write into. The request body that names
// the output directory comes from a web page, so by default it is confined to the user's
// home; AML_EXPORT_ROOTS (a colon-separated list) replaces that.
func exportRoots() []string {
	if v := os.Getenv("AML_EXPORT_ROOTS"); v != "" {
		return filepath.SplitList(v)
	}
	if home, err := os.UserHomeDir(); err == nil {
		return []string{home}
	}
	return []string{"/nonexistent"} // no home to anchor to: refuse rather than allow everything
}

// installReleaseHook frees a session's server-side resources however the session ends.
// DELETE /playback/{id} does this itself; a session that simply expires, or whose client
// vanished, would otherwise leave its producers running and its cache file pinned.
func (s *APIServer) installReleaseHook() {
	s.pm.SetReleaseHook(func(id string) {
		s.stopMVGrowing(id)
		s.stopVsegSession(id)
	})
}
