//go:build linux && hybris_backend

package drm

/*
#cgo CFLAGS: -D_GNU_SOURCE
#cgo LDFLAGS: -ldrm-native

#include <stdint.h>
#include <stdlib.h>

// ── drm_lib.h declarations ──────────────────────────────────────────────────

typedef void (*drm_auth_cb_t)(const char *type, char *out_buf, int out_size, void *userdata);
typedef void (*drm_state_cb_t)(const char *state, void *userdata);

typedef struct {
    const char    *base_dir;
    const char    *lib64_dir;  // path to Android lib64 (rootfs/system/lib64)
    const char    *username;
    const char    *password;
    const char    *device_info;
    int            offline_only;
    drm_auth_cb_t  auth_cb;
    void          *auth_ud;
    drm_state_cb_t state_cb;
    void          *state_ud;
} drm_lib_config_t;

int   drm_lib_init(const drm_lib_config_t *cfg);
void  drm_lib_shutdown(void);
char *drm_lib_get_m3u8(unsigned long adam_id);
char *drm_lib_get_account(void);
int   drm_lib_get_mv(unsigned long adam_id, char **out_url, char **out_dk, int *out_has_itun);
void *drm_lib_open_kd_ctx(const char *adam_id, const char *uri);
int   drm_lib_decrypt(void *kd_ctx, uint8_t *sample, uint32_t size);
int   drm_lib_decrypt_itun(unsigned long adam_id, uint8_t *sample,
                            uint32_t in_size, uint32_t *out_size);
int   drm_lib_is_recovery_active(void);

// ── CGO bridge function pointers (implemented in hybris_cgo_bridge.go) ──────
extern void hybrisBridgeAuth(char *ctype, char *buf, int size, void *ud);
extern void hybrisBridgeState(char *state, void *ud);
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// ── HybrisBackend ─────────────────────────────────────────────────────────────

// HybrisBackend implements DRMBackend by calling libdrm-native.so directly
// via CGO. No subprocesses, no TCP sockets — all DRM operations happen
// in-process through the hybris Android library shim.
//
// DialCBCS returns an in-process net.Pipe() connection; decryption happens
// in a goroutine that speaks the same wire protocol as handle() in main.c.
type HybrisBackend struct {
	mu     sync.RWMutex
	auth   AuthSource
	cfg    BackendConfig // config of the last successful Start (reused by Authenticate)
	drmDir string        // directory containing drm-native + libdrm-native.so
	state  atomic.Int32  // 0=stopped 1=running
	events chan DRMEvent

	// startMu serialises Start/Stop: drm_lib_init must never run concurrently.
	startMu sync.Mutex
	// ud is C memory holding this backend's registry ID, passed to C as the
	// callback userdata. Allocated once and never freed: C may still invoke a
	// callback after shutdown, and a stale ID then resolves to nil.
	ud unsafe.Pointer
	id uint64

	itunMu     sync.Mutex
	itunAdamID uint64
	itunReady  bool
}

// NewHybrisBackend creates a HybrisBackend. drmDir is the directory that
// contains drm-native and libdrm-native.so (used to derive HYBRIS_* env vars).
func NewHybrisBackend(drmDir string) *HybrisBackend {
	return &HybrisBackend{drmDir: drmDir, events: make(chan DRMEvent, 32)}
}

func (b *HybrisBackend) SetAuthSource(a AuthSource) {
	b.mu.Lock()
	b.auth = a
	b.mu.Unlock()
}

func (b *HybrisBackend) Running() bool { return b.state.Load() == 1 }

func (b *HybrisBackend) Events() <-chan DRMEvent { return b.events }

func (b *HybrisBackend) emit(ev DRMEvent) {
	select {
	case b.events <- ev:
	default:
	}
}

// Start initialises libdrm-native in-process. Blocks until RUNNING or error.
func (b *HybrisBackend) Start(ctx context.Context, cfg BackendConfig) error {
	b.startMu.Lock()
	defer b.startMu.Unlock()
	if b.Running() {
		return nil
	}

	// Set HYBRIS_* env vars so libhybris-core.so can find the Android linker
	// and lib64 directory.  These must be set before drm_lib_init() loads any
	// Android shared library.
	if b.drmDir != "" {
		lib64 := filepath.Join(b.drmDir, "rootfs", "system", "lib64")
		os.Setenv("HYBRIS_LINKER_DIR", filepath.Join(b.drmDir, "hybris-linker"))
		os.Setenv("HYBRIS_LD_LIBRARY_PATH", lib64)
		os.Setenv("HYBRIS_ANDROID_LIB64", lib64)
	}

	// Callback userdata is C memory holding a registry ID — never a Go pointer
	// (CGO rules) and never a uintptr cast to unsafe.Pointer (unsafe rules).
	ud := hybrisRegister(b)

	cBase := C.CString(cfg.BaseDir)
	defer C.free(unsafe.Pointer(cBase))

	lib64 := filepath.Join(b.drmDir, "rootfs", "system", "lib64")
	cLib64 := C.CString(lib64)
	defer C.free(unsafe.Pointer(cLib64))

	var cUser, cPass *C.char
	if cfg.Credentials.Email != "" {
		cUser = C.CString(cfg.Credentials.Email)
		cPass = C.CString(cfg.Credentials.Password)
		defer C.free(unsafe.Pointer(cUser))
		defer C.free(unsafe.Pointer(cPass))
	}

	var cDev *C.char
	if cfg.DeviceInfo != "" {
		cDev = C.CString(cfg.DeviceInfo)
		defer C.free(unsafe.Pointer(cDev))
	}

	libCfg := C.drm_lib_config_t{
		base_dir:    cBase,
		lib64_dir:   cLib64,
		username:    cUser,
		password:    cPass,
		device_info: cDev,
		auth_cb:     C.drm_auth_cb_t(C.hybrisBridgeAuth),
		auth_ud:     ud,
		state_cb:    C.drm_state_cb_t(C.hybrisBridgeState),
		state_ud:    ud,
	}

	if rc := C.drm_lib_init(&libCfg); rc != 0 {
		hybrisUnregister(b)
		return fmt.Errorf("hybris: drm_lib_init failed")
	}

	b.mu.Lock()
	b.cfg = cfg
	b.mu.Unlock()
	b.state.Store(1)
	b.emit(DRMEvent{Snapshot: DRMSnapshot{
		State:     DRMState{Process: ProcessRunning, FairPlay: FairPlayReady, Authentication: AuthLoggedIn, Recovery: RecoveryIdle},
		Timestamp: time.Now(),
	}})
	return nil
}

// Authenticate re-initialises (shutdown + init) for credential refresh,
// reusing the last Start config (an empty one would lose BaseDir).
func (b *HybrisBackend) Authenticate(ctx context.Context) error {
	b.mu.RLock()
	cfg := b.cfg
	b.mu.RUnlock()
	_ = b.Stop()
	return b.Start(ctx, cfg)
}

// Stop shuts down the library.
func (b *HybrisBackend) Stop() error {
	b.startMu.Lock()
	defer b.startMu.Unlock()
	if !b.Running() {
		return nil
	}
	C.drm_lib_shutdown()
	b.state.Store(0)
	hybrisUnregister(b)
	b.emit(DRMEvent{
		Snapshot:    DRMSnapshot{State: DRMState{Process: ProcessStopped}, Timestamp: time.Now()},
		Intentional: true,
	})
	return nil
}

// Decrypt performs in-process FairPlay decryption.
func (b *HybrisBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	if !b.Running() {
		return DecryptResponse{}, ErrNotAuthenticated
	}
	cAdam := C.CString(req.AdamID)
	cURI := C.CString(req.KeyURI)
	defer C.free(unsafe.Pointer(cAdam))
	defer C.free(unsafe.Pointer(cURI))

	kdCtx := C.drm_lib_open_kd_ctx(cAdam, cURI)
	if kdCtx == nil {
		return DecryptResponse{}, fmt.Errorf("hybris: open_kd_ctx failed")
	}

	results := make([][]byte, 0, len(req.Samples))
	for _, sample := range req.Samples {
		if ctx.Err() != nil {
			return DecryptResponse{}, ctx.Err()
		}
		out := make([]byte, len(sample))
		copy(out, sample)
		if truncLen := len(out) & ^0xf; truncLen > 0 {
			C.drm_lib_decrypt(kdCtx, (*C.uint8_t)(unsafe.Pointer(&out[0])), C.uint32_t(truncLen))
		}
		results = append(results, out)
	}
	return DecryptResponse{Samples: results}, nil
}

// GetM3U8 fetches the HLS URL for adamID.
func (b *HybrisBackend) GetM3U8(_ context.Context, adamID uint64) (string, error) {
	if !b.Running() {
		return "", ErrNotAuthenticated
	}
	cURL := C.drm_lib_get_m3u8(C.ulong(adamID))
	if cURL == nil {
		return "", fmt.Errorf("hybris: get_m3u8 failed for adamID %d", adamID)
	}
	url := C.GoString(cURL)
	C.free(unsafe.Pointer(cURL))
	return url, nil
}

// GetAccount returns the cached Apple Music account tokens.
func (b *HybrisBackend) GetAccount(_ context.Context) (AccountInfo, error) {
	if !b.Running() {
		return AccountInfo{}, ErrNotAuthenticated
	}
	cJSON := C.drm_lib_get_account()
	if cJSON == nil {
		return AccountInfo{}, fmt.Errorf("hybris: get_account failed")
	}
	defer C.free(unsafe.Pointer(cJSON))

	var obj struct {
		StorefrontID string `json:"storefront_id"`
		DevToken     string `json:"dev_token"`
		MusicToken   string `json:"music_token"`
	}
	if err := json.Unmarshal([]byte(C.GoString(cJSON)), &obj); err != nil {
		return AccountInfo{}, fmt.Errorf("hybris: get_account decode: %w", err)
	}
	return AccountInfo{StorefrontID: obj.StorefrontID, DevToken: obj.DevToken, MusicToken: obj.MusicToken}, nil
}

// GetProgressiveMVURL returns the progressive MV URL and download key.
func (b *HybrisBackend) GetProgressiveMVURL(_ context.Context, adamID uint64) (url, downloadKey string, err error) {
	if !b.Running() {
		return "", "", ErrNotAuthenticated
	}
	var cURL, cDK *C.char
	var hasItun C.int
	if rc := C.drm_lib_get_mv(C.ulong(adamID), &cURL, &cDK, &hasItun); rc != 0 || cURL == nil {
		return "", "", fmt.Errorf("hybris: get_mv failed for adamID %d", adamID)
	}
	url = C.GoString(cURL)
	C.free(unsafe.Pointer(cURL))
	if cDK != nil {
		downloadKey = C.GoString(cDK)
		C.free(unsafe.Pointer(cDK))
	}
	if hasItun != 0 {
		b.itunMu.Lock()
		b.itunReady = true
		b.itunAdamID = adamID
		b.itunMu.Unlock()
	}
	return url, downloadKey, nil
}

// DecryptItunSamples decrypts itun-encrypted samples in-process.
func (b *HybrisBackend) DecryptItunSamples(_ context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
	b.itunMu.Lock()
	ready := b.itunReady && b.itunAdamID == adamID
	b.itunMu.Unlock()
	if !ready {
		return nil, fmt.Errorf("hybris: itun decryptor not ready for adamID %d", adamID)
	}

	result := make([][]byte, 0, len(samples))
	for _, s := range samples {
		if len(s) == 0 {
			result = append(result, nil) // &out[0] below would panic
			continue
		}
		out := make([]byte, len(s))
		copy(out, s)
		var outSize C.uint32_t
		rc := C.drm_lib_decrypt_itun(C.ulong(adamID),
			(*C.uint8_t)(unsafe.Pointer(&out[0])),
			C.uint32_t(len(out)), &outSize)
		if rc != 0 {
			return nil, fmt.Errorf("hybris: itun decrypt failed")
		}
		if int(outSize) > len(out) {
			return nil, fmt.Errorf("hybris: itun decrypt reported %d bytes for a %d-byte sample", outSize, len(out))
		}
		result = append(result, out[:outSize])
	}
	return result, nil
}

// DialCBCS returns an in-process net.Pipe() connection backed by a goroutine
// that speaks the same wire protocol as handle()/new_socket() in main.c
// (sendString adamID, sendString uri, then [uint32 size][bytes]... [uint32 0]).
func (b *HybrisBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if !b.Running() {
		return nil, ErrNotAuthenticated
	}
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		_ = hybrisCBCSServe(ctx, server)
	}()
	return client, nil
}

// hybrisCBCSServe is the server half of the in-process CBCS pipe: the
// protocol lives in serveCBCS; this supplies the native key/decrypt calls.
func hybrisCBCSServe(ctx context.Context, conn net.Conn) error {
	return serveCBCS(ctx, conn, func(adamID, uri string) (func([]byte), error) {
		cAdam := C.CString(adamID)
		cURI := C.CString(uri)
		defer C.free(unsafe.Pointer(cAdam))
		defer C.free(unsafe.Pointer(cURI))
		kdCtx := C.drm_lib_open_kd_ctx(cAdam, cURI)
		if kdCtx == nil {
			return nil, fmt.Errorf("hybris cbcs: open_kd_ctx failed for %s", uri)
		}
		return func(sample []byte) {
			// CBCS pattern: only whole 16-byte blocks are encrypted.
			if n := len(sample) &^ 0xf; n > 0 {
				C.drm_lib_decrypt(kdCtx, (*C.uint8_t)(unsafe.Pointer(&sample[0])), C.uint32_t(n))
			}
		}, nil
	})
}

// ── CGO callback registry ─────────────────────────────────────────────────────

// hybrisRegistry maps callback IDs to live backends. A callback whose ID was
// unregistered (backend stopped) resolves to nil instead of panicking the way
// cgo.Handle.Value does for a deleted handle.
var hybrisRegistry = struct {
	sync.RWMutex
	m    map[uint64]*HybrisBackend
	next uint64
}{m: map[uint64]*HybrisBackend{}}

// hybrisRegister (re)registers b and returns its callback userdata pointer.
func hybrisRegister(b *HybrisBackend) unsafe.Pointer {
	hybrisRegistry.Lock()
	defer hybrisRegistry.Unlock()
	if b.ud == nil {
		hybrisRegistry.next++
		b.id = hybrisRegistry.next
		b.ud = C.malloc(C.size_t(unsafe.Sizeof(C.uint64_t(0))))
		*(*C.uint64_t)(b.ud) = C.uint64_t(b.id)
	}
	hybrisRegistry.m[b.id] = b
	return b.ud
}

func hybrisUnregister(b *HybrisBackend) {
	hybrisRegistry.Lock()
	delete(hybrisRegistry.m, b.id)
	hybrisRegistry.Unlock()
}

// hybrisBackendFromUD resolves callback userdata to its live backend, or nil.
func hybrisBackendFromUD(ud unsafe.Pointer) *HybrisBackend {
	if ud == nil {
		return nil
	}
	id := uint64(*(*C.uint64_t)(ud))
	hybrisRegistry.RLock()
	defer hybrisRegistry.RUnlock()
	return hybrisRegistry.m[id]
}
