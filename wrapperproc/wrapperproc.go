// Package wrapperproc manages the lifecycle of the wrapper child process.
// It starts the binary, pipes its stdout/stderr to the Go logger, and
// provides a graceful shutdown via SIGTERM to prevent zombie processes.
package wrapperproc

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
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

	cmd := exec.Command(binaryPath, "-H", "127.0.0.1")

	// Ensure the wrapper process is in its own process group so that
	// SIGTERM does not accidentally propagate to the parent (Wails) process.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// Pipe stdout → logger
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
