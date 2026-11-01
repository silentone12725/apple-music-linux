package export

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const sampleEncoders = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ------
 A....D aac                  AAC (Advanced Audio Coding)
 A....D flac                 FLAC (Free Lossless Audio Codec)
 A....D pcm_s16le            PCM signed 16-bit little-endian
`

func TestFFmpegVersion(t *testing.T) {
	for in, want := range map[string]string{
		"ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc": "9.0.2",
		"ffmpeg version n7.1-4-gabc123 Copyright (c) 2000-2025":                              "n7.1-4-gabc123",
		"not ffmpeg at all": "",
		"":                  "",
	} {
		if got := ffmpegVersion(in); got != want {
			t.Errorf("ffmpegVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFFmpegEncoders(t *testing.T) {
	got := ffmpegEncoders(sampleEncoders)
	if !got["aac"] || !got["flac"] || got["libx264"] {
		t.Errorf("minimal build: %v, want aac and flac without libx264", got)
	}
	got = ffmpegEncoders(sampleEncoders + " V....D libx264              libx264 H.264 / AVC\n")
	if !got["libx264"] {
		t.Errorf("libx264 line not recognised: %v", got)
	}
	// The legend above the separator must not be read as encoders.
	if got := ffmpegEncoders(" A..... = Audio\n V..... = Video\n"); got["aac"] || got["flac"] || got["libx264"] {
		t.Errorf("no listing should find no encoders: %v", got)
	}
}

// fakeFFmpeg writes a script called ffmpeg into a temp dir and returns its path.
func fakeFFmpeg(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ffmpeg is a shell script")
	}
	p := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestProbeFFmpegRunsTheBinary(t *testing.T) {
	p := fakeFFmpeg(t, `case "$2" in
-version) echo "ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers" ;;
-encoders) cat <<'EOF'
`+sampleEncoders+`EOF
;;
esac
`)
	info := ProbeFFmpeg(context.Background(), p)
	if !info.Available || info.Version != "9.0.2" || info.Error != "" {
		t.Fatalf("working binary: %+v", info)
	}
	if !info.Encoders["aac"] || !info.Encoders["flac"] || info.Encoders["libx264"] {
		t.Errorf("encoders: %v", info.Encoders)
	}
}

func TestProbeFFmpegReportsABrokenBinary(t *testing.T) {
	info := ProbeFFmpeg(context.Background(), fakeFFmpeg(t, "echo 'error while loading shared libraries' >&2\nexit 127\n"))
	if info.Available || !strings.Contains(info.Error, "would not run") {
		t.Fatalf("a binary that fails to run must not count as available: %+v", info)
	}
	info = ProbeFFmpeg(context.Background(), fakeFFmpeg(t, "echo 'some other tool'\n"))
	if info.Available || !strings.Contains(info.Error, "did not identify itself") {
		t.Fatalf("a binary that is not ffmpeg must not count as available: %+v", info)
	}
}

func TestProbeFFmpegRefusesWhatExportsRefuse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix absolute paths")
	}
	if info := ProbeFFmpeg(context.Background(), "/nonexistent/dir/ffmpeg"); info.Error != "not found" {
		t.Errorf("a missing custom path should read as plain 'not found', got %q", info.Error)
	}
	for _, p := range []string{"/bin/ls", "/usr/bin/../bin/ffmpeg", "bin/ffmpeg", "/nonexistent/dir/ffmpeg"} {
		if info := ProbeFFmpeg(context.Background(), p); info.Available || info.Error == "" {
			t.Errorf("%q: %+v, want unavailable with a reason", p, info)
		}
	}
}
