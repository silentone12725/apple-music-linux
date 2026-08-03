// Package cavern integrates CavernPipeServer for lossless Dolby Atmos JOC binaural rendering.
//
// CavernPipeServer (https://github.com/VoidXH/Cavern) performs real JOC QMF object
// reconstruction from EC-3 + JOC bitstreams and outputs lossless float32 stereo PCM
// via its HeadphoneVirtualizer. This produces genuine binaural rendering of all Atmos
// objects, not just the 7.1 bed.
//
// Protocol: Unix socket at /tmp/CoreFxPipe_CavernPipe.
//   Client → server: 8-byte header + length-prefixed EC-3 chunks + EOF marker (-1).
//   Server → client: length-prefixed float32 PCM chunks + EOS marker (-1).
//   Output: raw interleaved float32 LE, 48000 Hz, 2ch — no WAV header from server.
//
// This package writes the 44-byte streaming WAV header before forwarding PCM,
// so the HTTP endpoint emits a valid audio/wav stream that VLC can play.
package cavern

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"engine/engine/pipeline"
)

const (
	socketPath  = "/tmp/CoreFxPipe_CavernPipe"
	saveDatDir  = ".config/Cavern"
	saveDatFile = "Save.dat"
)

// minimalSaveDat is the minimal valid Cavern Save.dat that enables
// HeadphoneVirtualizer with a 2-channel stereo layout. Each field is on
// its own line — the Cavern deserializer is newline-delimited.
//
// Format: channelCount + (channelCount × 3 channel fields) + 4 env fields + HV bool
// This is: 2 channels × (X°, Y°, LFE:bool) + (env x4) + HeadphoneVirtualizer
const minimalSaveDat = "2\n0\n-30\nFalse\n0\n30\nFalse\n0\n10\n7\n10\nTrue\n"

// IsAvailable reports whether CavernPipeServer is available.
// It checks $AML_CAVERN first, then PATH.
func IsAvailable() bool {
	if env := os.Getenv("AML_CAVERN"); env != "" {
		_, err := os.Stat(env)
		return err == nil
	}
	_, err := exec.LookPath("CavernPipeServer")
	return err == nil
}

// cavernBinary returns the path to the CavernPipeServer binary.
func cavernBinary() string {
	if env := os.Getenv("AML_CAVERN"); env != "" {
		return env
	}
	p, _ := exec.LookPath("CavernPipeServer")
	return p
}

// EnsureHRTF writes the minimal Save.dat if it is absent or if
// HeadphoneVirtualizer is not True in the existing file.
func EnsureHRTF() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("cavern: home dir: %w", err)
	}
	dir := filepath.Join(home, saveDatDir)
	path := filepath.Join(dir, saveDatFile)

	if raw, err := os.ReadFile(path); err == nil {
		// Check last non-empty line is "True"
		lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "True" {
			return nil // already correct
		}
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cavern: mkdir Save.dat dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(minimalSaveDat), 0o644); err != nil {
		return fmt.Errorf("cavern: write Save.dat: %w", err)
	}
	log.Printf("[cavern] HeadphoneVirtualizer enabled via %s", path)
	return nil
}

// CavernSource implements pipeline.Source. It wraps an EC-3 CBCS source,
// spawns CavernPipeServer, streams the EC-3 through the Unix socket, and writes
// the resulting float32 PCM as a streaming WAV to w.
type CavernSource struct {
	inner pipeline.Source
}

// NewCavernSource returns a CavernSource that wraps inner.
func NewCavernSource(inner pipeline.Source) *CavernSource {
	return &CavernSource{inner: inner}
}

// Stream implements pipeline.Source.
func (c *CavernSource) Stream(ctx context.Context, w io.Writer) error {
	if err := EnsureHRTF(); err != nil {
		log.Printf("[cavern] Save.dat setup failed: %v — continuing anyway", err)
	}

	bin := cavernBinary()
	if bin == "" {
		return fmt.Errorf("cavern: CavernPipeServer not found")
	}

	cmd := exec.CommandContext(ctx, bin)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cavern: start CavernPipeServer: %w", err)
	}
	defer cmd.Wait() //nolint:errcheck

	// Poll for the socket to appear (CavernPipeServer opens it asynchronously).
	var conn net.Conn
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		conn, err = net.Dial("unix", socketPath)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if conn == nil {
		return fmt.Errorf("cavern: socket %s did not appear within 5s", socketPath)
	}
	defer conn.Close()

	// Send 8-byte handshake: BitDepth=32 | mandatoryFrames=1 | OutputChannels=2 (LE uint16) | UpdateRate=1024 (LE int32)
	var hdr [8]byte
	hdr[0] = 32 // BitDepth
	hdr[1] = 1  // mandatoryFrames
	binary.LittleEndian.PutUint16(hdr[2:4], 2)    // OutputChannels
	binary.LittleEndian.PutUint32(hdr[4:8], 1024) // UpdateRate
	if _, err := conn.Write(hdr[:]); err != nil {
		return fmt.Errorf("cavern: send header: %w", err)
	}

	// Write streaming WAV header to the HTTP writer.
	if err := writeStreamingWAVHeader(w); err != nil {
		return fmt.Errorf("cavern: write WAV header: %w", err)
	}

	// goroutine: pipe inner EC-3 source to socket in length-prefixed chunks.
	innerDone := make(chan error, 1)
	go func() {
		innerDone <- feedSocket(ctx, conn, c.inner)
	}()

	// Read length-prefixed float32 PCM chunks from socket and write to w.
	if err := readSocket(ctx, conn, w); err != nil {
		return err
	}

	return <-innerDone
}

// writeStreamingWAVHeader writes a 44-byte RIFF WAV header with an open-ended
// data chunk (size = 0xFFFFFFFF) so VLC treats the stream as unbounded.
func writeStreamingWAVHeader(w io.Writer) error {
	const (
		sampleRate  = 48000
		numCh       = 2
		bitsPerSamp = 32 // float32
		audioFmt    = 3  // IEEE float
	)
	byteRate := uint32(sampleRate * numCh * bitsPerSamp / 8)
	blockAlign := uint16(numCh * bitsPerSamp / 8)

	le := binary.LittleEndian
	buf := make([]byte, 44)
	copy(buf[0:4], "RIFF")
	le.PutUint32(buf[4:8], 0xFFFFFFFF)  // file size placeholder
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	le.PutUint32(buf[16:20], 16)                   // fmt chunk size
	le.PutUint16(buf[20:22], audioFmt)              // PCM float
	le.PutUint16(buf[22:24], numCh)
	le.PutUint32(buf[24:28], sampleRate)
	le.PutUint32(buf[28:32], byteRate)
	le.PutUint16(buf[32:34], blockAlign)
	le.PutUint16(buf[34:36], bitsPerSamp)
	copy(buf[36:40], "data")
	le.PutUint32(buf[40:44], 0xFFFFFFFF) // data size placeholder

	_, err := w.Write(buf)
	return err
}

// feedSocket reads from the inner source and forwards it to the Cavern socket
// as length-prefixed chunks, ending with int32(-1) on EOF.
func feedSocket(ctx context.Context, conn net.Conn, inner pipeline.Source) error {
	pr, pw := io.Pipe()
	innerErr := make(chan error, 1)
	go func() {
		err := inner.Stream(ctx, pw)
		pw.CloseWithError(err)
		innerErr <- err
	}()

	buf := make([]byte, 4096)
	for {
		n, err := pr.Read(buf)
		if n > 0 {
			if werr := writeChunk(conn, buf[:n]); werr != nil {
				pr.CloseWithError(werr)
				return werr
			}
		}
		if err != nil {
			break
		}
	}

	// Send EOF sentinel.
	var sentinel [4]byte
	binary.LittleEndian.PutUint32(sentinel[:], 0xFFFFFFFF) // -1 as uint32
	conn.Write(sentinel[:])                                 //nolint:errcheck

	if ie := <-innerErr; ie != nil && ie != io.EOF {
		return ie
	}
	return nil
}

// writeChunk sends [int32LE length][bytes] to conn.
func writeChunk(conn net.Conn, data []byte) error {
	var lenbuf [4]byte
	binary.LittleEndian.PutUint32(lenbuf[:], uint32(len(data)))
	if _, err := conn.Write(lenbuf[:]); err != nil {
		return err
	}
	_, err := conn.Write(data)
	return err
}

// readSocket reads length-prefixed float32 PCM chunks from conn and writes
// raw bytes to w. Returns when the EOS sentinel (-1) is received.
func readSocket(ctx context.Context, conn net.Conn, w io.Writer) error {
	var lenbuf [4]byte
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if _, err := io.ReadFull(conn, lenbuf[:]); err != nil {
			return fmt.Errorf("cavern: read chunk length: %w", err)
		}
		length := int32(binary.LittleEndian.Uint32(lenbuf[:]))
		if length < 0 {
			return nil // EOS
		}
		data := make([]byte, int(length))
		if _, err := io.ReadFull(conn, data); err != nil {
			return fmt.Errorf("cavern: read chunk data: %w", err)
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
}
