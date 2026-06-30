// Package wrapperproc manages the lifecycle of the wrapper child process.
// The wrapper binary takes its Apple ID login as a `-L user:pass` startup
// flag (it does not read credentials from stdin), so logging in means
// relaunching it with that flag. This package starts the binary, buffers
// its combined stdout/stderr for display in the app's Settings terminal,
// and provides a graceful shutdown via SIGTERM.
package wrapperproc

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"syscall"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"apple-music-linux/internal/embedded"
)

// LogEvent is the Wails event name used to stream wrapper output live to the frontend.
const LogEvent = "wrapper:log"

const maxLogLines = 1000

// Wrapper holds the running child process handle.
type Wrapper struct {
	ctx     context.Context
	cmd     *exec.Cmd
	tempDir string

	mu   sync.Mutex
	logs []string
}

// StartWrapper launches the wrapper binary as a background child process.
// login, if non-empty, is passed as "-L <login>" (format "email:password")
// so the wrapper authenticates with Apple on startup; if empty, the wrapper
// falls back to any session already persisted in its local account database.
func StartWrapper(ctx context.Context, login string) (*Wrapper, error) {
	if len(embedded.WrapperBinary) == 0 {
		return nil, fmt.Errorf("no wrapper binary available for %s/%s", goruntime.GOOS, goruntime.GOARCH)
	}

	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("failed to resolve user config dir: %w", err)
	}
	dataDir := filepath.Join(configDir, "apple-music-linux", "wrapper-data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create wrapper data dir: %w", err)
	}
	if err := os.Chmod(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to secure wrapper data dir: %w", err)
	}
	if err := ensureRootFS(dataDir); err != nil {
		return nil, err
	}

	tempDir, err := os.MkdirTemp("", "aml-wrapper-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	if err := os.Chmod(tempDir, 0700); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to secure temp dir: %w", err)
	}

	binaryPath := filepath.Join(tempDir, "wrapper")
	if err := os.WriteFile(binaryPath, embedded.WrapperBinary, 0700); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to extract wrapper binary: %w", err)
	}

	log.Printf("[WrapperProc] Extracted wrapper to: %s", binaryPath)

	args := []string{"-H", "127.0.0.1"}
	if login != "" {
		args = append(args, "-L", login)
	}
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = dataDir

	// Ensure the wrapper process is in its own process group so that
	// SIGTERM does not accidentally propagate to the parent (Wails) process.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	log.Printf("[WrapperProc] Started with PID %d", cmd.Process.Pid)

	w := &Wrapper{ctx: ctx, cmd: cmd, tempDir: tempDir}

	go w.streamLog("[wrapper stdout]", stdoutPipe)
	go w.streamLog("[wrapper stderr]", stderrPipe)

	// Reap the process in the background so it doesn't become a zombie.
	go func() {
		if err := cmd.Wait(); err != nil {
			w.appendLog(fmt.Sprintf("[WrapperProc] Process exited with: %v", err))
		} else {
			w.appendLog("[WrapperProc] Process exited cleanly.")
		}
		w.cleanup()
	}()

	return w, nil
}

// Logs returns a snapshot of the buffered wrapper output, oldest first.
func (w *Wrapper) Logs() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, len(w.logs))
	copy(out, w.logs)
	return out
}

// Stop sends SIGTERM to the wrapper process for a graceful shutdown.
// Falls back to SIGKILL if the process does not terminate within a
// reasonable time (the OS will handle this automatically after SIGTERM).
func (w *Wrapper) Stop() {
	if w.cmd == nil || w.cmd.Process == nil {
		return
	}
	log.Println("[WrapperProc] Sending SIGTERM to wrapper process...")
	if err := w.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		log.Printf("[WrapperProc] SIGTERM failed (%v), sending SIGKILL...", err)
		_ = w.cmd.Process.Signal(syscall.SIGKILL)
	}
	w.cleanup()
}

func (w *Wrapper) streamLog(prefix string, r io.ReadCloser) {
	defer r.Close()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		w.appendLog(fmt.Sprintf("%s %s", prefix, scanner.Text()))
	}
}

func (w *Wrapper) appendLog(line string) {
	log.Print(line)

	w.mu.Lock()
	w.logs = append(w.logs, line)
	if len(w.logs) > maxLogLines {
		w.logs = w.logs[len(w.logs)-maxLogLines:]
	}
	w.mu.Unlock()

	if w.ctx != nil {
		runtime.EventsEmit(w.ctx, LogEvent, line)
	}
}

func (w *Wrapper) cleanup() {
	if w.tempDir == "" {
		return
	}
	log.Printf("[WrapperProc] Cleaning up temp dir: %s", w.tempDir)
	_ = os.RemoveAll(w.tempDir)
	w.tempDir = ""
}

func ensureRootFS(dataDir string) error {
	if embedded.RootFSPrefix == "" {
		return fmt.Errorf("rootfs not embedded for %s/%s", goruntime.GOOS, goruntime.GOARCH)
	}

	destRoot := filepath.Join(dataDir, "rootfs")
	mainPath := filepath.Join(destRoot, "system", "bin", "main")
	if _, err := os.Stat(mainPath); err == nil {
		return nil
	}

	if err := fs.WalkDir(embedded.RootFS, embedded.RootFSPrefix, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(embedded.RootFSPrefix, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(destRoot, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := fs.ReadFile(embedded.RootFS, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0644); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return fmt.Errorf("failed to extract rootfs: %w", err)
	}

	baseDir := filepath.Join(destRoot, "data", "data", "com.apple.android.music", "files")
	if err := os.MkdirAll(baseDir, 0777); err != nil {
		return fmt.Errorf("failed to create base dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(baseDir, "mpl_db"), 0777); err != nil {
		return fmt.Errorf("failed to create mpl_db dir: %w", err)
	}

	_ = os.Chmod(filepath.Join(destRoot, "system", "bin", "linker64"), 0755)
	_ = os.Chmod(filepath.Join(destRoot, "system", "bin", "main"), 0755)

	return nil
}
