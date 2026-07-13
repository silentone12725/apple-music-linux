//go:build linux

package drm

/*
#cgo CFLAGS: -D_GNU_SOURCE
#include "drm_embed.h"
#include <stdlib.h>
#include <signal.h>
*/
import "C"

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/fsnotify/fsnotify"
)

// EmbedConfig holds the transport configuration for EmbeddedBackend.
// It mirrors ProcessConfig but uses WrapperDir (directory containing rootfs/)
// instead of BinaryPath (the wrapper-rootless executable).
type EmbedConfig struct {
	// WrapperDir is the absolute path to the directory that contains rootfs/.
	// Typically this is the directory of the wrapper-rootless binary.
	WrapperDir     string
	OmitBaseDir    bool
	DecryptAddr    string
	M3U8Addr       string
	AccountAddr    string
	SuppressOutput bool // redirect wrapper stdout/stderr to /dev/null
}

// EmbeddedBackend implements DRMBackend by forking a child process that sets
// up an unprivileged container (user+mount namespaces + chroot) and exec's
// the Apple Music Android binary directly — no separate wrapper binary needed.
//
// The container child is started via CGO (drm_embed_start in drm_embed.c),
// which uses fork()+execve() so the Go runtime is never re-entered in the
// child. All namespace/mount/chroot operations happen only in the child; the
// Go engine's filesystem view and namespaces are completely unaffected.
//
// Once running, the Android binary exposes the same TCP ports as when launched
// by wrapper-rootless, so Decrypt/GetM3U8/GetAccount/DialCBCS are identical.
type EmbeddedBackend struct {
	exe     EmbedConfig
	cfg     BackendConfig // stored at Start; used for crash-restart session-reuse
	baseDir string        // convenience alias for cfg.BaseDir
	auth    AuthSource
	events  chan DRMEvent

	mu       sync.RWMutex
	state    ProcessState
	childPID int  // OS PID of the container child (0 = not running)
	stopping bool // set true by Stop(); cleared by next Start()

	stopCh chan struct{} // closed by Stop(); recreated on each Start()
	done   chan struct{} // closed when container child has fully exited
}

// NewEmbeddedBackend creates an EmbeddedBackend for the given configuration.
func NewEmbeddedBackend(exe EmbedConfig) *EmbeddedBackend {
	return &EmbeddedBackend{
		exe:    exe,
		events: make(chan DRMEvent, 64),
		// stopCh and done are initialised in Start().
	}
}

// ── DRMBackend implementation ─────────────────────────────────────────────────

func (b *EmbeddedBackend) SetAuthSource(a AuthSource) { b.auth = a }

func (b *EmbeddedBackend) Running() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.state == ProcessRunning || b.state == ProcessStarting
}

func (b *EmbeddedBackend) Events() <-chan DRMEvent { return b.events }

// Pid returns the container child's OS PID, or 0 if not running.
func (b *EmbeddedBackend) Pid() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.childPID
}

// Start forks the container child and begins state monitoring.
// If cfg.Credentials is set, passes --login to the Android binary for
// fresh authentication; otherwise uses existing mpl_db session.
func (b *EmbeddedBackend) Start(ctx context.Context, cfg BackendConfig) error {
	b.mu.Lock()
	if b.state == ProcessRunning || b.state == ProcessStarting {
		b.mu.Unlock()
		return fmt.Errorf("EmbeddedBackend already running")
	}
	b.state = ProcessStarting
	// Store cfg without credentials — crash restarts use session-reuse.
	b.cfg = BackendConfig{BaseDir: cfg.BaseDir, DeviceInfo: cfg.DeviceInfo}
	b.baseDir = cfg.BaseDir
	b.stopping = false
	b.stopCh = make(chan struct{})
	b.done = make(chan struct{})
	b.mu.Unlock()

	cCfg := b.buildCConfig(cfg)
	defer b.freeCConfig(cCfg)

	// drm_embed_start forks and blocks until the child either exec's (returns PID)
	// or fails during container setup (returns -1 with error printed to stderr).
	pid := C.drm_embed_start(cCfg)
	if pid < 0 {
		b.mu.Lock()
		b.state = ProcessFailed
		close(b.done)
		b.mu.Unlock()
		return fmt.Errorf("EmbeddedBackend: container launch failed (chroot/namespace/execve — see stderr)")
	}

	b.mu.Lock()
	b.childPID = int(pid)
	stopCh := b.stopCh
	done := b.done
	// Guard: Stop() may have been called while we were in the CGO fork. If stopCh
	// is already closed, kill the freshly-forked child immediately and bail out.
	alreadyStopped := false
	select {
	case <-stopCh:
		alreadyStopped = true
	default:
	}
	b.mu.Unlock()

	if alreadyStopped {
		// Group kill (see Stop() below for why): child_main() made pid its own
		// process-group leader before forking its "main" worker, so -pid reaps
		// both instead of orphaning the worker.
		_ = syscall.Kill(-int(pid), syscall.SIGKILL)
		syscall.Wait4(int(pid), nil, 0, nil) //nolint:errcheck
		b.mu.Lock()
		b.childPID = 0
		b.state = ProcessStopped
		b.mu.Unlock()
		close(done)
		return fmt.Errorf("EmbeddedBackend: stopped before launch completed")
	}

	b.emitEv(DRMEvent{Snapshot: DRMSnapshot{
		State:     DRMState{Process: ProcessStarting},
		Timestamp: time.Now(),
		Message:   fmt.Sprintf("embedded: started container child pid %d", pid),
	}})

	// Monitor goroutines — same approach as ProcessBackend.
	go b.waitChild(int(pid), stopCh, done)
	go b.embedPortProbe(b.decryptAddr(), stopCh)
	go b.embedWatchStateFile(b.baseDir, stopCh)

	return nil
}

// Authenticate restarts the backend for a fresh login (same as ProcessBackend).
func (b *EmbeddedBackend) Authenticate(ctx context.Context) error {
	b.mu.RLock()
	cfg := b.cfg
	b.mu.RUnlock()
	if cfg.BaseDir == "" {
		return fmt.Errorf("EmbeddedBackend: Authenticate called before Start")
	}
	if b.Running() {
		_ = b.Stop()
		b.mu.RLock()
		done := b.done
		b.mu.RUnlock()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return b.Start(ctx, cfg)
}

// Stop kills the container child and waits for it to exit.
func (b *EmbeddedBackend) Stop() error {
	b.mu.Lock()
	pid := b.childPID
	done := b.done
	stopCh := b.stopCh
	b.stopping = true
	b.mu.Unlock()

	if done == nil {
		// Never started.
		return nil
	}

	// Close stopCh to signal monitoring goroutines.
	select {
	case <-stopCh:
	default:
		close(stopCh)
	}

	// Kill the whole container process group, not just the tracked childPID.
	// childPID is the intermediate waiter (drm_embed.c: child_main's outer
	// fork); it forks again into a new PID namespace and execve's the
	// grandchild into /system/bin/main (the actual DRM worker). Both share one
	// process group (child_main calls setpgid(0,0) before that inner fork,
	// specifically so this group kill can reap them together). This makes the
	// no-orphan guarantee explicit rather than relying on drm_embed.c's
	// PR_SET_PDEATHSIG surviving the grandchild's execve — a kernel guarantee
	// conditional on that binary's privilege attributes (see drm_embed.c for
	// the full rationale and the controlled trials behind it).
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}

	// Block until the child has fully exited.
	<-done
	return nil
}

// ── Lifecycle monitoring ──────────────────────────────────────────────────────

// waitChild reaps the container child with Wait4 and signals done when it exits.
func (b *EmbeddedBackend) waitChild(pid int, stopCh, done chan struct{}) {
	defer close(done)

	var ws syscall.WaitStatus
	for {
		_, err := syscall.Wait4(pid, &ws, 0, nil)
		if err == nil {
			break
		}
		if err == syscall.EINTR {
			continue
		}
		break
	}

	b.mu.RLock()
	intentional := b.stopping
	b.mu.RUnlock()

	exitState := ProcessStopped
	if !intentional {
		exitState = ProcessFailed
	}
	b.setEmbedState(exitState)
	b.emitEv(DRMEvent{
		Snapshot: DRMSnapshot{
			State:     DRMState{Process: exitState},
			Timestamp: time.Now(),
			Message:   fmt.Sprintf("embedded: container child pid %d exited (intentional=%v)", pid, intentional),
		},
		Intentional: intentional,
	})

	b.mu.Lock()
	b.childPID = 0
	b.mu.Unlock()
}

// embedPortProbe polls the decrypt port and emits FairPlayReady when it opens.
// Mirrors ProcessBackend.portProbe.
func (b *EmbeddedBackend) embedPortProbe(addr string, stopCh chan struct{}) {
	const interval = 500 * time.Millisecond
	const probeTimeout = 300 * time.Millisecond

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
		}
		b.mu.RLock()
		state := b.state
		b.mu.RUnlock()

		conn, err := net.DialTimeout("tcp", addr, probeTimeout)
		if err != nil {
			if state == ProcessRunning {
				// Port disappeared while we thought we were running.
				b.setEmbedState(ProcessStarting)
				b.emitEv(DRMEvent{Snapshot: DRMSnapshot{
					State:     DRMState{Process: ProcessStarting},
					Timestamp: time.Now(),
					Message:   "embedded: decrypt port unreachable — stall detected",
				}})
			}
			continue
		}
		conn.Close()

		if state != ProcessRunning {
			b.setEmbedState(ProcessRunning)
			b.emitEv(DRMEvent{Snapshot: DRMSnapshot{
				State: DRMState{
					Process:        ProcessRunning,
					FairPlay:       FairPlayReady,
					Authentication: AuthLoggedIn,
					Recovery:       RecoveryIdle,
				},
				Timestamp: time.Now(),
				Message:   fmt.Sprintf("embedded: FairPlay ready at %s", addr),
			}})
		}
	}
}

// embedWatchStateFile watches baseDir/drm-state for state transitions written
// by write_drm_state() in main.c. Handles LOGIN and WAITING_2FA challenges.
// Mirrors ProcessBackend.watchStateFile exactly (inotify via fsnotify).
func (b *EmbeddedBackend) embedWatchStateFile(baseDir string, stopCh chan struct{}) {
	path := filepath.Join(baseDir, "drm-state")

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		// inotify unavailable; fall back to 250ms polling.
		b.embedWatchStateFilePoll(path, stopCh)
		return
	}
	defer watcher.Close()

	// Watch the parent directory: the file may not exist yet when the
	// watcher is created (main.c creates it during initialisation).
	_ = watcher.Add(baseDir)

	for {
		select {
		case ev, ok := <-watcher.Events:
			if !ok {
				return
			}
			if ev.Name != path {
				continue
			}
			if ev.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			content, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			b.applyEmbedStateFile(string(content))

		case <-watcher.Errors:
			// Ignore watcher errors; port probe is the fallback.

		case <-stopCh:
			return
		}
	}
}

// embedWatchStateFilePoll is the fallback used when inotify is unavailable.
func (b *EmbeddedBackend) embedWatchStateFilePoll(path string, stopCh chan struct{}) {
	last := ""
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
		}
		data, err := readFileSafe(path)
		if err != nil || data == last {
			continue
		}
		last = data
		b.applyEmbedStateFile(data)
	}
}

func (b *EmbeddedBackend) applyEmbedStateFile(content string) {
	r := ParseStateFile(content)
	// Don't propagate Process state from the state file — only the port probe
	// is authoritative for ProcessRunning (it verifies the TCP port is actually
	// open). The state file is informational for auth/fairplay/recovery states.
	b.mu.RLock()
	curProcess := b.state
	b.mu.RUnlock()
	state := DRMState{
		Process:        curProcess,
		FairPlay:       r.FairPlay,
		Authentication: r.Auth,
		Recovery:       r.Recovery,
	}
	b.emitEv(DRMEvent{Snapshot: DRMSnapshot{
		State:     state,
		Timestamp: time.Now(),
		Message:   strings.TrimSpace(content),
	}})

	if b.auth == nil {
		return
	}
	switch r.Auth {
	case AuthLoggingIn:
		go b.embedHandleCredentialRequest()
	case AuthChallenging:
		go b.embedHandle2FA()
	}
}

func (b *EmbeddedBackend) embedHandleCredentialRequest() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	reply, err := b.auth.Challenge(ctx, AuthChallenge{Type: ChallengeCredentials, Title: "Apple ID"})
	if err != nil || reply == "" {
		return
	}
	parts := strings.SplitN(reply, "\x00", 2)
	if len(parts) != 2 || parts[0] == "" {
		return
	}
	_ = b.Stop()
	if ctx.Err() != nil {
		return
	}
	b.mu.RLock()
	cfg := b.cfg
	b.mu.RUnlock()
	cfg.Credentials = Credentials{Email: parts[0], Password: parts[1]}
	_ = b.Start(ctx, cfg)
}

func (b *EmbeddedBackend) embedHandle2FA() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	reply, err := b.auth.Challenge(ctx, AuthChallenge{
		Type:     ChallengeTwoFactor,
		Title:    "Two-Factor Authentication",
		Metadata: map[string]string{"issuer": "Apple ID"},
	})
	if err != nil {
		return
	}
	path := filepath.Join(b.baseDir, "2fa.txt")
	_ = writeFileSafe(path, reply+"\n")
}

// ── TCP operations — identical to ProcessBackend ──────────────────────────────

func (b *EmbeddedBackend) decryptAddr() string {
	if b.exe.DecryptAddr != "" {
		return b.exe.DecryptAddr
	}
	return processDecryptAddrDefault
}

func (b *EmbeddedBackend) m3u8Addr() string {
	if b.exe.M3U8Addr != "" {
		return b.exe.M3U8Addr
	}
	return processM3U8AddrDefault
}

func (b *EmbeddedBackend) accountAddr() string {
	if b.exe.AccountAddr != "" {
		return b.exe.AccountAddr
	}
	return processAccountAddrDefault
}

func (b *EmbeddedBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	conn, err := net.DialTimeout("tcp", b.decryptAddr(), 5*time.Second)
	if err != nil {
		return DecryptResponse{}, fmt.Errorf("drm decrypt dial: %w", err)
	}
	defer closeConn(conn)
	rw := newBufRW(conn)
	if err := sendString(rw, req.AdamID); err != nil {
		return DecryptResponse{}, fmt.Errorf("drm send adamID: %w", err)
	}
	if err := sendString(rw, req.KeyURI); err != nil {
		return DecryptResponse{}, fmt.Errorf("drm send uri: %w", err)
	}
	results := make([][]byte, 0, len(req.Samples))
	for _, sample := range req.Samples {
		if ctx.Err() != nil {
			return DecryptResponse{}, ctx.Err()
		}
		dec, err := decryptOneSample(rw, sample)
		if err != nil {
			return DecryptResponse{}, fmt.Errorf("drm decrypt sample: %w", err)
		}
		results = append(results, dec)
	}
	if err := binary.Write(rw, binary.LittleEndian, uint32(0)); err != nil {
		return DecryptResponse{}, fmt.Errorf("drm terminate: %w", err)
	}
	_ = rw.Flush()
	return DecryptResponse{Samples: results}, nil
}

func (b *EmbeddedBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	conn, err := net.DialTimeout("tcp", b.m3u8Addr(), 5*time.Second)
	if err != nil {
		return "", fmt.Errorf("drm m3u8 dial: %w", err)
	}
	defer conn.Close()
	rw := newBufRW(conn)
	if err := sendString(rw, fmt.Sprintf("%d", adamID)); err != nil {
		return "", fmt.Errorf("drm m3u8 send id: %w", err)
	}
	_ = rw.Flush()
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return "", fmt.Errorf("drm m3u8: no response")
	}
	url := strings.TrimSpace(scanner.Text())
	if url == "" {
		return "", fmt.Errorf("drm m3u8: empty URL (adamID %d)", adamID)
	}
	return url, nil
}

func (b *EmbeddedBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	addr := b.decryptAddr()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("cbcs dial %s: %w", addr, err)
	}
	return conn, nil
}

func (b *EmbeddedBackend) GetAccount(_ context.Context) (AccountInfo, error) {
	resp, err := http.Get("http://" + b.accountAddr() + "/")
	if err != nil {
		return AccountInfo{}, fmt.Errorf("drm account: %w", err)
	}
	defer resp.Body.Close()
	var obj struct {
		StorefrontID string `json:"storefront_id"`
		DevToken     string `json:"dev_token"`
		MusicToken   string `json:"music_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&obj); err != nil {
		return AccountInfo{}, fmt.Errorf("drm account decode: %w", err)
	}
	return AccountInfo{
		StorefrontID: obj.StorefrontID,
		DevToken:     obj.DevToken,
		MusicToken:   obj.MusicToken,
	}, nil
}

// ── CGO config helpers ────────────────────────────────────────────────────────

// buildCConfig converts Go BackendConfig + EmbedConfig into a C DRMEmbedConfig.
// All strings are C.CString allocations; freeCConfig must be called after use.
func (b *EmbeddedBackend) buildCConfig(cfg BackendConfig) *C.DRMEmbedConfig {
	c := (*C.DRMEmbedConfig)(C.calloc(1, C.sizeof_DRMEmbedConfig))

	c.wrapper_dir = C.CString(b.exe.WrapperDir)
	c.code_from_file = 1 // always enable; 2fa.txt injection is always available
	if b.exe.SuppressOutput {
		c.suppress_output = 1
	}

	// Derive the chroot-internal base_dir from the host path.
	if !b.exe.OmitBaseDir && cfg.BaseDir != "" {
		c.base_dir = C.CString(b.chrootBasePath(cfg.BaseDir))
	}

	// Addresses: split host:port from DecryptAddr for the --host / --decrypt-port split.
	if b.exe.DecryptAddr != "" {
		host, port, err := net.SplitHostPort(b.exe.DecryptAddr)
		if err == nil {
			c.host = C.CString(host)
			c.decrypt_port = C.CString(port)
		}
	}
	if b.exe.M3U8Addr != "" {
		_, port, err := net.SplitHostPort(b.exe.M3U8Addr)
		if err == nil {
			c.m3u8_port = C.CString(port)
		}
	}
	if b.exe.AccountAddr != "" {
		_, port, err := net.SplitHostPort(b.exe.AccountAddr)
		if err == nil {
			c.account_port = C.CString(port)
		}
	}
	if cfg.DeviceInfo != "" {
		c.device_info = C.CString(cfg.DeviceInfo)
	}
	if cfg.Credentials.Email != "" {
		c.login = C.CString(cfg.Credentials.Email + ":" + cfg.Credentials.Password)
	}
	return c
}

// freeCConfig frees all C strings allocated by buildCConfig.
func (b *EmbeddedBackend) freeCConfig(c *C.DRMEmbedConfig) {
	if c == nil {
		return
	}
	freeIfNotNil := func(p *C.char) {
		if p != nil {
			C.free(unsafe.Pointer(p))
		}
	}
	freeIfNotNil(c.wrapper_dir)
	freeIfNotNil(c.base_dir)
	freeIfNotNil(c.host)
	freeIfNotNil(c.decrypt_port)
	freeIfNotNil(c.m3u8_port)
	freeIfNotNil(c.account_port)
	freeIfNotNil(c.device_info)
	freeIfNotNil(c.login)
	C.free(unsafe.Pointer(c))
}

// chrootBasePath derives the chroot-internal path from the host BaseDir.
// Example: host=/path/to/wrapper/rootfs/data/.../files, wrapperDir=/path/to/wrapper
// → chroot path = /data/.../files
func (b *EmbeddedBackend) chrootBasePath(hostBaseDir string) string {
	prefix := filepath.Join(b.exe.WrapperDir, "rootfs")
	rel, err := filepath.Rel(prefix, hostBaseDir)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "/data/data/com.apple.android.music/files"
	}
	return "/" + rel
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (b *EmbeddedBackend) setEmbedState(s ProcessState) {
	b.mu.Lock()
	b.state = s
	b.mu.Unlock()
}

func (b *EmbeddedBackend) emitEv(ev DRMEvent) {
	select {
	case b.events <- ev:
	default:
	}
}

func readFileSafe(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func writeFileSafe(path, content string) error {
	return os.WriteFile(path, []byte(content), 0644)
}
