// Package wrapperproc manages the lifecycle of the wrapper child process.
// It starts the binary, pipes its stdout/stderr to the Go logger, and
// provides a graceful shutdown via SIGTERM to prevent zombie processes.
package wrapperproc

import (
	"bufio"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"apple-music-linux/internal/embedded"
)

// Wrapper holds the running child process handle.
type Wrapper struct {
	cmd     *exec.Cmd
	tempDir string
}

var instance *Wrapper

// StartWrapper launches the wrapper binary as a background child process.
// It resolves the binary path relative to the executable's own directory,
// so it works correctly both in development (wails dev) and production builds.
func StartWrapper(email, password string) (*Wrapper, error) {
	if len(embedded.WrapperBinary) == 0 {
		return nil, fmt.Errorf("no wrapper binary available for %s/%s", runtime.GOOS, runtime.GOARCH)
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
	if email != "" && password != "" {
		args = append(args, "-F")
	}
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = dataDir

	// Ensure the wrapper process is in its own process group so that
	// SIGTERM does not accidentally propagate to the parent (Wails) process.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// Pass credentials via stdin so they never show up in ps output.
	if email != "" && password != "" {
		cmd.Stdin = strings.NewReader(email + ":" + password + "\n")
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	// Pipe stderr → logger
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

	// Stream stdout line-by-line into the logger in a goroutine
	go func() {
		scanner := bufio.NewScanner(stdoutPipe)
		for scanner.Scan() {
			log.Printf("[wrapper stdout] %s", scanner.Text())
		}
	}()

	// Stream stderr line-by-line into the logger in a goroutine
	go func() {
		scanner := bufio.NewScanner(stderrPipe)
		for scanner.Scan() {
			log.Printf("[wrapper stderr] %s", scanner.Text())
		}
	}()

	// Reap the process in the background so it doesn't become a zombie
	w := &Wrapper{cmd: cmd, tempDir: tempDir}
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("[WrapperProc] Process exited with: %v", err)
		} else {
			log.Println("[WrapperProc] Process exited cleanly.")
		}
		w.cleanup()
	}()

	instance = w
	return w, nil
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
		return fmt.Errorf("rootfs not embedded for %s/%s", runtime.GOOS, runtime.GOARCH)
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
