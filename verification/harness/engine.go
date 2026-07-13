// Package harness runs the Apple Music engine as an external subprocess over its
// --api HTTP endpoint and measures it the way it is actually deployed.
//
// In-process benchmarks (cmd/qacompare, cmd/parity) cannot report honest engine
// CPU/RSS/heap because the benchmark program shares the address space. This
// package instead launches `main --api <port>` as its own process, waits for a
// readiness probe, drives scenarios over HTTP, samples the child PID's /proc and
// runtime metrics, and shuts it down cleanly.
//
// Every benchmark becomes a scenario on top of this one lifecycle: Start →
// WaitReady → (drive HTTP + sample) → Stop.
package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// Options configures a subprocess engine launch.
type Options struct {
	// BinaryPath is a prebuilt engine binary. If empty, Start builds one from
	// RepoDir with `go build` and removes it on Stop.
	BinaryPath string
	// RepoDir is the working directory for the engine (must contain config.yaml).
	// Defaults to the current directory.
	RepoDir string
	// Port is the --api port. 0 picks a free port automatically.
	Port int
	// Stdout/Stderr receive the child's output. nil discards it.
	Stdout, Stderr io.Writer
	// Env overrides the child environment. nil inherits the parent's.
	Env []string
}

// Engine is a running engine subprocess.
type Engine struct {
	Port    int
	BaseURL string

	cmd     *exec.Cmd
	client  *http.Client
	tmpBin  string // non-empty when Start built the binary (removed on Stop)
	exited  chan struct{}
	waitErr error
}

// Start builds (if needed) and launches the engine, returning once the process
// is spawned. Call WaitReady before driving traffic.
func Start(ctx context.Context, opt Options) (*Engine, error) {
	repo := opt.RepoDir
	if repo == "" {
		repo = "."
	}
	absRepo, err := filepath.Abs(repo)
	if err != nil {
		return nil, fmt.Errorf("resolve repo dir: %w", err)
	}

	bin := opt.BinaryPath
	tmpBin := ""
	if bin == "" {
		built, err := buildEngine(ctx, absRepo)
		if err != nil {
			return nil, err
		}
		bin, tmpBin = built, built
	}

	port := opt.Port
	if port == 0 {
		port, err = freePort()
		if err != nil {
			return nil, fmt.Errorf("pick free port: %w", err)
		}
	}

	// Not CommandContext: we want to control shutdown (SIGTERM → graceful) rather
	// than ctx-cancel sending SIGKILL and orphaning the wrapper child.
	cmd := exec.Command(bin, "--api", strconv.Itoa(port))
	cmd.Dir = absRepo
	cmd.Stdout = opt.Stdout
	cmd.Stderr = opt.Stderr
	if opt.Env != nil {
		cmd.Env = opt.Env
	}
	// New process group so we can signal the engine and any wrapper children.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		if tmpBin != "" {
			os.Remove(tmpBin)
		}
		return nil, fmt.Errorf("start engine: %w", err)
	}

	e := &Engine{
		Port:    port,
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		cmd:     cmd,
		client:  &http.Client{Timeout: 180 * time.Second}, // full-track downloads on slow links

		tmpBin: tmpBin,
		exited: make(chan struct{}),
	}
	go func() {
		e.waitErr = cmd.Wait()
		close(e.exited)
	}()
	return e, nil
}

// WaitReady polls GET /api/v1/status until it returns 200 or the timeout/ctx
// elapses. It fails fast if the process exits during startup.
func (e *Engine) WaitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := e.URL("/api/v1/status")
	for {
		select {
		case <-e.exited:
			return fmt.Errorf("engine exited during startup: %v", e.waitErr)
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
		resp, err := e.client.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("engine not ready after %s", timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// WaitDRMReady polls GET /api/v1/drm/status until state.fairplay == "ready".
// Playback of ALAC/Atmos (CBCS) requires the wrapper's FairPlay to be
// initialised, which happens asynchronously after the HTTP server is up — so
// WaitReady (status 200) is not sufficient before a playback scenario.
func (e *Engine) WaitDRMReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := e.URL("/api/v1/drm/status")
	for {
		reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
		resp, err := e.client.Do(req)
		if err == nil {
			var body struct {
				State struct {
					FairPlay string `json:"fairplay"`
				} `json:"state"`
			}
			json.NewDecoder(resp.Body).Decode(&body)
			resp.Body.Close()
			if body.State.FairPlay == "ready" {
				cancel()
				return nil
			}
		}
		cancel()
		if time.Now().After(deadline) {
			return fmt.Errorf("FairPlay not ready after %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// PID returns the engine process ID.
func (e *Engine) PID() int { return e.cmd.Process.Pid }

// URL joins a path onto the engine base URL.
func (e *Engine) URL(path string) string { return e.BaseURL + path }

// Client returns the shared HTTP client for driving the engine.
func (e *Engine) Client() *http.Client { return e.client }

// RuntimeStats fetches the engine's self-reported runtime metrics.
func (e *Engine) RuntimeStats(ctx context.Context) (RuntimeStats, error) {
	var rs RuntimeStats
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.URL("/api/v1/debug/runtime"), nil)
	resp, err := e.client.Do(req)
	if err != nil {
		return rs, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return rs, fmt.Errorf("runtime stats: HTTP %d", resp.StatusCode)
	}
	return rs, json.NewDecoder(resp.Body).Decode(&rs)
}

// Stop sends SIGTERM (triggering the engine's graceful shutdown, which also
// stops the wrapper), waits up to timeout for exit, then SIGKILLs the group.
func (e *Engine) Stop(timeout time.Duration) error {
	if e.tmpBin != "" {
		defer os.Remove(e.tmpBin)
	}
	// Signal the whole process group (negative PID) so wrapper children die too.
	pgid := e.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	_ = e.cmd.Process.Signal(syscall.SIGTERM)

	select {
	case <-e.exited:
		return e.waitErr
	case <-time.After(timeout):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		_ = e.cmd.Process.Kill()
		<-e.exited
		return fmt.Errorf("engine did not exit within %s; killed", timeout)
	}
}

// ── internals ───────────────────────────────────────────────────────────────

func buildEngine(ctx context.Context, repoDir string) (string, error) {
	out := filepath.Join(os.TempDir(), fmt.Sprintf("am-engine-%d", time.Now().UnixNano()))
	cmd := exec.CommandContext(ctx, "go", "build", "-o", out, ".")
	cmd.Dir = repoDir
	if combined, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("go build engine: %w\n%s", err, combined)
	}
	return out, nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
