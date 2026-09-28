package export

import (
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
	} {
		if got := validToolPath(p, "ffmpeg"); got != want {
			t.Errorf("validToolPath(%q) = %v, want %v", p, got, want)
		}
	}
	if !validToolPath("/usr/bin/cvlc", "vlc", "cvlc") || validToolPath("/usr/bin/bash", "vlc", "cvlc") {
		t.Error("vlc names")
	}
}
