//go:build linux && native_backend

package drm

/*
#cgo CFLAGS: -D_GNU_SOURCE
#cgo LDFLAGS: -ldrm_client -lcrypto -lssl -ldl

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
typedef struct drm_key_context *drm_key_context_handle_t;

int   drm_init(const drm_config *config);
void  drm_shutdown(void);
char *drm_get_account(void);
char *drm_get_hls_url(drm_adam_id_t asset_id);
int   drm_get_progressive_url(drm_adam_id_t asset_id, char **out_url, char **out_download_key, int *out_has_decryptor);
drm_key_context_handle_t drm_open_key_context(const char *asset_id_str, const char *media_uri);
int   drm_decrypt_sample(drm_key_context_handle_t key_context, uint8_t *sample_data, uint32_t sample_size);
int   drm_decrypt_sample_at(drm_key_context_handle_t key_context, uint8_t *sample_data, uint32_t sample_size, uint64_t sample_number);
int   drm_decrypt_sample_with_sample_iv(drm_key_context_handle_t key_context, uint8_t *sample_data, uint32_t sample_size);
int   drm_set_key_context_key(drm_key_context_handle_t key_context, const uint8_t *aes_key, const uint8_t *iv);
int   drm_decrypt_itun(drm_adam_id_t asset_id, uint8_t *sample_data, uint32_t input_size, uint32_t *output_size);
int   drm_is_recovery_active(void);

// ── drm_hybris.h declarations (libCoreFP.so / libandroidappmusic.so via hybris) ──
int   hybris_backend_init(const char *hybris_linker_dir, const char *lib64_dir, const char *hybris_core_path);
int   hybris_fairplay_init(const char *base_dir, const char *device_info, const char *lib64_dir);
int   hybris_backend_decrypt(void *ctx, uint32_t selector, uint8_t *data, uint32_t len);
void *hybris_backend_open_kd_ctx(const uint8_t *ckc_data, uint32_t ckc_len, uint32_t selector);
void  hybris_backend_close_kd_ctx(void *ctx);
void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri);
void  hybris_corefp_probe(void);
void  hybris_backend_shutdown(void);

// ── CGO bridge function pointers ────────────────────────────────────────────
extern void nativeBridgeAuth(char *ctype, char *buf, int size, void *ud);
extern void nativeBridgeState(char *state, void *ud);
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime/cgo"
	"strings"
	"sync"
	"time"
	"unsafe"

	"engine/utils/aacstream"
	"engine/utils/ampapi"
)

// nativeBackend implements the DRM backend using the native implementation
type nativeBackend struct {
	mu      sync.Mutex
	config  BackendConfig
	drmDir  string // directory containing libdrm_client.so and files/
	authSrc AuthSource
	eventCh chan DRMEvent
	running bool
	// Global state callback channel for C callbacks
	stateCh      chan string
	stateHandle  cgo.Handle
	hybrisReady  bool          // whether hybris backend (libCoreFP.so / libandroidappmusic.so) loaded
	cachedDevTok string        // MusicKit developer JWT, fetched once on Start
	fpReady      chan struct{} // closed once hybris + FairPlay init succeeded
	fpOnce       sync.Once

	// In-flight accounting for calls into the C library (guarded by mu). Stop must not
	// tear the library down under a running call, and key contexts handed out by one
	// Start are meaningless after the next, so each Start gets a generation.
	active  int           // calls currently inside the C library
	drained chan struct{} // closed when active reaches 0 while Stop is waiting
	gen     uint64        // incremented by every successful Start
}

var errBackendStopped = errors.New("DRM backend is not running")

// enter registers one call into the C library. gen is the generation the caller's
// state (key contexts) belongs to, or 0 for calls that carry none. The returned func
// must be called when the call is done.
func (b *nativeBackend) enter(gen uint64) (leave func(), err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running || (gen != 0 && gen != b.gen) {
		return nil, errBackendStopped
	}
	b.active++
	return b.leave, nil
}

func (b *nativeBackend) leave() {
	b.mu.Lock()
	b.active--
	if b.active == 0 && b.drained != nil {
		close(b.drained)
		b.drained = nil
	}
	b.mu.Unlock()
}

func (b *nativeBackend) currentGen() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gen
}

// NewNativeBackend creates a new native DRM backend
// drmDir is the directory containing libdrm_client.so and files/ folder with credentials
func NewNativeBackend(drmDir string) DRMBackend {
	b := &nativeBackend{
		drmDir:  drmDir,
		fpReady: make(chan struct{}),
		eventCh: make(chan DRMEvent, 16),
		stateCh: make(chan string, 16),
	}
	b.stateHandle = cgo.NewHandle(b.stateCh)
	return b
}

// Start launches the native DRM backend
func (b *nativeBackend) Start(ctx context.Context, cfg BackendConfig) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.config = cfg

	// Start callback goroutines
	go b.authLoop()
	go b.stateLoop()

	// Determine paths:
	// - base_directory: the files/ folder where credentials are stored
	// - lib64_directory: the Android lib64 folder (if using Android libs) or empty for pure native
	baseDir := cfg.BaseDir
	if baseDir == "" {
		// Default: use files/ folder next to libdrm_client.so
		baseDir = filepath.Join(b.drmDir, "files")
	}

	// Locate the Android lib64 for the hybris backend.
	// Try, in order:
	//   1. $AML_VSEG_DRM/rootfs/system/lib64  (explicit override)
	//   2. <drmDir>/rootfs/system/lib64        (lib64 bundled next to drm_client.so)
	//   3. <repoParent>/apple-music-linux-vseg/drm/rootfs/system/lib64  (sibling repo)
	lib64Dir := ""
	candidates := []string{}
	if vsegEnv := os.Getenv("AML_VSEG_DRM"); vsegEnv != "" {
		candidates = append(candidates, filepath.Join(vsegEnv, "rootfs", "system", "lib64"))
	}
	if b.drmDir != "" {
		candidates = append(candidates, filepath.Join(b.drmDir, "rootfs", "system", "lib64"))
		// sibling vseg repo: go up from drm/ → repo root → parent → vseg
		repoRoot := filepath.Dir(b.drmDir)
		candidates = append(candidates, filepath.Join(filepath.Dir(repoRoot), "apple-music-linux-vseg", "drm", "rootfs", "system", "lib64"))
	}
	// The repo's own drm/ (the parent of drmDir when drmDir is a subdirectory) and the per-user
	// dir ensureUserDRM() populates are valid roots too.
	userDRM := ""
	if home, err := os.UserHomeDir(); err == nil {
		userDRM = filepath.Join(home, ".config", "apple-music-linux", "drm")
	}
	if b.drmDir != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(b.drmDir), "rootfs", "system", "lib64"))
	}
	if userDRM != "" {
		candidates = append(candidates, filepath.Join(userDRM, "rootfs", "system", "lib64"))
	}
	for _, c := range candidates {
		// A usable lib64 holds the bionic system libs, not just a few app libs.
		if _, err := os.Stat(filepath.Join(c, "libc.so")); err == nil {
			lib64Dir = c
			break
		}
	}

	// Prepare config
	cBaseDir := C.CString(baseDir)
	var cLib64Dir *C.char
	if lib64Dir != "" {
		cLib64Dir = C.CString(lib64Dir)
	}
	cDeviceInfo := C.CString(cfg.DeviceInfo)

	drmConfig := C.drm_config{
		base_directory:  cBaseDir,
		lib64_directory: cLib64Dir,
		username:        nil,
		password:        nil,
		device_info:     cDeviceInfo,
		offline_only:    0,
		auth_callback:   (C.drm_auth_callback_t)(C.nativeBridgeAuth),
		auth_user_data:  nil,
		state_callback:  (C.drm_state_callback_t)(C.nativeBridgeState),
		// Pass stateCh as userdata via cgo.Handle
		state_user_data: unsafe.Pointer(uintptr(b.stateHandle)),
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
	if cLib64Dir != nil {
		C.free(unsafe.Pointer(cLib64Dir))
	}
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

	// Fetch and cache the MusicKit developer JWT (used in AcquireKey's
	// Authorization header). This token is embedded in the web player JS and
	// does not require user credentials — it is safe to fetch on every Start.
	if tok, err := ampapi.GetToken(); err == nil && tok != "" {
		b.cachedDevTok = tok
		log.Printf("[drm] native: dev token fetched (%d bytes)", len(tok))
	} else {
		log.Printf("[drm] native: dev token fetch failed: %v", err)
	}

	// Initialise the hybris backend (libCoreFP.so + libandroidappmusic.so).
	// The Android libs are embedded in libdrm_client.so; only the linker shim
	// (hybris-linker/q.so) and the bionic system libs (lib64) come from disk.
	// libhybris exit()s the process if q.so is missing, so verify it first.
	linkerDir := ""
	{
		roots := []string{}
		if lib64Dir != "" {
			roots = append(roots, filepath.Dir(filepath.Dir(filepath.Dir(lib64Dir))))
		}
		if b.drmDir != "" {
			roots = append(roots, b.drmDir, filepath.Dir(b.drmDir))
		}
		if userDRM != "" {
			roots = append(roots, userDRM)
		}
		for _, r := range roots {
			if _, err := os.Stat(filepath.Join(r, "hybris-linker", "q.so")); err == nil {
				linkerDir = filepath.Join(r, "hybris-linker")
				break
			}
		}
	}
	// fpState is what the initial event reports. stateLoop is already running, so the
	// wrapper's RUNNING callback may have emitted Ready during init; the initial event
	// must agree with that instead of resetting the manager to Initializing.
	fpState := FairPlayInitializing
	if linkerDir == "" || lib64Dir == "" {
		log.Printf("[drm] hybris backend: not available (linker=%q lib64=%q)", linkerDir, lib64Dir)
	} else {
		coreSOPath := ""
		cLinkerDir := C.CString(linkerDir)
		cLib64Dir2 := C.CString(lib64Dir)
		cCorePath := C.CString(coreSOPath)
		hret := C.hybris_backend_init(cLinkerDir, cLib64Dir2, cCorePath)
		C.free(unsafe.Pointer(cLinkerDir))
		C.free(unsafe.Pointer(cLib64Dir2))
		C.free(unsafe.Pointer(cCorePath))
		if hret == 0 {
			b.hybrisReady = true
			log.Printf("[drm] hybris backend: ready (libCoreFP.so + libandroidappmusic.so)")
			// Initialize FairPlay credential context (RequestContext + lease manager)
			cBaseDirFP := C.CString(baseDir)
			cDevInfoFP := C.CString(cfg.DeviceInfo)
			cLib64FP := C.CString(lib64Dir)
			fpret := C.hybris_fairplay_init(cBaseDirFP, cDevInfoFP, cLib64FP)
			C.free(unsafe.Pointer(cBaseDirFP))
			C.free(unsafe.Pointer(cDevInfoFP))
			C.free(unsafe.Pointer(cLib64FP))
			if fpret == 0 {
				fpState = FairPlayReady
				log.Printf("[drm] hybris FairPlay init: ok")
				b.fpOnce.Do(func() { close(b.fpReady) })
				go b.warmDefaultKeyContext()
			} else {
				log.Printf("[drm] hybris FairPlay init: failed (rc=%d) — key exchange may fail", int(fpret))
				fpState = FairPlayFailed
			}
			// The probe dumps every libCoreFP export's return value; only useful when debugging.
			if os.Getenv("AML_DRM_DEBUG") != "" {
				C.hybris_corefp_probe()
			}
		} else {
			log.Printf("[drm] hybris backend: not available (vseg rootfs absent or load failed)")
		}
	}

	b.running = true
	b.gen++

	// Emit initial state event to notify DRMManager that backend is running
	select {
	case b.eventCh <- DRMEvent{
		Snapshot: DRMSnapshot{
			State: DRMState{
				Process:        ProcessRunning,
				Manager:        ManagerReady,
				Authentication: AuthLoggedIn,
				FairPlay:       fpState,
				Session:        SessionValid,
				Recovery:       RecoveryIdle,
			},
			Timestamp: time.Now(),
			Message:   "native backend initialized",
		},
	}:
	default:
		// Event channel full, ignore
	}

	return nil
}

// Authenticate ensures an authenticated DRM context exists
func (b *nativeBackend) Authenticate(ctx context.Context) error {
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
func (b *nativeBackend) quiesce(timeout time.Duration) bool {
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

// Stop shuts down the native DRM backend. New calls are refused at once; calls already
// inside the C library get a bounded time to finish before it is torn down.
func (b *nativeBackend) Stop() error {
	if !b.quiesce(15 * time.Second) {
		log.Printf("[drm] Stop: calls still inside the DRM library after 15s — shutting down anyway")
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.hybrisReady {
		C.hybris_backend_shutdown()
		b.hybrisReady = false
	}
	C.drm_shutdown()
	return nil
}

// Running reports whether the backend is currently operational
func (b *nativeBackend) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

// SetAuthSource registers the AuthSource
func (b *nativeBackend) SetAuthSource(src AuthSource) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.authSrc = src
}

// Decrypt decrypts FairPlay-encrypted samples
func (b *nativeBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	leave, err := b.enter(0)
	if err != nil {
		return DecryptResponse{}, err
	}
	defer leave()

	// Open key context
	cAssetID := C.CString(req.AdamID)
	cMediaURI := C.CString(req.KeyURI)
	kdCtx := C.drm_open_key_context(cAssetID, cMediaURI)
	C.free(unsafe.Pointer(cAssetID))
	C.free(unsafe.Pointer(cMediaURI))

	if kdCtx == nil {
		return DecryptResponse{}, fmt.Errorf("failed to open key context for asset %s", req.AdamID)
	}

	// Decrypt each sample
	decrypted := make([][]byte, len(req.Samples))
	for i, sample := range req.Samples {
		if len(sample) == 0 {
			continue // nothing to decrypt (and &sample[0] would panic)
		}
		cSample := (*C.uint8_t)(unsafe.Pointer(&sample[0]))
		ret := C.drm_decrypt_sample(kdCtx, cSample, C.uint32_t(len(sample)))

		if ret != 0 {
			return DecryptResponse{}, fmt.Errorf("decryption failed for sample %d with code %d", i, ret)
		}

		decrypted[i] = sample
	}

	return DecryptResponse{
		Samples: decrypted,
	}, nil
}

// GetM3U8 returns the HLS URL for an asset
func (b *nativeBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
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

// GetAccount returns the account information
func (b *nativeBackend) GetAccount(ctx context.Context) (AccountInfo, error) {
	leave, err := b.enter(0)
	if err != nil {
		return AccountInfo{}, err
	}
	defer leave()
	cJSON := C.drm_get_account()
	if cJSON == nil {
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
func (b *nativeBackend) GetProgressiveMVURL(ctx context.Context, adamID uint64) (url string, downloadKey string, err error) {
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

	return url, downloadKey, nil
}

// DecryptItunSamples decrypts itun-encrypted samples
func (b *nativeBackend) DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
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

		decrypted[i] = sample[:outSize]
	}

	return decrypted, nil
}

// defaultKeyURI is the key every ALAC init segment names; its context is shared by all tracks.
const defaultKeyURI = "skd://itunes.apple.com/P000000000/s1/e1"

// warmDefaultKeyContext opens the shared default key context as soon as FairPlay is up.
// The first open costs about 5 s inside the Android library; the library caches contexts
// by (asset, URI), so doing it here means the first track's CBCS dial finds it instead of
// paying that during playback startup. The context is deliberately kept open.
func (b *nativeBackend) warmDefaultKeyContext() {
	leave, err := b.enter(b.currentGen()) // waits for Start to release b.mu
	if err != nil {
		return
	}
	defer leave()
	cAssetID := C.CString("0")
	cMediaURI := C.CString(defaultKeyURI)
	defer C.free(unsafe.Pointer(cAssetID))
	defer C.free(unsafe.Pointer(cMediaURI))
	start := time.Now()
	ok := C.drm_open_key_context(cAssetID, cMediaURI) != nil
	log.Printf("[drm] default key context warmed in %s (ok=%v)", time.Since(start).Round(time.Millisecond), ok)
}

// InProcess marks DialCBCS connections as in-process pipes (see DRMManager.InProcess).
func (b *nativeBackend) InProcess() bool { return true }

// DialCBCS opens a CBCS decryption connection
func (b *nativeBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	// For native backend, use a pipe
	client, server := net.Pipe()
	gen := b.currentGen() // key contexts opened below belong to this run of the backend

	// Start the CBCS server on the server side
	go func() {
		defer server.Close()
		err := serveCBCS(ctx, server, func(adamID, uri string) (decrypt func([]byte) error, err error) {
			log.Printf("[drm] DialCBCS: opening key context for adamID=%s uri=%s", adamID, uri)

			// No zero-key fallback: content keys are only valid via FairPlay.
			select {
			case <-b.fpReady:
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(30 * time.Second):
				return nil, fmt.Errorf("FairPlay not initialised after 30s; refusing to decrypt asset %s", adamID)
			}

			// Parse key URI to extract kidBase64 and uriPrefix
			// Format: skd://itunes.apple.com/p1484937438/c6,kidBase64
			log.Printf("[drm] DialCBCS: raw key URI=%s", uri)
			commaIdx := strings.LastIndex(uri, ",")
			var uriPrefix, kidBase64 string
			if commaIdx >= 0 {
				uriPrefix = uri[:commaIdx]
				kidBase64 = uri[commaIdx+1:]
				log.Printf("[drm] DialCBCS: parsed uriPrefix=%s kidBase64=%s", uriPrefix, kidBase64)
			} else {
				uriPrefix = uri
				kidBase64 = ""
				log.Printf("[drm] DialCBCS: no comma in URI, using full URI as prefix")
			}

			// Fetch license if we have kid info
			var fetchedKey []byte
			if kidBase64 != "" && adamID != "0" {
				log.Printf("[drm] DialCBCS: fetching license for adamID=%s kid=%s", adamID, kidBase64)
				// Get tokens from account info
				account, accErr := b.GetAccount(ctx)
				if accErr != nil {
					log.Printf("[drm] DialCBCS: failed to get account: %v", accErr)
				} else {
					// Fetch license using aacstream's AcquireKey.
					// token = developer JWT (Authorization: Bearer), mutoken = user music token.
					devTok := b.cachedDevTok
					if devTok == "" {
						devTok = account.DevToken
					}
					fetchedKey, err = aacstream.AcquireKey(ctx, adamID, kidBase64, uriPrefix, devTok, account.MusicToken, false)
					if err != nil {
						log.Printf("[drm] DialCBCS: failed to fetch license: %v", err)
					} else {
						log.Printf("[drm] DialCBCS: license fetched, key=%02x%02x...", fetchedKey[0], fetchedKey[1])
					}
				}
			}

			leave, enterErr := b.enter(gen)
			if enterErr != nil {
				return nil, enterErr
			}
			cAssetID := C.CString(adamID)
			cMediaURI := C.CString(uri)
			kdCtx := C.drm_open_key_context(cAssetID, cMediaURI)
			C.free(unsafe.Pointer(cAssetID))
			C.free(unsafe.Pointer(cMediaURI))

			if kdCtx == nil {
				leave()
				log.Printf("[drm] DialCBCS: drm_open_key_context returned NULL for adamID=%s", adamID)
				return nil, fmt.Errorf("failed to open key context for asset %s", adamID)
			}
			log.Printf("[drm] DialCBCS: key context opened successfully for adamID=%s", adamID)

			// Set the fetched key if available
			if len(fetchedKey) == 16 {
				// The sample-derived IV path uses this as its base value.
				zeroIV := make([]byte, 16)
				cKey := (*C.uint8_t)(unsafe.Pointer(&fetchedKey[0]))
				cIV := (*C.uint8_t)(unsafe.Pointer(&zeroIV[0]))
				if ret := C.drm_set_key_context_key(kdCtx, cKey, cIV); ret != 0 {
					log.Printf("[drm] DialCBCS: failed to set key context key: ret=%d", ret)
				} else {
					log.Printf("[drm] DialCBCS: key context key set successfully")
				}
			}
			leave()

			return func(sample []byte) error {
				// CBCS pattern: only whole 16-byte blocks are encrypted.
				// Apple Music CBCS uses a fixed zero IV per key context —
				// confirmed by Frida T4 test (T4_ivIsZero=true).
				// drm_decrypt_sample_at(ctx, data, n, 0) computes
				// derive_iv(zeroBaseIV, 0) = zeros, matching the correct IV.
				if n := len(sample) &^ 0xf; n > 0 {
					// kdCtx is only valid for the run that created it: refuse after a Stop
					// or restart instead of handing a dangling pointer to the library.
					leaveDec, err := b.enter(gen)
					if err != nil {
						return err
					}
					defer leaveDec()
					cSample := (*C.uint8_t)(unsafe.Pointer(&sample[0]))
					if ret := C.drm_decrypt_sample_at(kdCtx, cSample, C.uint32_t(n), 0); ret != 0 {
						return fmt.Errorf("drm_decrypt_sample_at failed (size=%d): ret=%d", n, ret)
					}
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
func (b *nativeBackend) Events() <-chan DRMEvent {
	return b.eventCh
}

// authLoop processes authentication requests
func (b *nativeBackend) authLoop() {
	// Auth is handled via callbacks
}

// stateLoop processes state changes from C callbacks
func (b *nativeBackend) stateLoop() {
	for state := range b.stateCh {
		// Parse state string and emit event
		result := ParseStateFile(state)

		snap := DRMSnapshot{
			State: DRMState{
				Process:        result.Process,
				FairPlay:       result.FairPlay,
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
