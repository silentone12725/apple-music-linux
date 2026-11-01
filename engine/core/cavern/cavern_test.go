package cavern

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type bytesSource struct {
	data []byte
	err  error
}

func (s bytesSource) Stream(_ context.Context, w io.Writer) error {
	if _, err := w.Write(s.data); err != nil {
		return err
	}
	return s.err
}

func chunk(b []byte) []byte {
	out := binary.LittleEndian.AppendUint32(nil, uint32(len(b)))
	return append(out, b...)
}

var eos = []byte{0xff, 0xff, 0xff, 0xff}

func TestStreamingWAVHeader(t *testing.T) {
	var buf bytes.Buffer
	if err := writeStreamingWAVHeader(&buf); err != nil {
		t.Fatal(err)
	}
	h := buf.Bytes()
	le := binary.LittleEndian
	if len(h) != 44 || string(h[0:4]) != "RIFF" || string(h[8:12]) != "WAVE" || string(h[36:40]) != "data" {
		t.Fatalf("not a RIFF/WAVE header: %q", h)
	}
	if le.Uint16(h[20:22]) != 3 || le.Uint16(h[22:24]) != 2 || le.Uint32(h[24:28]) != 48000 || le.Uint16(h[34:36]) != 32 {
		t.Fatal("header must describe 48 kHz stereo float32")
	}
	if le.Uint32(h[28:32]) != 48000*2*4 || le.Uint16(h[32:34]) != 8 {
		t.Fatal("byte rate / block align inconsistent with the format")
	}
	if le.Uint32(h[4:8]) != 0xFFFFFFFF || le.Uint32(h[40:44]) != 0xFFFFFFFF {
		t.Fatal("sizes must be open-ended for a live stream")
	}
}

func TestReadSocketCopiesChunksUntilEOS(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	go func() {
		server.Write(append(append(chunk([]byte("abc")), chunk([]byte("defg"))...), eos...))
		server.Close()
	}()
	var out bytes.Buffer
	if err := readSocket(context.Background(), client, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "abcdefg" {
		t.Fatalf("output %q", out.String())
	}
}

func TestReadSocketErrors(t *testing.T) {
	for name, wire := range map[string][]byte{
		"truncated length": {0x01, 0x00},
		"truncated data":   append(binary.LittleEndian.AppendUint32(nil, 10), 'x'),
		"oversized chunk":  binary.LittleEndian.AppendUint32(nil, maxChunk+1),
	} {
		client, server := net.Pipe()
		go func() { server.Write(wire); server.Close() }()
		err := readSocket(context.Background(), client, io.Discard)
		client.Close()
		if err == nil {
			t.Errorf("%s: want an error", name)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client, _ := net.Pipe()
	defer client.Close()
	if err := readSocket(ctx, client, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled context: got %v", err)
	}
}

func TestFeedSocketFramesInputAndEndsWithEOF(t *testing.T) {
	client, server := net.Pipe()
	payload := bytes.Repeat([]byte{7}, 10000) // more than one 4 KiB read
	done := make(chan error, 1)
	go func() {
		done <- feedSocket(context.Background(), client, bytesSource{data: payload})
		client.Close()
	}()
	raw, _ := io.ReadAll(server)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var got []byte
	for {
		n := int32(binary.LittleEndian.Uint32(raw[:4]))
		raw = raw[4:]
		if n < 0 {
			break
		}
		got = append(got, raw[:n]...)
		raw = raw[n:]
	}
	if !bytes.Equal(got, payload) || len(raw) != 0 {
		t.Fatalf("framed %d bytes (%d trailing), want %d", len(got), len(raw), len(payload))
	}
}

func TestFeedSocketReportsSourceError(t *testing.T) {
	client, server := net.Pipe()
	go io.Copy(io.Discard, server)
	boom := errors.New("cdn failed")
	if err := feedSocket(context.Background(), client, bytesSource{data: []byte("x"), err: boom}); !errors.Is(err, boom) {
		t.Fatalf("got %v, want the source error", err)
	}
	client.Close()
}

func TestEnsureHRTFEnablesHeadphoneVirtualizer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows
	path := filepath.Join(home, saveDatDir, saveDatFile)

	if err := EnsureHRTF(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != minimalSaveDat {
		t.Fatalf("absent Save.dat must be created, got %q", b)
	}

	os.WriteFile(path, []byte("2\n0\nFalse\n"), 0o644)
	if err := EnsureHRTF(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != minimalSaveDat {
		t.Fatal("a Save.dat with the virtualizer off must be rewritten")
	}

	custom := "6\n1\n2\nTrue\n"
	os.WriteFile(path, []byte(custom), 0o644)
	if err := EnsureHRTF(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != custom {
		t.Fatal("a user's Save.dat with the virtualizer on must be left alone")
	}
}

func TestCavernBinaryAndStreamWithoutServer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Cavern is Unix-only")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ADAM_CAVERN", "/opt/cavern/CavernPipeServer")
	if !IsAvailable() || cavernBinary() != "/opt/cavern/CavernPipeServer" {
		t.Fatal("$ADAM_CAVERN must take precedence")
	}
	t.Setenv("ADAM_CAVERN", "")
	t.Setenv("PATH", t.TempDir())
	if IsAvailable() {
		t.Fatal("no binary on PATH must report unavailable")
	}
	err := NewCavernSource(bytesSource{}).Stream(context.Background(), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("got %v, want a not-found error", err)
	}
}
