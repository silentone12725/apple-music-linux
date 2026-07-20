package drm

// ProcessBackend implements DRMBackend by managing the wrapper binary as a
// subprocess. It is the Phase 1 implementation and is used to validate the
// full DRM API surface (authentication, 2FA, session management, playback)
// before the EmbeddedBackend (CGO) is introduced in Phase 2.
//
// Ownership: ProcessBackend owns everything related to the wrapper process.
//   wrapper process lifecycle (start, stop, restart)
//   TCP/HTTP ports (10020, 20020, 30020) and their protocol framing
//   drm-state file monitoring (inotify)
//   authentication flow (credential challenge + restart, 2FA injection)
//   stderr log forwarding
//   crash detection and signalling to DRMManager
//
// ProcessBackend does NOT own:
//   mpl_db, STOREFRONT_ID, MUSIC_TOKEN, 2fa.txt — that's SessionManager
//   credentials storage — that's AuthCoordinator
//   SSE events — that's DRMManager via EventSink
//   restart policy decisions — that's DRMManager via RestartPolicy
//
// State detection uses three independent sources (event-driven, not polling):
//  1. cmd.Wait() goroutine: fires EventCrashed when the process exits.
//  2. inotify on {BaseDir}/drm-state: fires EventStateChanged when main.c
//     calls write_drm_state() at key transitions.
//  3. TCP port probe: fallback heartbeat while Running, to catch silent crashes.
//
// The drm-state file is written by a small helper added to main.c (~8 lines).
// If the wrapper binary lacks this helper, state detection falls back to the
// TCP port probe alone (slower but functional).
//
// DRM operations (Decrypt, GetM3U8, GetAccount) delegate to the existing
// TCP protocol. This is a migration-layer artifact: Phase 2 replaces these
// with direct CGO calls and removes the TCP dependency entirely.

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	processDecryptAddrDefault = "127.0.0.1:10020"
	processM3U8AddrDefault    = "127.0.0.1:20020"
	processAccountAddrDefault = "127.0.0.1:30020"
	portProbeInterval         = 5 * time.Second
	portProbeTimeout          = 200 * time.Millisecond
)

// ProcessConfig holds transport details that are internal to ProcessBackend.
// These never appear in BackendConfig because they are meaningless to EmbeddedBackend.
type ProcessConfig struct {
	// BinaryPath is the path to the wrapper-rootless binary.
	BinaryPath string

	// OmitBaseDir skips the --base-dir flag. Set true for the real wrapper binary,
	// which resolves BaseDir relative to its working directory (set to
	// filepath.Dir(BinaryPath) in launch) and breaks if given an absolute path.
	// Leave false for mock/test binaries that need an explicit --base-dir.
	OmitBaseDir bool

	// DecryptAddr is the TCP address of the decryption socket.
	// Default: "127.0.0.1:10020".
	DecryptAddr string

	// M3U8Addr is the TCP address of the M3U8 socket.
	// Default: "127.0.0.1:20020".
	M3U8Addr string

	// AccountAddr is the HTTP address of the account socket.
	// Default: "127.0.0.1:30020".
	AccountAddr string
}

// ProcessBackend manages the wrapper-rootless binary as a subprocess and
// implements DRMBackend by delegating DRM operations to its TCP/HTTP servers.
type ProcessBackend struct {
	exe     ProcessConfig // transport details; internal to this backend
	cfg     BackendConfig // stored at Start time; used for credential-triggered restart
	baseDir string        // convenience alias for cfg.BaseDir
	auth    AuthSource
	events  chan DRMEvent
	state   ProcessState
	mu      sync.RWMutex
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	watcher *fsnotify.Watcher

	// stopCh is closed when Stop() is called. It is recreated on each launch()
	// so monitor goroutines from a previous run cannot outlive their process.
	stopCh chan struct{}

	// done is closed by waitForExit when cmd.Wait() returns and all goroutines
	// spawned by launch() have acknowledged the shutdown. Stop() blocks on it
	// so that launch() is never called while the old process is still running.
	done chan struct{}

	// stopping is set true by Stop() before cancel() is called, and cleared
	// by launch() on the next start. DRMManager uses this flag (via the
	// IntentionalStop field on DRMEvent) to distinguish a clean stop from a
	// crash, preventing handleCrash from firing on intentional stops.
	stopping bool

	// adoptedPID is the OS PID of a wrapper process that was adopted (not
	// launched) by Start(). Stop() uses it to kill the process — without it,
	// Stop() would be a no-op for adopted wrappers, preventing fresh login
	// after Logout (the adopted wrapper holds the port, blocking a new launch).
	adoptedPID int
}

// NewProcessBackend creates a ProcessBackend with the given transport config.
// SetAuthSource must be called before Start.
func NewProcessBackend(cfg ProcessConfig) *ProcessBackend {
	// done starts closed: Stop() called before any launch returns immediately.
	doneCh := make(chan struct{})
	close(doneCh)
	return &ProcessBackend{
		exe:    cfg,
		events: make(chan DRMEvent, 32),
		stopCh: make(chan struct{}),
		done:   doneCh,
	}
}

func (b *ProcessBackend) SetAuthSource(a AuthSource) { b.auth = a }

// Running reports whether the backend process is currently running.
func (b *ProcessBackend) Running() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.state == ProcessRunning
}

// Pid returns the OS process ID of the running wrapper, or 0 if not running.
func (b *ProcessBackend) Pid() int {
	b.mu.RLock()
	cmd := b.cmd
	b.mu.RUnlock()
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

// Events returns the backend event channel.
func (b *ProcessBackend) Events() <-chan DRMEvent { return b.events }

// Start launches the wrapper-rootless subprocess for session reuse.
// It does NOT authenticate — the wrapper starts with an existing mpl_db.
// Call Login() to authenticate from scratch.
//
// If the decrypt port is already reachable (e.g. drmcheck left a wrapper alive),
// Start adopts the running wrapper instead of launching a second one. This avoids
// port conflicts when a prior run did not clean up its subprocess.
func (b *ProcessBackend) Start(ctx context.Context, cfg BackendConfig) error {
	if b.exe.BinaryPath == "" {
		return fmt.Errorf("ProcessConfig.BinaryPath not set")
	}
	if cfg.BaseDir == "" {
		return fmt.Errorf("BackendConfig.BaseDir not set")
	}
	// Store config without credentials — crash restarts use session-reuse (no
	// --login), which is correct because mpl_db was written during the initial login.
	b.mu.Lock()
	b.cfg = BackendConfig{BaseDir: cfg.BaseDir, DeviceInfo: cfg.DeviceInfo}
	b.baseDir = cfg.BaseDir
	b.mu.Unlock()

	// Only adopt a running wrapper on session-reuse starts (no credentials).
	// Fresh logins (credentials present) skip the probe and always launch a new
	// process so --login reaches storeservicescore and forces full authentication.
	if cfg.Credentials.Email == "" {
		addr := b.decryptAddr()
		if conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
			conn.Close()
			pid := probeListeningPID(addr)
			b.mu.Lock()
			b.adoptedPID = pid
			b.mu.Unlock()
			b.setProcessState(ProcessRunning)
			b.emit(DRMEvent{Snapshot: DRMSnapshot{
				State: DRMState{
					Process:  ProcessRunning,
					FairPlay: FairPlayReady,
					Recovery: RecoveryIdle,
				},
				Timestamp: time.Now(),
				Message:   fmt.Sprintf("adopted running wrapper at %s", addr),
			}})
			return nil
		}
	}

	return b.launch(ctx, b.buildArgs(cfg))
}

// launch is the shared subprocess launch path for Start() and Login().
// It owns process creation, stderr wiring, and the three state-monitor goroutines.
//
// IMPORTANT: The process context is derived from context.Background(), NOT from
// the caller's ctx. The caller's ctx controls only the launch attempt itself
// (connection setup, cmd.Start). The wrapper must keep running after Login()
// returns — if procCtx were derived from loginCtx, it would be cancelled by
// Login()'s deferred cancel, killing the wrapper immediately.
//
// Precondition: the previous process must have fully exited (Stop() returned)
// before calling launch again.
func (b *ProcessBackend) launch(ctx context.Context, args []string) error {
	b.mu.Lock()
	if b.state == ProcessRunning || b.state == ProcessStarting {
		b.mu.Unlock()
		return fmt.Errorf("backend already running")
	}
	b.state = ProcessStarting
	// Recreate per-launch channels so goroutines from the previous run cannot
	// outlive their process and interfere with the new one.
	b.stopCh = make(chan struct{})
	b.done = make(chan struct{})
	b.stopping = false
	b.mu.Unlock()

	// Use a Background-derived context for the process lifetime.
	// The caller's ctx is intentionally NOT used here: Login() has a
	// loginCtx with defer cancel() that fires when Login returns. If
	// procCtx were derived from loginCtx, the wrapper would be killed
	// the moment Login() returns successfully.
	procCtx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	_ = ctx // caller ctx is unused; kept as parameter for future use

	cmd := exec.CommandContext(procCtx, b.exe.BinaryPath, args...)
	cmd.Dir = filepath.Dir(b.exe.BinaryPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		// Own process group: wrapper-rootless forks a worker ("main") that holds
		// the DRM ports. Placing the whole wrapper tree in its own group lets
		// Stop() reap every descendant with one signal, instead of orphaning the
		// worker when only the direct child is killed.
		Setpgid: true,
		// Defense-in-depth beyond the graceful Stop() path above: if the ENGINE
		// process itself dies without calling Stop() (crash, panic, OOM-killer,
		// or an uncatchable SIGKILL from a supervisor), the kernel delivers
		// SIGKILL to the wrapper launcher automatically. Without this, an abrupt
		// engine death orphans the wrapper (and the single-user session it
		// holds) exactly like the bug this Setpgid change was fixing, just one
		// level up the process tree.
		Pdeathsig: syscall.SIGKILL,
	}
	b.cmd = cmd

	stderr, err := cmd.StderrPipe()
	if err != nil {
		b.setProcessState(ProcessFailed)
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		b.setProcessState(ProcessFailed)
		return fmt.Errorf("start %s: %w", b.exe.BinaryPath, err)
	}

	b.setProcessState(ProcessStarting)
	b.emit(DRMEvent{Snapshot: DRMSnapshot{
		State:     DRMState{Process: ProcessStarting},
		Timestamp: time.Now(),
		Message:   fmt.Sprintf("started pid %d", cmd.Process.Pid),
	}})

	// Capture the channels for this launch so goroutines below are scoped
	// to this process instance even if b.stopCh/b.done are replaced later.
	b.mu.RLock()
	stopCh := b.stopCh
	done := b.done
	b.mu.RUnlock()

	// Source 1: process exit detection.
	go b.waitForExit(cmd, stopCh, done)

	// Source 2: inotify on drm-state file.
	go b.watchStateFile(b.baseDir, stopCh)

	// Source 3: TCP port probe (fallback / heartbeat).
	go b.portProbe(b.decryptAddr(), stopCh)

	// Stderr log forwarding. Exits when the pipe closes (process exits).
	go b.forwardStderr(stderr)

	return nil
}

// buildArgs constructs the wrapper-rootless argv from cfg.
// When cfg.Credentials.Email is set, --login email:password is appended so
// storeservicescore performs a full authentication instead of session reuse.
func (b *ProcessBackend) buildArgs(cfg BackendConfig) []string {
	args := []string{
		"--code-from-file", // 2FA always injected via 2fa.txt
	}
	if !b.exe.OmitBaseDir && cfg.BaseDir != "" {
		args = append(args, "--base-dir", cfg.BaseDir)
	}
	if b.exe.DecryptAddr != "" {
		host, port, _ := net.SplitHostPort(b.exe.DecryptAddr)
		args = append(args, "--host", host, "--decrypt-port", port)
	}
	if b.exe.M3U8Addr != "" {
		_, port, _ := net.SplitHostPort(b.exe.M3U8Addr)
		args = append(args, "--m3u8-port", port)
	}
	if b.exe.AccountAddr != "" {
		_, port, _ := net.SplitHostPort(b.exe.AccountAddr)
		args = append(args, "--account-port", port)
	}
	if cfg.DeviceInfo != "" {
		args = append(args, "--device-info", cfg.DeviceInfo)
	}
	if cfg.Credentials.Email != "" {
		args = append(args, "--login", cfg.Credentials.Email+":"+cfg.Credentials.Password)
	}
	return args
}

// Authenticate implements DRMBackend.
//
// Semantic intent: ensure an authenticated DRM context exists. The backend
// decides what "ensuring" means for its implementation:
//
//   - ProcessBackend (this): restart the subprocess. The wrapper's own startup
//     logic checks mpl_db; if a valid session exists it runs immediately; if not
//     it fires credentialHandler → Challenge(ChallengeCredentials). The restart
//     is an implementation detail invisible above DRMBackend.
//
//   - EmbeddedBackend (Phase 2): call wrapper_authenticate() in-place.
//     No subprocess restart needed; the C function handles session checking
//     and credential prompting directly.
//
//   - Future implementations: may simply assert an already-authenticated runtime
//     or delegate to an OS keychain. The intent is unchanged; only the mechanism
//     differs.
//
// Callers must not assume any particular mechanism. The only guarantee is that
// after Authenticate returns nil, the backend is ready to decrypt.
func (b *ProcessBackend) Authenticate(ctx context.Context) error {
	b.mu.RLock()
	cfg := b.cfg
	b.mu.RUnlock()
	if cfg.BaseDir == "" {
		// Authenticate called before Start — no stored cfg yet.
		return fmt.Errorf("ProcessBackend: Authenticate called before Start")
	}
	if b.Running() {
		_ = b.Stop()
		// Wait for exit so launch() does not race with the dying process.
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
	return b.launch(ctx, b.buildArgs(cfg))
}

// Stop signals the backend process to stop and blocks until it has fully
// exited and all monitor goroutines have shut down.
//
// Stop() is safe to call concurrently. The select-default on stopCh prevents
// a double-close panic if multiple goroutines call Stop() simultaneously, or
// if waitForExit already closed stopCh (crash path). All callers block on
// done and return after the process exits.
func (b *ProcessBackend) Stop() error {
	b.mu.Lock()
	cancel := b.cancel
	done := b.done
	stopCh := b.stopCh
	adopted := b.adoptedPID
	b.adoptedPID = 0
	b.stopping = true // signals waitForExit to mark the exit as intentional
	pid := 0
	if b.cmd != nil && b.cmd.Process != nil {
		pid = b.cmd.Process.Pid
	}
	b.mu.Unlock()

	// Adopted wrapper: no subprocess context exists (done and stopCh are nil).
	// Kill by OS PID instead. Without this, Stop() would deadlock on <-done.
	if done == nil {
		if adopted != 0 {
			if p, err := os.FindProcess(adopted); err == nil {
				_ = p.Kill()
			}
			// Give the kernel time to release the port before the caller
			// attempts a fresh Start(). 250 ms is sufficient for loopback.
			time.Sleep(250 * time.Millisecond)
		}
		b.setProcessState(ProcessStopped)
		b.emit(DRMEvent{
			Snapshot: DRMSnapshot{
				State:     DRMState{Process: ProcessStopped},
				Timestamp: time.Now(),
				Message:   fmt.Sprintf("adopted wrapper pid %d killed", adopted),
			},
			Intentional: true,
		})
		return nil
	}

	// Signal monitor goroutines to exit. select-default is safe against
	// double-close: if stopCh is already closed (crash or concurrent Stop),
	// the receive case wins and we skip the close.
	select {
	case <-stopCh:
	default:
		close(stopCh)
	}

	// Reap the entire wrapper process group. wrapper-rootless forks a worker
	// ("main") that holds the DRM ports and is not a direct child of this
	// process, so CommandContext's SIGKILL to the direct child alone would orphan
	// it (leaking the port and the single-user session). Setpgid at launch put
	// the whole tree in its own group (pgid == pid), so a negative-PID SIGKILL
	// reaps launcher and worker together without touching the engine.
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}

	// Cancel the process context (SIGKILL via exec.CommandContext) as a backstop.
	if cancel != nil {
		cancel()
	}

	// Block until waitForExit closes done.
	// Reading from an already-closed channel returns immediately,
	// so this is safe whether the process crashed before Stop was called.
	<-done
	return nil
}

// ── State monitoring ──────────────────────────────────────────────────────────

// waitForExit is the canonical exit point for a launched process.
// It closes done when cmd.Wait() returns, which unblocks Stop().
// IntentionalStop is set in the event when b.stopping is true, so that
// DRMManager.watchEvents can skip handleCrash for intentional shutdowns.
func (b *ProcessBackend) waitForExit(cmd *exec.Cmd, stopCh, done chan struct{}) {
	cmd.Wait() //nolint:errcheck

	// Signal portProbe and watchStateFile to exit (in case stopCh wasn't
	// already closed by Stop()). Safe to call close on a closed channel here
	// because we check b.stopping to determine who closed it first.
	b.mu.RLock()
	intentional := b.stopping
	b.mu.RUnlock()

	// Close stopCh if Stop() didn't (process crashed before Stop was called).
	select {
	case <-stopCh:
		// already closed by Stop()
	default:
		close(stopCh)
	}

	b.setProcessState(ProcessStopped)
	b.emit(DRMEvent{
		Snapshot: DRMSnapshot{
			State:     DRMState{Process: ProcessStopped},
			Timestamp: time.Now(),
			Message:   fmt.Sprintf("process exited (pid %d, intentional=%v)", cmd.Process.Pid, intentional),
		},
		Intentional: intentional,
	})

	// Unblock Stop().
	close(done)
}

func (b *ProcessBackend) watchStateFile(baseDir string, stopCh chan struct{}) {
	path := filepath.Join(baseDir, "drm-state")

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		// inotify unavailable; fall back to port probe only.
		return
	}
	defer watcher.Close()

	// Ensure the parent directory is watched (file may not exist yet).
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
			b.applyStateFile(string(content))

		case <-watcher.Errors:
			// Ignore watch errors; port probe is the fallback.

		case <-stopCh:
			return
		}
	}
}

func (b *ProcessBackend) applyStateFile(content string) {
	r := ParseStateFile(content)
	state := DRMState{
		Process:        r.Process,
		FairPlay:       r.FairPlay,
		Authentication: r.Auth,
		Recovery:       r.Recovery,
	}
	if r.Process == ProcessRunning {
		b.setProcessState(ProcessRunning)
	}
	b.emit(DRMEvent{Snapshot: DRMSnapshot{
		State:     state,
		Timestamp: time.Now(),
		Message:   strings.TrimSpace(content),
	}})

	// Challenge-driven authentication: react to credential requests from the wrapper.
	//
	// LOGIN: wrapper needs Apple ID + password.
	//   ProcessBackend fires Challenge(ChallengeCredentials), gets reply, then
	//   stops and relaunches with --login email:pass. This restart is an
	//   implementation detail of ProcessBackend — it is invisible above DRMBackend.
	//
	// WAITING_2FA: wrapper needs 2FA code.
	//   Challenge(ChallengeTwoFactor) fires; reply is written to 2fa.txt
	//   which the wrapper's --code-from-file mechanism reads and deletes.
	if b.auth == nil {
		return
	}

	switch r.Auth {
	case AuthLoggingIn:
		go b.handleCredentialRequest()
	case AuthChallenging:
		go b.handle2FARequest()
	}
}

// handleCredentialRequest fires when the wrapper emits the LOGIN drm-state,
// meaning storeservicescore called credentialHandler and needs Apple ID credentials.
// This is an implementation detail of ProcessBackend: it gets credentials via
// the challenge mechanism (same as for 2FA) then restarts with --login.
// Nothing above DRMBackend sees or knows about the restart.
func (b *ProcessBackend) handleCredentialRequest() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	reply, err := b.auth.Challenge(ctx, AuthChallenge{
		Type:  ChallengeCredentials,
		Title: "Apple ID",
	})
	if err != nil || reply == "" {
		b.emit(DRMEvent{Snapshot: DRMSnapshot{
			State:     DRMState{Authentication: AuthFailed},
			Timestamp: time.Now(),
			Message:   "credential challenge failed: " + err.Error(),
		}})
		return
	}

	parts := strings.SplitN(reply, "\x00", 2)
	if len(parts) != 2 || parts[0] == "" {
		return
	}
	email, password := parts[0], parts[1]

	// Stop() is now synchronous: it blocks until cmd.Wait() returns and
	// done is closed. This replaces the old 500ms blind sleep and eliminates
	// the race where handleCrash (triggered by the ProcessStopped event from
	// the dying process) could beat this goroutine to launch().
	if err := b.Stop(); err != nil {
		return
	}
	if ctx.Err() != nil {
		return
	}

	b.mu.RLock()
	cfg := b.cfg
	b.mu.RUnlock()

	args := b.buildArgs(cfg)
	args = append(args, "--login", email+":"+password)
	_ = b.launch(ctx, args)
}

// handle2FARequest fires when the wrapper emits the WAITING_2FA drm-state.
func (b *ProcessBackend) handle2FARequest() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	reply, err := b.auth.Challenge(ctx, AuthChallenge{
		Type:  ChallengeTwoFactor,
		Title: "Two-Factor Authentication",
		Metadata: map[string]string{
			"issuer": "Apple ID",
		},
	})
	if err != nil {
		return
	}
	path := filepath.Join(b.baseDir, "2fa.txt")
	_ = os.WriteFile(path, []byte(reply+"\n"), 0600)
}

func (b *ProcessBackend) portProbe(addr string, stopCh chan struct{}) {
	ticker := time.NewTicker(portProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.mu.RLock()
			state := b.state
			b.mu.RUnlock()
			if state != ProcessRunning {
				continue
			}
			conn, err := net.DialTimeout("tcp", addr, portProbeTimeout)
			if err == nil {
				conn.Close()
				continue
			}
			// Port unreachable while we believed the process was running;
			// emit a state change — could be recovery gate or crash.
			b.emit(DRMEvent{Snapshot: DRMSnapshot{
				State:     DRMState{Process: ProcessStarting},
				Timestamp: time.Now(),
				Message:   fmt.Sprintf("port %s unreachable: %v", addr, err),
			}})
		case <-stopCh:
			return
		}
	}
}

func (b *ProcessBackend) forwardStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		b.mu.RLock()
		state := b.state
		b.mu.RUnlock()

		snapshot := DRMSnapshot{
			State:     DRMState{Process: state},
			Timestamp: time.Now(),
			Message:   line,
		}

		var changed bool
		if strings.Contains(line, "[+] account info cached successfully") {
			snapshot.State.Session = SessionValid
			snapshot.State.Authentication = AuthLoggedIn
			changed = true
		} else if strings.Contains(line, "[!] listening 127.0.0.1:10020") {
			snapshot.State.FairPlay = FairPlayReady
			snapshot.State.Process = ProcessRunning
			changed = true
			b.setProcessState(ProcessRunning)
		} else if strings.Contains(line, "ERROR no Active Account") {
			snapshot.State.Session = SessionEmpty
			snapshot.State.Authentication = AuthLoggingIn
			changed = true
		} else if strings.Contains(line, "wait for 2fa code") {
			snapshot.State.Authentication = AuthChallenging
			changed = true
		}

		b.emit(DRMEvent{Snapshot: snapshot})

		if changed && b.auth != nil {
			if snapshot.State.Authentication == AuthLoggingIn {
				go b.handleCredentialRequest()
			} else if snapshot.State.Authentication == AuthChallenging {
				go b.handle2FARequest()
			}
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (b *ProcessBackend) decryptAddr() string {
	if b.exe.DecryptAddr != "" {
		return b.exe.DecryptAddr
	}
	return processDecryptAddrDefault
}

func (b *ProcessBackend) m3u8Addr() string {
	if b.exe.M3U8Addr != "" {
		return b.exe.M3U8Addr
	}
	return processM3U8AddrDefault
}

func (b *ProcessBackend) accountAddr() string {
	if b.exe.AccountAddr != "" {
		return b.exe.AccountAddr
	}
	return processAccountAddrDefault
}

func (b *ProcessBackend) setProcessState(s ProcessState) {
	b.mu.Lock()
	b.state = s
	b.mu.Unlock()
}

func (b *ProcessBackend) emit(ev DRMEvent) {
	select {
	case b.events <- ev:
	default:
		// Drop if buffer full; DRMManager is expected to drain promptly.
	}
}

// ── DRM operations (Phase 1: TCP/HTTP delegation) ────────────────────────────
//
// These implement the existing wire protocol. In Phase 2, EmbeddedBackend
// replaces them with direct CGO calls. The DRMBackend interface is identical.

// Decrypt implements DRMBackend using the existing runv2 TCP protocol.
//
// Wire format (per-session):
//
//	Send: uint8 adamIDLen + []byte adamID
//	Send: uint8 uriLen   + []byte uri
//	Loop:
//	  Send: uint32 sampleLen (0 = terminate)
//	  Send: []byte encryptedSample
//	  Recv: []byte decryptedSample
func (b *ProcessBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
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
		decrypted, err := decryptOneSample(rw, sample)
		if err != nil {
			return DecryptResponse{}, fmt.Errorf("drm decrypt sample: %w", err)
		}
		results = append(results, decrypted)
	}

	// Termination signal.
	if err := binary.Write(rw, binary.LittleEndian, uint32(0)); err != nil {
		return DecryptResponse{}, fmt.Errorf("drm terminate: %w", err)
	}
	_ = rw.Flush()

	return DecryptResponse{Samples: results}, nil
}

func decryptOneSample(rw interface {
	io.Reader
	io.Writer
	Flush() error
}, sample []byte) ([]byte, error) {
	// Truncate to multiple of 16 (FairPlay AES block size).
	truncLen := len(sample) & ^0xf
	if truncLen == 0 {
		return sample, nil
	}
	if err := binary.Write(rw, binary.LittleEndian, uint32(truncLen)); err != nil {
		return nil, err
	}
	if _, err := rw.Write(sample[:truncLen]); err != nil {
		return nil, err
	}
	if err := rw.(interface{ Flush() error }).Flush(); err != nil {
		return nil, err
	}
	out := make([]byte, len(sample))
	copy(out, sample)
	if _, err := io.ReadFull(rw, out[:truncLen]); err != nil {
		return nil, err
	}
	return out, nil
}

// GetM3U8 implements DRMBackend via port 20020 TCP protocol.
//
// Wire format:
//
//	Send: uint8 adamIDLen + []byte adamID (as decimal string)
//	Recv: []byte url + '\n'
func (b *ProcessBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	conn, err := net.DialTimeout("tcp", b.m3u8Addr(), 5*time.Second)
	if err != nil {
		return "", fmt.Errorf("drm m3u8 dial: %w", err)
	}
	defer conn.Close()

	idStr := fmt.Sprintf("%d", adamID)
	rw := newBufRW(conn)
	if err := sendString(rw, idStr); err != nil {
		return "", fmt.Errorf("drm m3u8 send id: %w", err)
	}
	_ = rw.Flush()

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return "", fmt.Errorf("drm m3u8: no response")
	}
	url := strings.TrimSpace(scanner.Text())
	if url == "" {
		return "", fmt.Errorf("drm m3u8: empty URL (adamID %d not available)", adamID)
	}
	return url, nil
}

// DialCBCS implements DRMBackend and fairplay.CBCSDialer by opening one TCP
// connection to the wrapper's decryption socket. The caller owns the connection
// and speaks the runv2 FairPlay wire protocol (sendString + DecryptFragment).
func (b *ProcessBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	addr := b.decryptAddr()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("cbcs dial %s: %w", addr, err)
	}
	return conn, nil
}

// GetAccount implements DRMBackend via port 30020 HTTP.
func (b *ProcessBackend) GetAccount(_ context.Context) (AccountInfo, error) {
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

// ── Internal helpers ──────────────────────────────────────────────────────────

type bufRW struct {
	conn net.Conn
	*bufio.ReadWriter
}

func newBufRW(conn net.Conn) *bufRW {
	return &bufRW{
		conn:       conn,
		ReadWriter: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)),
	}
}

// sendString writes a 1-byte length-prefix followed by the string bytes.
// This mirrors runv2.SendString and is part of the FairPlay TCP wire protocol.
// Inlined here so engine/drm does not import utils/runv2 directly.
func sendString(w io.Writer, s string) error {
	if _, err := w.Write([]byte{byte(len(s))}); err != nil {
		return err
	}
	_, err := io.WriteString(w, s)
	return err
}

// closeConn sends the CLOSE signal (5 zero bytes) to the wrapper socket and
// closes the connection. Mirrors runv2.Close; inlined to avoid runv2 import.
func closeConn(c interface {
	Write([]byte) (int, error)
	Close() error
}) error {
	defer c.Close()
	_, err := c.Write([]byte{0, 0, 0, 0, 0})
	return err
}

// probeListeningPID returns the OS PID of the process listening on addr
// (host:port). Tries `ss` first, then `fuser` as a fallback. Returns 0 if
// the PID cannot be determined (tools unavailable, permission denied, etc.).
func probeListeningPID(addr string) int {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	// ss output for a matching socket looks like:
	//   LISTEN 0 128 127.0.0.1:10020 0.0.0.0:* users:(("wrapper-rootle",pid=12345,fd=7))
	if out, err := exec.Command("ss", "-tlnpH", "sport", "=", ":"+portStr).Output(); err == nil {
		if pid := parsePIDToken(string(out), "pid="); pid > 0 {
			return pid
		}
	}
	// fuser prints PIDs directly: "10020/tcp: 12345"
	if out, err := exec.Command("fuser", portStr+"/tcp").Output(); err == nil {
		for _, tok := range strings.Fields(string(out)) {
			if pid, e := strconv.Atoi(tok); e == nil && pid > 0 {
				return pid
			}
		}
	}
	return 0
}

// parsePIDToken finds the first decimal run after prefix in s.
func parsePIDToken(s, prefix string) int {
	i := strings.Index(s, prefix)
	if i < 0 {
		return 0
	}
	rest := s[i+len(prefix):]
	end := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' })
	if end < 0 {
		end = len(rest)
	}
	pid, _ := strconv.Atoi(rest[:end])
	return pid
}
