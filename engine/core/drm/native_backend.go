//go:build linux && native_backend

package drm

/*
#cgo CFLAGS: -D_GNU_SOURCE
#cgo LDFLAGS: -ldrm_client -lcrypto -lssl

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
int   drm_decrypt_itun(drm_adam_id_t asset_id, uint8_t *sample_data, uint32_t input_size, uint32_t *output_size);
int   drm_is_recovery_active(void);

// ── CGO bridge function pointers ────────────────────────────────────────────
extern void nativeBridgeAuth(char *ctype, char *buf, int size, void *ud);
extern void nativeBridgeState(char *state, void *ud);
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime/cgo"
	"sync"
	"time"
	"unsafe"
)

// nativeBackend implements the DRM backend using the native implementation
type nativeBackend struct {
	mu      sync.Mutex
	config  BackendConfig
	drmDir  string  // directory containing libdrm_client.so and files/
	authSrc AuthSource
	eventCh chan DRMEvent
	running bool
	// Global state callback channel for C callbacks
	stateCh   chan string
	stateHandle cgo.Handle
}

// NewNativeBackend creates a new native DRM backend
// drmDir is the directory containing libdrm_client.so and files/ folder with credentials
func NewNativeBackend(drmDir string) DRMBackend {
	b := &nativeBackend{
		drmDir:  drmDir,
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

	// For pure native implementation, lib64_directory can be empty or point to Android libs
	lib64Dir := ""
	if b.drmDir != "" {
		// Check if there's an Android rootfs with lib64
		androidLib64 := filepath.Join(b.drmDir, "rootfs", "system", "lib64")
		if _, err := os.Stat(androidLib64); err == nil {
			lib64Dir = androidLib64
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
		base_directory:   cBaseDir,
		lib64_directory:  cLib64Dir,
		username:         nil,
		password:         nil,
		device_info:      cDeviceInfo,
		offline_only:     0,
		auth_callback:    (C.drm_auth_callback_t)(C.nativeBridgeAuth),
		auth_user_data:   nil,
		state_callback:   (C.drm_state_callback_t)(C.nativeBridgeState),
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

	b.running = true
	
	// Emit initial state event to notify DRMManager that backend is running
	select {
	case b.eventCh <- DRMEvent{
		Snapshot: DRMSnapshot{
			State: DRMState{
				Process:        ProcessRunning,
				Manager:        ManagerReady,
				Authentication: AuthLoggedIn,
				FairPlay:       FairPlayInitializing,
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

// Stop shuts down the native DRM backend
func (b *nativeBackend) Stop() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.running = false
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
	cURL := C.drm_get_hls_url(C.drm_adam_id_t(adamID))
	if cURL == nil {
		return "", fmt.Errorf("failed to get HLS URL for asset %d", adamID)
	}
	defer C.free(unsafe.Pointer(cURL))

	return C.GoString(cURL), nil
}

// GetAccount returns the account information
func (b *nativeBackend) GetAccount(ctx context.Context) (AccountInfo, error) {
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
	decrypted := make([][]byte, len(samples))

	for i, sample := range samples {
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

// DialCBCS opens a CBCS decryption connection
func (b *nativeBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	// For native backend, use a pipe
	client, server := net.Pipe()

	// Start the CBCS server on the server side
	go func() {
		defer server.Close()
		serveCBCS(ctx, server, func(adamID, uri string) (decrypt func([]byte), err error) {
			log.Printf("[drm] DialCBCS: opening key context for adamID=%s uri=%s", adamID, uri)
			cAssetID := C.CString(adamID)
			cMediaURI := C.CString(uri)
			kdCtx := C.drm_open_key_context(cAssetID, cMediaURI)
			C.free(unsafe.Pointer(cAssetID))
			C.free(unsafe.Pointer(cMediaURI))

			if kdCtx == nil {
				log.Printf("[drm] DialCBCS: drm_open_key_context returned NULL for adamID=%s", adamID)
				return nil, fmt.Errorf("failed to open key context for asset %s", adamID)
			}
			log.Printf("[drm] DialCBCS: key context opened successfully for adamID=%s", adamID)

			return func(sample []byte) {
				cSample := (*C.uint8_t)(unsafe.Pointer(&sample[0]))
				C.drm_decrypt_sample(kdCtx, cSample, C.uint32_t(len(sample)))
			}, nil
		})
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
