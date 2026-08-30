//go:build integration

// Regression test for the wrapper orphan-on-shutdown bug.
//
// The real wrapper-rootless is a launcher that forks a "main" worker which holds
// the DRM ports (:10020/:20020/:30020). ProcessBackend.Stop must reap the whole
// wrapper process group, not just the direct child — otherwise the worker is
// orphaned to init and keeps the ports and the single-user session, leaking
// resources on every engine shutdown.
//
// The mock reproduces the fork topology when launched with MOCK_FORK_WORKER=1.
//
//	go test -tags integration -run StopReapsForkedWorker -v ./engine/drm/
package drm_test

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProcessBackend_StopReapsForkedWorker(t *testing.T) {
	const accountAddr = "127.0.0.1:39020"
	mgr, baseDir := newTestBackend(t, "127.0.0.1:19020", "127.0.0.1:29020", accountAddr)

	// Session-reuse path: seed a session so the mock goes straight to serve.
	seedSession(t, baseDir)
	// Make the launched mock fork a port-holding worker (inherited via env).
	t.Setenv("MOCK_FORK_WORKER", "1")

	// GetAccount triggers the wrapper launch. It may return "connection refused"
	// because it dials the account port before the forked worker binds it — that
	// race is not what this test measures, so we ignore the error and instead
	// wait for the port to come up.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, _ = mgr.GetAccount(ctx)

	// The forked worker must bind the account port.
	if !waitPort(accountAddr, true, 15*time.Second) {
		mgr.Shutdown()
		t.Fatalf("account port %s never came up — worker did not start", accountAddr)
	}
	workerPID := pidOnPort(accountAddr)
	t.Logf("worker holding %s = pid %d", accountAddr, workerPID)

	// Shut down the backend — this is the operation under test.
	mgr.Shutdown()

	// The port must be released promptly (the core regression).
	if !waitPort(accountAddr, false, 5*time.Second) {
		t.Errorf("account port %s still bound after Shutdown — forked worker orphaned", accountAddr)
	}
	// And the worker process itself must terminate. A brief zombie window is
	// allowed before init reaps it, so poll and treat zombie as terminated.
	if workerPID > 0 && !waitProcessGone(workerPID, 5*time.Second) {
		t.Errorf("worker pid %d still running after Shutdown — orphaned", workerPID)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func seedSession(t *testing.T, baseDir string) {
	t.Helper()
	dir := filepath.Join(baseDir, "mpl_db")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "accounts.sqlitedb"), []byte("MOCK_SESSION_DB"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// waitPort polls addr until its listening state matches want, or timeout.
func waitPort(addr string, want bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		up := err == nil
		if up {
			c.Close()
		}
		if up == want {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// pidOnPort returns the PID listening on addr's port via ss, or 0.
func pidOnPort(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	out, err := exec.Command("ss", "-ltnpH", "sport", "=", ":"+port).Output()
	if err != nil {
		return 0
	}
	s := string(out)
	i := strings.Index(s, "pid=")
	if i < 0 {
		return 0
	}
	rest := s[i+len("pid="):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	pid, _ := strconv.Atoi(rest[:end])
	return pid
}

// waitProcessGone polls until the process is gone or a reaped-pending zombie.
func waitProcessGone(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if processGoneOrZombie(pid) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return processGoneOrZombie(pid)
}

// processGoneOrZombie reports whether pid no longer exists or is a zombie
// (terminated, awaiting reap by init). A SIGKILLed process becomes a zombie
// until its reparented-to-init parent collects it, so zombie counts as gone.
func processGoneOrZombie(pid int) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true // no /proc entry = gone
	}
	s := string(data)
	r := strings.LastIndexByte(s, ')')
	if r < 0 || r+2 >= len(s) {
		return true
	}
	return s[r+2] == 'Z'
}
