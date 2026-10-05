package export

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// FuzzRenderTemplateContainment: catalog metadata must never move the default
// template's output outside the export directory.
func FuzzRenderTemplateContainment(f *testing.F) {
	f.Add("Title", "Artist", "Album", 3)
	f.Add("..", "..", "..", 1)
	f.Add("a/../../b", "x", "y", 0)
	f.Fuzz(func(t *testing.T, title, artist, album string, track int) {
		rel := renderTemplate("", templateVar{Title: title, Artist: artist, Album: album, TrackNumber: track, Ext: "m4a"})
		out := filepath.Join("/export", rel)
		if out != "/export" && !strings.HasPrefix(out, "/export/") {
			t.Fatalf("escaped export dir: rel=%q out=%q", rel, out)
		}
	})
}

func TestValidToolPath(t *testing.T) {
	for p, want := range map[string]bool{
		"": true, "ffmpeg": true, "/usr/bin/ffmpeg": true, "/opt/ffmpeg-7/bin/ffmpeg": true,
		"/usr/local/bin/ffmpeg-7.1": true, "/bin/sh": false, "/usr/bin/python3": false,
		"/tmp/ffmpegx": false, "/usr/bin/ffmpeg/../sh": false,
		"/tmp/ffmpeg.m4a": false, "bin/ffmpeg": false, "../ffmpeg": false, "ffmpeg\x00": false,
	} {
		if got := validToolPath(p, "ffmpeg"); got != want {
			t.Errorf("validToolPath(%q) = %v, want %v", p, got, want)
		}
	}
	if !validToolPath("/usr/bin/cvlc", "vlc", "cvlc") || validToolPath("/usr/bin/bash", "vlc", "cvlc") {
		t.Error("vlc names")
	}
}

func TestCheckToolExecutable(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil { // WriteFile is subject to the umask
			t.Fatal(err)
		}
		return p
	}

	if err := checkToolExecutable(write("ffmpeg", 0o755), "ffmpeg"); err != nil {
		t.Errorf("an ordinary executable ffmpeg was refused: %v", err)
	}
	if err := checkToolExecutable("ffmpeg", "ffmpeg"); err != nil {
		t.Errorf("a bare name is left to PATH: %v", err)
	}
	if err := checkToolExecutable(write("ffmpeg-plain", 0o644), "ffmpeg"); err == nil {
		t.Error("a non-executable file was accepted")
	}
	if err := checkToolExecutable(write("ffmpeg-open", 0o757), "ffmpeg"); err == nil {
		t.Error("a world-writable file was accepted")
	}
	if err := checkToolExecutable(filepath.Join(dir, "ffmpeg-missing"), "ffmpeg"); err == nil {
		t.Error("a missing file was accepted")
	}
	link := filepath.Join(dir, "ffmpeg-link")
	if err := os.Symlink("/bin/sh", link); err != nil {
		t.Fatal(err)
	}
	if err := checkToolExecutable(link, "ffmpeg"); err == nil {
		t.Error("a symlink named ffmpeg that resolves to /bin/sh was accepted")
	}

	open := filepath.Join(dir, "open")
	if err := os.Mkdir(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(open, "ffmpeg")
	if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkToolExecutable(p, "ffmpeg"); err == nil {
		t.Error("an executable in a world-writable directory was accepted")
	}
}
