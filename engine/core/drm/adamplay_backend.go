//go:build (linux || windows) && adamplay_backend

package drm

/*
#cgo linux CFLAGS: -D_GNU_SOURCE
#cgo linux LDFLAGS: -ldrm_client -lcrypto -lssl -ldl
#cgo windows LDFLAGS: -ldrm_client

#include <stdint.h>
#include <stdlib.h>

// ── drm_client.h declarations ───────────────────────────────────────────────

typedef void (*drm_auth_callback_t)(const char *challenge_type, char *output_buffer, int buffer_size, void *user_data);
typedef void (*drm_state_callback_t)(const char *state_name, void *user_data);

typedef struct {
    const char              *base_directory;
    const char              *lib64_directory;
    const char              *username;
    const char              *password;
    const char              *device_info;
    int                      offline_only;
    drm_auth_callback_t      auth_callback;
    void                    *auth_user_data;
    drm_state_callback_t     state_callback;
    void                    *state_user_data;
} drm_config;

typedef uint64_t drm_adam_id_t;

int   drm_init(const drm_config *config);
void  drm_shutdown(void);
char *drm_get_account(void);
char *drm_get_hls_url(drm_adam_id_t asset_id);
int   drm_get_progressive_url(drm_adam_id_t asset_id, char **out_url, char **out_download_key, int *out_has_decryptor);
int   drm_decrypt_itun(drm_adam_id_t asset_id, uint8_t *sample_data, uint32_t input_size, uint32_t *output_size);

// ── hybris / Android library path (drm_hybris.c) ────────────────────────────
int  hybris_backend_init(const char *linker_dir, const char *lib64_dir, const char *core_path);
int  hybris_fairplay_init(const char *base_dir, const char *device_info, const char *lib64_dir, const char *username, const char *password, drm_auth_callback_t auth_cb, void *auth_ud);
// keep in sync with drm/drm_hybris.h
#define HYBRIS_ERR_STALE_CONTEXT (-2)
const char *hybris_last_error(void);
void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri, unsigned *epoch);
int  hybris_backend_decrypt(void *ctx, unsigned epoch, uint8_t *data, uint32_t len);

// ── CGO bridge function pointers ────────────────────────────────────────────
extern void adamplayBridgeAuth(char *ctype, char *buf, int size, void *ud);
extern void adamplayBridgeState(char *state, void *ud);
*/
import "C"

import (
	"context"
	"encoding/json"
	"engine/internal/vlog"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime/cgo"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// adamplayBackend implements the DRM backend using the native implementation
type adamplayBackend struct {
	mu      sync.Mutex
	config  BackendConfig
	drmDir  string // directory containing libdrm_client.so and files/
	authSrc AuthSource
	eventCh chan DRMEvent
	running bool
	// Global state callback channel for C callbacks
	stateCh         chan string
	stateHandle     cgo.Handle
	authBox         unsafe.Pointer     // C-allocated cell holding a cgo.Handle to this backend, for 2FA callbacks
	authSrcV        atomic.Value       // authSrcHolder; read by the 2FA callback while Start holds mu
	stateBox        unsafe.Pointer     // C-allocated cell holding stateHandle; the pointer handed to C
	accountFallback func() AccountInfo // web-session token when no credential files exist (guarded by mu)

	// In-flight accounting for calls into the C library (guarded by mu). Stop must not
	// tear the library down under a running call, and key contexts handed out by one
	// Start are meaningless after the next, so each Start gets a generation.
	active      int           // calls currently inside the C library
	drained     chan struct{} // closed when active reaches 0 while Stop is waiting
	gen         uint64        // incremented by every successful Start
	hybrisReady bool          // true when hybris_backend_init+hybris_fairplay_init succeeded

	// hybrisInitDone is closed when the background hybris init goroutine completes
	// (success or failure). nil means hybris was initialised synchronously (login
	// path) or has not started yet.
	hybrisInitDone chan struct{}

	loops    sync.Once   // starts stateLoop once for the life of the process
	retrying atomic.Bool // a RetryFairPlay is in progress; every web-session note would otherwise start another
}

var errBackendStopped = errors.New("DRM backend is not running")

// enter registers one call into the C library. gen is the generation the caller's
// state (key contexts) belongs to, or 0 for calls that carry none. The returned func
// must be called when the call is done.
func (b *adamplayBackend) enter(gen uint64) (leave func(), err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running || (gen != 0 && gen != b.gen) {
		return nil, errBackendStopped
	}
	b.active++
	return b.leave, nil
}

func (b *adamplayBackend) leave() {
	b.mu.Lock()
	b.active--
	if b.active == 0 && b.drained != nil {
		close(b.drained)
		b.drained = nil
	}
	b.mu.Unlock()
}

func (b *adamplayBackend) currentGen() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gen
}

// AdamplayBackend creates the in-process Widevine DRM backend
// drmDir is the directory containing libdrm_client.so and files/ folder with credentials
func AdamplayBackend(drmDir string) DRMBackend {
	b := &adamplayBackend{
		drmDir:  drmDir,
		eventCh: make(chan DRMEvent, 16),
		stateCh: make(chan string, 16),
	}
	b.stateHandle = cgo.NewHandle(b.stateCh)
	// Pass the handle to C inside C memory: converting an integer straight to
	// unsafe.Pointer is invalid cgo and flagged by go vet. The box lives as long
	// as the backend (one per process), so the callback never sees a freed cell.
	b.stateBox = C.malloc(C.size_t(unsafe.Sizeof(uintptr(0))))
	*(*uintptr)(b.stateBox) = uintptr(b.stateHandle)
	b.authBox = C.malloc(C.size_t(unsafe.Sizeof(uintptr(0))))
	*(*uintptr)(b.authBox) = uintptr(cgo.NewHandle(b))
	return b
}

// Start launches the native DRM backend
func (b *adamplayBackend) Start(ctx context.Context, cfg BackendConfig) error {
	if cfg.Credentials.Email != "" {
		// A session-reuse start may still be loading FairPlay in the background; a sign-in
		// must not drive the same libraries at the same time.
		b.mu.Lock()
		done := b.hybrisInitDone
		b.mu.Unlock()
		if done != nil {
			select {
			case <-done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	b.config = cfg

	// One state loop for the process: stateCh outlives every Start, and several loops would
	// leak and could deliver state changes out of order.
	b.loops.Do(func() { go b.stateLoop() })

	// Determine paths:
	// - base_directory: the files/ folder where credentials are stored
	// - lib64_directory: the Android lib64 folder (if using Android libs) or empty for pure native
	baseDir := cfg.BaseDir
	if baseDir == "" {
		// Default: use files/ folder next to libdrm_client.so
		baseDir = filepath.Join(b.drmDir, "files")
	}
	// storeservicescore opens its account database below this directory while
	// constructing RequestContext. Logout removes mpl_db/, so recreate both
	// levels before handing the path to the native library; otherwise a fresh
	// login can appear authenticated without being able to persist accounts.sqlitedb.
	if err := os.MkdirAll(filepath.Join(baseDir, "mpl_db"), 0o700); err != nil {
		return fmt.Errorf("create DRM session directory: %w", err)
	}

	// Wipe stale FPS key-store and HTTP-cache files before drm_init opens them.
	// Apple FPS persistent keys expire (typically within a few hours). A key
	// cached in kvs.sqlitedb from a previous session will be returned by
	// hybris_open_kd_ctx_from_uri as if it were valid, but AES-CBC with an
	// expired key produces garbage audio. Deleting the key-value store forces
	// the Android library to negotiate a fresh FPS key from Apple on every
	// startup — the warmDefaultKeyContext pre-warm then overlaps with CDN
	// download, so the user pays no latency. httpcache caches the CKC HTTP
	// response; stale CKC can also carry wrong keys, so it is wiped too.
	// accounts.sqlitedb and cookies.sqlitedb are left untouched (Apple ID login).
	var removed []string
	for _, name := range []string{
		"kvs.sqlitedb", "kvs.sqlitedb-wal", "kvs.sqlitedb-shm",
		"kvs.db",
		"httpcache.sqlitedb", "httpcache.sqlitedb-wal", "httpcache.sqlitedb-shm",
	} {
		if err := os.Remove(filepath.Join(baseDir, "mpl_db", name)); err == nil {
			removed = append(removed, name)
		}
	}
	if len(removed) > 0 {
		log.Printf("[drm] cleared stale FairPlay key store: %s", strings.Join(removed, ", "))
	}

	// Prepare config
	cBaseDir := C.CString(baseDir)
	cDeviceInfo := C.CString(cfg.DeviceInfo)

	drmConfig := C.drm_config{
		base_directory:  cBaseDir,
		lib64_directory: nil,
		username:        nil,
		password:        nil,
		device_info:     cDeviceInfo,
		offline_only:    0,
		auth_callback:   (C.drm_auth_callback_t)(C.adamplayBridgeAuth),
		auth_user_data:  nil,
		state_callback:  (C.drm_state_callback_t)(C.adamplayBridgeState),
		// Pass stateCh as userdata via cgo.Handle
		state_user_data: b.stateBox,
	}

	// Pass credentials if provided
	if cfg.Credentials.Email != "" && cfg.Credentials.Password != "" {
		drmConfig.username = C.CString(cfg.Credentials.Email)
		drmConfig.password = C.CString(cfg.Credentials.Password)
	}

	// Initialize DRM
	ret := C.drm_init(&drmConfig)

	// Clean up strings
	C.free(unsafe.Pointer(cBaseDir))
	C.free(unsafe.Pointer(cDeviceInfo))
	if drmConfig.username != nil {
		C.free(unsafe.Pointer(drmConfig.username))
	}
	if drmConfig.password != nil {
		C.free(unsafe.Pointer(drmConfig.password))
	}

	if ret != 0 {
		return fmt.Errorf("drm_init failed with code %d", ret)
	}

	// Compute hybris paths once; used by both the sync and async init paths.
	lib64Dir := filepath.Join(filepath.Dir(baseDir), "rootfs", "system", "lib64")
	var hybrisLinkerDir string
	if exePath, err := os.Executable(); err == nil {
		hybrisLinkerDir = filepath.Join(filepath.Dir(exePath), "hybris-linker")
	}

	b.running = true
	b.gen++

	// Emit initial state — AAC is ready; ALAC state is determined below.
	b.emitState(DRMState{
		Process:  ProcessRunning,
		Manager:  ManagerReady,
		FairPlay: FairPlayUnknown,
		Recovery: RecoveryIdle,
	}, "native backend initialized (ALAC init pending)")

	if cfg.Credentials.Email != "" {
		// Login flow: run hybris synchronously so the caller can verify the
		// session-ready marker before returning "login succeeded". It runs even when FairPlay is
		// already up (a session that expired, or another account): hybris_fairplay_init then signs
		// in with the new credentials instead of initialising again.
		// b.mu is held for all of Start, so set hybrisReady here rather than in
		// runHybrisInit (sync.Mutex is not re-entrant).
		if err := b.signIn(ctx, baseDir, lib64Dir, hybrisLinkerDir, cfg); err != nil {
			// A sign-in that did not complete leaves no half-started backend behind.
			b.running = false
			C.drm_shutdown()
			return err
		}
		b.hybrisReady = true
		b.emitFairPlayReady()
	} else if !b.hybrisReady {
		// Session-reuse path: spin hybris init in the background so Start()
		// returns immediately and AAC playback works while hybris loads (~11 s).
		// DialCBCS will wait on hybrisInitDone before opening a CBCS connection.
		done := make(chan struct{})
		b.hybrisInitDone = done
		go func() {
			defer close(done)
			if err := b.runHybrisInit(baseDir, lib64Dir, hybrisLinkerDir, cfg); err != nil {
				log.Printf("[drm] FairPlay not ready, ALAC disabled: %v", err)
			} else {
				b.mu.Lock()
				b.hybrisReady = true
				b.mu.Unlock()
				b.emitFairPlayReady()
			}
		}()
	}

	return nil
}

// runHybrisInit initialises the hybris+Android FairPlay path and returns why it is not
// ready (nil when it is). Errors about this installation start with SetupErrorPrefix. It is called either from Start (login flow, b.mu held) or
// from a background goroutine (session reuse, b.mu not held), so it must not
// touch b.mu or b.hybrisReady; the caller records the result.
func (b *adamplayBackend) runHybrisInit(baseDir, lib64Dir, hybrisLinkerDir string, cfg BackendConfig) error {
	// Guard: libhybris-core.so calls exit(1) if q.so is missing.
	qso := filepath.Join(hybrisLinkerDir, "q.so")
	if _, err := os.Stat(qso); err != nil {
		return setupError("the Android linker shim is missing (%s); reinstall Adam", qso)
	}
	if _, err := os.Stat(lib64Dir); err != nil {
		return setupError("the FairPlay libraries are not installed (looked in %s); restart Adam to download them, or run scripts/fetch-fairplay-libs.sh", lib64Dir)
	}

	cLinker := C.CString(hybrisLinkerDir)
	cLib64 := C.CString(lib64Dir)
	hiRet := C.hybris_backend_init(cLinker, cLib64, nil)
	C.free(unsafe.Pointer(cLinker))
	C.free(unsafe.Pointer(cLib64))
	if hiRet != 0 {
		return setupError("the Android runtime could not start (code %d)", int(hiRet))
	}

	// For session-reuse (no credentials): gate hybris_fairplay_init on the
	// session-ready marker. The Android lib creates 4096-byte SQLite stub files
	// during RequestContext::init, so a post-init size check always passes.
	if cfg.Credentials.Email == "" {
		markerPath := filepath.Join(baseDir, "session-ready")
		if _, err := os.Stat(markerPath); err != nil {
			_ = os.Remove(filepath.Join(baseDir, "MUSIC_TOKEN"))
			return errors.New("not signed in: no session-ready marker, sign in to enable lossless")
		}
	}

	cBase := C.CString(baseDir)
	cLib64b := C.CString(lib64Dir)
	var cFPUser, cFPPass *C.char
	if cfg.Credentials.Email != "" && cfg.Credentials.Password != "" {
		cFPUser = C.CString(cfg.Credentials.Email)
		cFPPass = C.CString(cfg.Credentials.Password)
	}
	cDevice := deviceInfoCString(baseDir)
	defer C.free(unsafe.Pointer(cDevice))
	fpRet := C.hybris_fairplay_init(cBase, cDevice, cLib64b, cFPUser, cFPPass, (C.drm_auth_callback_t)(C.adamplayBridgeAuth), b.authBox)
	C.free(unsafe.Pointer(cBase))
	C.free(unsafe.Pointer(cLib64b))
	if cFPUser != nil {
		C.free(unsafe.Pointer(cFPUser))
		C.free(unsafe.Pointer(cFPPass))
	}
	if fpRet != 0 {
		// Apple's own wording when it gave a reason (wrong password, account locked, ...).
		if why := C.GoString(C.hybris_last_error()); why != "" {
			if why == "Sign-in cancelled" {
				return ErrSignInCancelled
			}
			return errors.New(why)
		}
		return fmt.Errorf("Apple's sign-in did not complete (code %d)", int(fpRet))
	}
	_ = os.WriteFile(filepath.Join(baseDir, "session-ready"), []byte("1"), 0o600)
	log.Printf("[drm] hybris: FairPlay ready via Android libraries (%s)", lib64Dir)
	// enter() takes b.mu, so this waits until Start has returned.
	go b.warmDefaultKeyContext()
	return nil
}

// signIn runs the FairPlay sign-in and gives up when ctx ends. The native call cannot be
// interrupted: after a timeout it finishes in the background and its outcome is only logged.
func (b *adamplayBackend) signIn(ctx context.Context, baseDir, lib64Dir, linkerDir string, cfg BackendConfig) error {
	res := make(chan error, 1)
	go func() { res <- b.runHybrisInit(baseDir, lib64Dir, linkerDir, cfg) }()
	select {
	case err := <-res:
		return err
	case <-ctx.Done():
		go func() {
			if err := <-res; err != nil {
				log.Printf("[drm] sign-in finished after the timeout: %v", err)
			} else {
				log.Printf("[drm] sign-in finished after the timeout; restart Adam to use it")
			}
		}()
		return fmt.Errorf("sign-in timed out: %w", ctx.Err())
	}
}

// emitState sends a DRMEvent snapshot onto the event channel (non-blocking).
func (b *adamplayBackend) emitState(st DRMState, msg string) {
	select {
	case b.eventCh <- DRMEvent{Snapshot: DRMSnapshot{State: st, Timestamp: time.Now(), Message: msg}}:
	default:
	}
}

// emitFairPlayReady emits a FairPlayReady event after hybris succeeds.
func (b *adamplayBackend) emitFairPlayReady() {
	b.emitState(DRMState{
		Process:  ProcessRunning,
		Manager:  ManagerReady,
		FairPlay: FairPlayReady,
		Recovery: RecoveryIdle,
	}, "hybris FairPlay ready")
}

// Authenticate ensures an authenticated DRM context exists
func (b *adamplayBackend) Authenticate(ctx context.Context) error {
	// For native backend, authentication is handled by callbacks
	// Just verify we're running
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.running {
		return fmt.Errorf("backend not running")
	}

	return nil
}

// quiesce refuses new calls into the C library and waits (bounded) for the ones already
// inside it to finish. It reports whether everything drained in time.
func (b *adamplayBackend) quiesce(timeout time.Duration) bool {
	b.mu.Lock()
	b.running = false
	var wait chan struct{}
	if b.active > 0 {
		b.drained = make(chan struct{})
		wait = b.drained
	}
	b.mu.Unlock()

	if wait == nil {
		return true
	}
	select {
	case <-wait:
		return true
	case <-time.After(timeout):
		return false
	}
}

// RetryFairPlay is called when a fresh Media-User-Token arrives from the web
// player while the backend is already running but hybris failed at Start time
// (e.g. MUSIC_TOKEN was missing on eager-start). It writes the token to disk
// and retries hybris_fairplay_init without a full Stop/Start cycle.
// Implements the optional FairPlayRetrier interface checked by NoteWebSession.
func (b *adamplayBackend) RetryFairPlay(mut string) {
	if !b.retrying.CompareAndSwap(false, true) {
		return
	}
	defer b.retrying.Store(false)
	b.mu.Lock()
	if b.hybrisReady || !b.running || mut == "" {
		b.mu.Unlock()
		return
	}
	// If the background init goroutine is still running, let it finish first.
	initDone := b.hybrisInitDone
	b.mu.Unlock()

	if initDone != nil {
		select {
		case <-initDone:
		case <-time.After(30 * time.Second):
		}
		b.mu.Lock()
		if b.hybrisReady {
			b.mu.Unlock()
			return
		}
		b.mu.Unlock()
	}

	b.mu.Lock()
	baseDir := b.config.BaseDir
	if baseDir == "" {
		baseDir = filepath.Join(b.drmDir, "files")
	}
	b.mu.Unlock()

	// A web MUT alone is not enough for getPersistentKey — that uses the
	// reqCtx Apple ID session from mpl_db. Without a real session the retry
	// would set hybrisReady=true while ALAC still fails with SVError: Invalid CKC.
	markerPath := filepath.Join(baseDir, "session-ready")
	if _, err := os.Stat(markerPath); err != nil {
		log.Printf("[drm] RetryFairPlay: session-ready marker absent — skipping (login required for ALAC)")
		return
	}
	tokenFile := filepath.Join(baseDir, "MUSIC_TOKEN")
	if err := os.WriteFile(tokenFile, []byte(mut), 0o600); err == nil {
		log.Printf("[drm] RetryFairPlay: wrote web MUT to MUSIC_TOKEN (%d bytes)", len(mut))
	}
	lib64Dir := filepath.Join(filepath.Dir(baseDir), "rootfs", "system", "lib64")
	cBase := C.CString(baseDir)
	cLib64 := C.CString(lib64Dir)
	cDevice := deviceInfoCString(baseDir)
	defer C.free(unsafe.Pointer(cDevice))
	fpRet := C.hybris_fairplay_init(cBase, cDevice, cLib64, nil, nil, (C.drm_auth_callback_t)(C.adamplayBridgeAuth), b.authBox)
	C.free(unsafe.Pointer(cBase))
	C.free(unsafe.Pointer(cLib64))
	if fpRet != 0 {
		log.Printf("[drm] RetryFairPlay: hybris_fairplay_init still failed: ret=%d", fpRet)
	} else {
		b.mu.Lock()
		b.hybrisReady = true
		b.mu.Unlock()
		b.emitFairPlayReady()
		log.Printf("[drm] RetryFairPlay: FairPlay ready via web MUT")
	}
}

// Stop shuts down the native DRM backend. New calls are refused at once; calls already
// inside the C library get a bounded time to finish before it is torn down.
func (b *adamplayBackend) Stop() error {
	if !b.quiesce(15 * time.Second) {
		log.Printf("[drm] Stop: calls still inside the DRM library after 15s — shutting down anyway")
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	C.drm_shutdown()
	return nil
}

// Running reports whether the backend is currently operational
func (b *adamplayBackend) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

// SetAuthSource registers the AuthSource
func (b *adamplayBackend) SetAuthSource(src AuthSource) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.authSrc = src
	b.authSrcV.Store(authSrcHolder{src})
}

// GetM3U8 returns the HLS URL for an asset
func (b *adamplayBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	leave, err := b.enter(0)
	if err != nil {
		return "", err
	}
	defer leave()
	cURL := C.drm_get_hls_url(C.drm_adam_id_t(adamID))
	if cURL == nil {
		return "", fmt.Errorf("failed to get HLS URL for asset %d", adamID)
	}
	defer C.free(unsafe.Pointer(cURL))

	return C.GoString(cURL), nil
}

// SetAccountFallback registers the source GetAccount uses when there are no credential files.
func (b *adamplayBackend) SetAccountFallback(fn func() AccountInfo) {
	b.mu.Lock()
	b.accountFallback = fn
	b.mu.Unlock()
}

// GetAccount returns the account information
func (b *adamplayBackend) GetAccount(ctx context.Context) (AccountInfo, error) {
	leave, err := b.enter(0)
	if err != nil {
		return AccountInfo{}, err
	}
	defer leave()
	cJSON := C.drm_get_account()
	if cJSON == nil {
		// No credential files: use the web player's token if the engine has one.
		b.mu.Lock()
		fb := b.accountFallback
		b.mu.Unlock()
		if fb != nil {
			if acc := fb(); acc.MusicToken != "" {
				return acc, nil
			}
		}
		return AccountInfo{}, fmt.Errorf("failed to get account info")
	}
	defer C.free(unsafe.Pointer(cJSON))

	var account AccountInfo
	if err := json.Unmarshal([]byte(C.GoString(cJSON)), &account); err != nil {
		return AccountInfo{}, fmt.Errorf("failed to parse account JSON: %w", err)
	}

	return account, nil
}

// GetProgressiveMVURL returns the progressive download URL and download key
func (b *adamplayBackend) GetProgressiveMVURL(ctx context.Context, adamID uint64) (url string, downloadKey string, err error) {
	leave, err := b.enter(0)
	if err != nil {
		return "", "", err
	}
	defer leave()

	var cURL, cDK *C.char
	var hasDecryptor C.int

	ret := C.drm_get_progressive_url(
		C.drm_adam_id_t(adamID),
		&cURL,
		&cDK,
		&hasDecryptor,
	)

	if ret != 0 {
		return "", "", fmt.Errorf("failed to get progressive URL for asset %d", adamID)
	}

	url = C.GoString(cURL)
	C.free(unsafe.Pointer(cURL))

	if cDK != nil {
		downloadKey = C.GoString(cDK)
		C.free(unsafe.Pointer(cDK))
	}

	// An empty downloadKey means the file is itun-encrypted and must be decrypted here.
	// That needs the sinf data Apple returns with the asset; when the response carried
	// none, no decryptor exists and the file cannot be played (verified live: the
	// stored sinf boxes are stripped placeholders).
	if downloadKey == "" && hasDecryptor == 0 {
		return "", "", fmt.Errorf("asset %d: progressive file is itun-encrypted but Apple returned no sinf, so it cannot be decrypted", adamID)
	}

	return url, downloadKey, nil
}

// DecryptItunSamples decrypts itun-encrypted samples
func (b *adamplayBackend) DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
	leave, err := b.enter(0)
	if err != nil {
		return nil, err
	}
	defer leave()
	decrypted := make([][]byte, len(samples))

	for i, sample := range samples {
		if len(sample) == 0 {
			continue
		}
		cSample := (*C.uint8_t)(unsafe.Pointer(&sample[0]))
		var outSize C.uint32_t

		ret := C.drm_decrypt_itun(
			C.drm_adam_id_t(adamID),
			cSample,
			C.uint32_t(len(sample)),
			&outSize,
		)

		if ret != 0 {
			return nil, fmt.Errorf("itun decryption failed for sample %d with code %d", i, ret)
		}

		if int(outSize) > len(sample) {
			return nil, fmt.Errorf("itun decryption of sample %d reported %d bytes for a %d byte sample", i, outSize, len(sample))
		}
		decrypted[i] = sample[:outSize]
	}

	return decrypted, nil
}

// defaultKeyURI is the key every ALAC init segment names; its context is shared by all tracks.
const defaultKeyURI = "skd://itunes.apple.com/P000000000/s1/e1"

// warmDefaultKeyContext opens the shared prefetch key context under adamID "0"
// as soon as FairPlay is up, as the wrapper's refresh_decrypt_ctx() does. The
// first call pays the ~5 s Android class loading, and getKdContext caches the
// context, so segment 0 of every ALAC track decrypts without waiting.
func (b *adamplayBackend) warmDefaultKeyContext() {
	leave, err := b.enter(b.currentGen())
	if err != nil {
		return
	}
	defer leave()
	cAdamID := C.CString("0")
	cURI := C.CString(defaultKeyURI)
	defer C.free(unsafe.Pointer(cAdamID))
	defer C.free(unsafe.Pointer(cURI))
	start := time.Now()
	ok := C.hybris_open_kd_ctx_from_uri(cAdamID, cURI, nil) != nil
	log.Printf("[drm] FairPlay prefetch key context warmed in %s (ok=%v)", time.Since(start).Round(time.Millisecond), ok)
}

// InProcess marks DialCBCS connections as in-process pipes (see DRMManager.InProcess).
func (b *adamplayBackend) InProcess() bool { return true }

// DialCBCS opens a CBCS decryption connection
func (b *adamplayBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	// For native backend, use a pipe
	client, server := net.Pipe()
	gen := b.currentGen() // key contexts opened below belong to this run of the backend

	b.mu.Lock()
	hybrisReady := b.hybrisReady
	initDone := b.hybrisInitDone
	b.mu.Unlock()

	// If hybris is still initialising in the background, wait for it before
	// opening the connection. This is the one-time ~11 s Android library load;
	// the user pressed play on a lossless track while the app was still starting.
	if !hybrisReady && initDone != nil {
		log.Printf("[drm] DialCBCS: hybris init in progress — waiting (up to 60s)")
		select {
		case <-initDone:
		case <-time.After(60 * time.Second):
			log.Printf("[drm] DialCBCS: hybris init wait timed out — proceeding without ALAC")
		case <-ctx.Done():
			server.Close()
			return nil, ctx.Err()
		}
		b.mu.Lock()
		hybrisReady = b.hybrisReady
		b.mu.Unlock()
	}

	// ALAC is FairPlay-only: every key, the shared prefetch key included, is
	// opened through getKdContext in libandroidappmusic.so exactly as the
	// wrapper's handle() does, and samples go through the same NfcR call.
	// There is no fallback; without hybris the key fails and nothing plays.
	go func() {
		defer server.Close()
		err := serveCBCS(ctx, server, func(adamID, uri string) (func([]byte) error, error) {
			if !hybrisReady {
				return nil, fmt.Errorf("FairPlay is not ready: cannot open ALAC key %s", uri)
			}
			leave, err := b.enter(gen)
			if err != nil {
				return nil, err
			}
			cAdamID := C.CString(adamID)
			cURI := C.CString(uri)
			// Owned by libandroidappmusic.so (cached per session); never freed here.
			var epoch C.uint
			hCtx := C.hybris_open_kd_ctx_from_uri(cAdamID, cURI, &epoch)
			C.free(unsafe.Pointer(cAdamID))
			C.free(unsafe.Pointer(cURI))
			leave()
			if hCtx == nil {
				return nil, fmt.Errorf("FairPlay key context failed for adamID=%s uri=%s", adamID, uri)
			}
			vlog.Printf("[drm] DialCBCS: FairPlay key context opened adamID=%s uri=%s", adamID, uri)
			return func(sample []byte) error {
				if len(sample) < 16 {
					return nil
				}
				leaveDec, err := b.enter(gen)
				if err != nil {
					return err
				}
				defer leaveDec()
				cSample := (*C.uint8_t)(unsafe.Pointer(&sample[0]))
				switch ret := C.hybris_backend_decrypt(hCtx, epoch, cSample, C.uint32_t(len(sample))); ret {
				case 0:
				case C.HYBRIS_ERR_STALE_CONTEXT:
					// A lease refresh freed the context; failing here makes the
					// streaming loop reconnect and open the key again.
					return fmt.Errorf("FairPlay key context invalidated by a lease refresh")
				default:
					return fmt.Errorf("FairPlay decrypt failed (size=%d): ret=%d", len(sample), ret)
				}
				return nil
			}, nil
		})
		if err != nil {
			log.Printf("[drm] CBCS session ended: %v", err)
		}
	}()

	return client, nil
}

// Events returns the event channel
func (b *adamplayBackend) Events() <-chan DRMEvent {
	return b.eventCh
}

// stateLoop processes state changes from C callbacks
func (b *adamplayBackend) stateLoop() {
	for state := range b.stateCh {
		// Parse state string and emit event
		result := ParseStateFile(state)

		// The C library emits RUNNING when the AAC path is ready, and RUNNING also
		// maps to FairPlayReady in ParseStateFile. But FairPlay (ALAC/CBCS) requires
		// hybris_fairplay_init to have succeeded. Cap FairPlay at FairPlayUnknown
		// when hybris didn't initialise, regardless of what the state string says.
		fpState := result.FairPlay
		b.mu.Lock()
		if !b.hybrisReady && fpState == FairPlayReady {
			fpState = FairPlayUnknown
		}
		b.mu.Unlock()

		snap := DRMSnapshot{
			State: DRMState{
				Process:        result.Process,
				FairPlay:       fpState,
				Authentication: result.Auth,
				Recovery:       result.Recovery,
			},
			Timestamp: time.Now(),
			Message:   fmt.Sprintf("state change: %s", state),
		}

		select {
		case b.eventCh <- DRMEvent{
			Snapshot: snap,
		}:
		default:
			// Event channel full, ignore
		}
	}
}

// deviceInfoCString returns this install's device string for hybris_fairplay_init
// (caller frees). If it cannot be stored, the wrapper's shared default is used.
func deviceInfoCString(baseDir string) *C.char {
	info, err := DeviceInfo(baseDir)
	if err != nil {
		log.Printf("[drm] device ID unavailable (%v); using the shared default", err)
	}
	return C.CString(info)
}

type authSrcHolder struct{ src AuthSource }

// twoFactorTimeout bounds how long sign-in waits for the code the user types in.
const twoFactorTimeout = 5 * time.Minute

// answerChallenge is called (via adamplayBridgeAuth) when Apple's sign-in needs
// input. For a verification code it raises a two-factor challenge, which the
// Settings sign-in form shows as a code field, and blocks until the user submits
// it. Returns "" when nothing was entered, which fails that sign-in attempt.
func (b *adamplayBackend) answerChallenge(kind string) string {
	if kind != "2fa" {
		return ""
	}
	h, _ := b.authSrcV.Load().(authSrcHolder)
	if h.src == nil {
		log.Printf("[drm] Apple asked for a verification code but no sign-in form is connected")
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), twoFactorTimeout)
	defer cancel()
	code, err := h.src.Challenge(ctx, AuthChallenge{
		Type:        ChallengeTwoFactor,
		Title:       "Apple ID verification code",
		Description: "Enter the 6-digit code sent to your Apple devices.",
		Metadata:    map[string]string{"issuer": "Apple ID"},
	})
	if err != nil {
		log.Printf("[drm] verification code not entered: %v", err)
		return ""
	}
	return verificationDigits(code)
}
