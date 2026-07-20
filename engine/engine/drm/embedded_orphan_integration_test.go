//go:build integration && linux

// Regression test for EmbeddedBackend's process-group teardown.
//
// EmbeddedBackend forks a container child (drm_embed.c: child_main) which
// itself forks again (into a new PID namespace) and execve's the grandchild
// into /system/bin/main — the actual DRM worker. Go only tracks the
// intermediate child's PID.
//
// Note on rigor: unlike the analogous ProcessBackend orphan bug (where a
// single-PID kill reliably orphaned the worker), repeated controlled trials
// here (2026-07-08) found the worker IS reliably reaped even without the
// change below — drm_embed.c's existing PR_SET_PDEATHSIG call already covers
// this path for /system/bin/main as currently built. This test locks in the
// "Stop() leaves nothing behind" invariant either way; it does not by itself
// prove a regression fix, since old code passes it too. The defense-in-depth
// change (child_main() calls setpgid(0,0) before its inner fork, so the
// worker inherits the SAME process group, and EmbeddedBackend.Stop() now
// kills the whole group with -pid) makes the guarantee explicit and
// independent of PR_SET_PDEATHSIG's exec semantics, which are conditional on
// the worker binary's privilege attributes (see drm_embed.c for detail).
//
// Unlike the ProcessBackend test (which uses a lightweight mock binary), this
// exercises the REAL container path — building a synthetic chroot + user/PID
// namespace harness would be disproportionate to what a mock buys here. It
// requires a real wrapper-rootless binary + rootfs + an existing Apple session
// (mpl_db), so it is skipped when those aren't present (e.g. CI without the
// Git-LFS rootfs checked out).
//
//	go test -tags integration -run TestEmbeddedBackend_StopReapsWorker -v ./engine/drm/
package drm_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"main/engine/drm"
)

func TestEmbeddedBackend_StopReapsWorker(t *testing.T) {
	wrapperBin := findWrapperBinary(t)
	baseDir := findSessionBaseDir(t, wrapperBin)

	const accountAddr = "127.0.0.1:39021" // distinct from the ProcessBackend test's port
	backend := drm.NewEmbeddedBackend(drm.EmbedConfig{
		WrapperDir:     filepath.Dir(wrapperBin),
		OmitBaseDir:    true,
		DecryptAddr:    "127.0.0.1:19021",
		M3U8Addr:       "127.0.0.1:29021",
		AccountAddr:    accountAddr,
		SuppressOutput: true,
	})
	mgr := drm.NewDRMManager(
		backend,
		drm.NewSessionManager(baseDir),
		func(drm.DRMSnapshot) {},
		drm.BackendConfig{BaseDir: baseDir},
		drm.RestartPolicy{StartupTimeout: 30 * time.Second, AuthTimeout: 30 * time.Second},
	)
	defer mgr.Shutdown()

	// GetAccount triggers the container launch but dials the account port once;
	// the container takes 10-20s (namespace + chroot + execve) to bind it, so
	// the first several attempts race the launch and return "connection
	// refused" — the same readiness race fixed for qacompare's cold-start
	// benchmark. Retry until the port answers or the deadline passes.
	deadline := time.Now().Add(30 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, lastErr = mgr.GetAccount(ctx)
		cancel()
		if lastErr == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !waitPort(accountAddr, true, 5*time.Second) {
		t.Skipf("EmbeddedBackend account port never came up (needs a real logged-in session): %v", lastErr)
	}

	// The account HTTP server runs inside the execve'd grandchild ("main"),
	// not the intermediate waiter — so pidOnPort finds the worker directly.
	// This is exactly the process the orphan bug left running (reparented to
	// init) when only the waiter was killed.
	workerPID := pidOnPort(accountAddr)
	if workerPID == 0 {
		t.Fatal("could not determine EmbeddedBackend worker PID from account port")
	}
	waiterPID := parentOf(workerPID)
	t.Logf("worker pid=%d, waiter (parent) pid=%d", workerPID, waiterPID)

	mgr.Shutdown()

	if !waitProcessGone(workerPID, 5*time.Second) {
		t.Errorf("worker pid %d still running after Shutdown — orphaned (the bug this test guards against)", workerPID)
	}
	if waiterPID != 0 && !waitProcessGone(waiterPID, 5*time.Second) {
		t.Errorf("waiter pid %d still running after Shutdown", waiterPID)
	}
	if !waitPort(accountAddr, false, 5*time.Second) {
		t.Errorf("account port %s still bound after Shutdown", accountAddr)
	}
}

// ── helpers specific to this test (the shared waitPort/pidOnPort/
// waitProcessGone/processGoneOrZombie helpers live in orphan_integration_test.go) ──

func findWrapperBinary(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("WRAPPER_BINARY"); p != "" {
		return p
	}
	repoRoot := findRepoRoot(t)
	p := filepath.Join(repoRoot, "wrapper", "wrapper-rootless")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("wrapper binary not found at %s (set WRAPPER_BINARY or check out Git-LFS rootfs): %v", p, err)
	}
	return p
}

func findSessionBaseDir(t *testing.T, wrapperBin string) string {
	t.Helper()
	baseDir := filepath.Join(filepath.Dir(wrapperBin), "rootfs", "data", "data", "com.apple.android.music", "files")
	if _, err := os.Stat(filepath.Join(baseDir, "mpl_db", "accounts.sqlitedb")); err != nil {
		t.Skipf("no existing session at %s (this test needs a real logged-in session): %v", baseDir, err)
	}
	return baseDir
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find repo root (go.mod)")
		}
		dir = parent
	}
}

// parentOf reads pid's own PPID from /proc/<pid>/stat (0 if unavailable).
// Portable /proc parsing, no external ps/pgrep dependency.
func parentOf(pid int) int {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	s := string(data)
	r := strings.LastIndexByte(s, ')')
	if r < 0 {
		return 0
	}
	// Fields after "comm)" start at field 3 (state, index 0); PPID is field 4 (index 1).
	fields := strings.Fields(s[r+2:])
	if len(fields) < 2 {
		return 0
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0
	}
	return ppid
}
