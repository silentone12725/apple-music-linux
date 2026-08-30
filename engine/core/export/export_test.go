package export

// export_test.go — unit tests for the export package.
//
// Tests cover:
//   - Filename template rendering (all variables, format specs, edge cases)
//   - Filename sanitization (OS-forbidden characters, Unicode, long names)
//   - Overwrite policy (skip, overwrite, rename, non-existent target)
//   - yearFromDate parsing
//   - artworkURL formatting
//   - formatDuration
//
// These tests do NOT touch the filesystem (except TestOverwritePolicy which
// creates temp files), the network, or Apple Music.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── Template rendering ────────────────────────────────────────────────────────

func TestRenderTemplate_DefaultTemplate(t *testing.T) {
	t.Parallel()
	v := templateVar{
		Title: "Fearless", Artist: "Taylor Swift", AlbumArtist: "Taylor Swift",
		Album: "Fearless (Platinum Edition)", TrackNumber: 1, Ext: "m4a",
	}
	got := renderTemplate("", v)
	want := filepath.Join("Taylor Swift", "Fearless (Platinum Edition)", "01 - Fearless.m4a")
	if got != want {
		t.Errorf("default template:\n got  %q\n want %q", got, want)
	}
}

func TestRenderTemplate_AllVariables(t *testing.T) {
	t.Parallel()
	v := templateVar{
		Title: "Song", Artist: "Artist", AlbumArtist: "Album Artist",
		Album: "Album", TrackNumber: 3, DiscNumber: 2,
		Year: 2024, Genre: "Pop", Codec: "alac", Ext: "m4a",
	}
	cases := []struct {
		tmpl string
		want string
	}{
		{"{title}", "Song.m4a"},
		{"{artist}", "Artist.m4a"},
		{"{album_artist}", "Album Artist.m4a"},
		{"{album}", "Album.m4a"},
		{"{track_number}", "3.m4a"},
		{"{track_number:02d}", "03.m4a"},
		{"{disc_number}", "2.m4a"},
		{"{year}", "2024.m4a"},
		{"{genre}", "Pop.m4a"},
		{"{codec}", "alac.m4a"},
		{"{ext}", "m4a.m4a"}, // ext in body + appended ext
		{"{disc_number:02d} {track_number:02d} - {title}", "02 03 - Song.m4a"},
	}
	for _, c := range cases {
		got := renderTemplate(FilenameTemplate(c.tmpl), v)
		if got != c.want {
			t.Errorf("template %q: got %q want %q", c.tmpl, got, c.want)
		}
	}
}

func TestRenderTemplate_AlbumArtistFallback(t *testing.T) {
	t.Parallel()
	// When AlbumArtist is empty, {album_artist} falls back to Artist.
	v := templateVar{Title: "T", Artist: "A", AlbumArtist: "", Album: "AL", Ext: "m4a"}
	got := renderTemplate("{album_artist}/{album}/{title}", v)
	if !strings.HasPrefix(got, "A"+string(filepath.Separator)) {
		t.Errorf("expected artist fallback, got %q", got)
	}
}

func TestRenderTemplate_UnknownVariable(t *testing.T) {
	t.Parallel()
	// Unknown variables are left in place (no panic, no empty string).
	v := templateVar{Title: "T", Ext: "m4a"}
	got := renderTemplate("{unknown} {title}", v)
	if !strings.Contains(got, "{unknown}") {
		t.Errorf("expected unknown variable preserved, got %q", got)
	}
}

func TestRenderTemplate_ExtAlreadyPresent(t *testing.T) {
	t.Parallel()
	// If the template produces a path that already ends with the extension,
	// it should not be appended a second time.
	v := templateVar{Title: "T", Ext: "m4a"}
	got := renderTemplate("{title}.m4a", v)
	if strings.HasSuffix(got, ".m4a.m4a") {
		t.Errorf("double extension: %q", got)
	}
}

// ── Filename sanitization ─────────────────────────────────────────────────────

func TestSanitizePathComponent_ForbiddenChars(t *testing.T) {
	t.Parallel()
	cases := []struct{ in, notContains string }{
		{"a:b", ":"},
		{"a/b", "/"},
		{"a\\b", "\\"},
		{"a?b", "?"},
		{"a*b", "*"},
		{"a\"b", "\""},
		{"a<b", "<"},
		{"a>b", ">"},
		{"a|b", "|"},
	}
	for _, c := range cases {
		got := sanitizePathComponent(c.in)
		if strings.Contains(got, c.notContains) {
			t.Errorf("sanitize(%q) = %q still contains %q", c.in, got, c.notContains)
		}
		if len(got) == 0 {
			t.Errorf("sanitize(%q) returned empty string", c.in)
		}
	}
}

func TestSanitizePathComponent_SafeCharsUnchanged(t *testing.T) {
	t.Parallel()
	safe := []string{"hello world", "Taylor Swift", "Fearless", "2024", "Pop-Rock"}
	for _, s := range safe {
		got := sanitizePathComponent(s)
		if got != s {
			t.Errorf("safe string %q was modified to %q", s, got)
		}
	}
}

func TestSanitizePathComponent_Unicode(t *testing.T) {
	t.Parallel()
	// Unicode characters other than the forbidden set should pass through.
	cases := []string{
		"こんにちは",
		"Ação",
		"Rammstein – Du Hast",
		"AC⚡DC",
		"Beyoncé",
	}
	for _, s := range cases {
		got := sanitizePathComponent(s)
		if len(got) == 0 {
			t.Errorf("unicode %q sanitized to empty", s)
		}
	}
}

func TestRenderTemplate_UnicodeArtist(t *testing.T) {
	t.Parallel()
	v := templateVar{
		Title: "曲名", Artist: "アーティスト", AlbumArtist: "アーティスト",
		Album: "アルバム", TrackNumber: 1, Ext: "m4a",
	}
	got := renderTemplate("{album_artist}/{album}/{track_number:02d} - {title}", v)
	if !strings.Contains(got, "アーティスト") {
		t.Errorf("unicode artist not in output: %q", got)
	}
}

// ── Overwrite policy ──────────────────────────────────────────────────────────

func TestOverwritePolicy_NonExistent(t *testing.T) {
	t.Parallel()
	path, skip := overwritePath("/tmp/this-file-does-not-exist-am-test.m4a", "skip")
	if skip {
		t.Error("non-existent target: skip=true, want false")
	}
	if path != "/tmp/this-file-does-not-exist-am-test.m4a" {
		t.Errorf("path changed for non-existent target: %q", path)
	}
}

func TestOverwritePolicy_SkipExisting(t *testing.T) {
	t.Parallel()
	f, err := os.CreateTemp("", "am-export-test-*.m4a")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	_, skip := overwritePath(f.Name(), "skip")
	if !skip {
		t.Error("existing file with policy=skip: want skip=true")
	}
}

func TestOverwritePolicy_OverwriteExisting(t *testing.T) {
	t.Parallel()
	f, err := os.CreateTemp("", "am-export-test-*.m4a")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	path, skip := overwritePath(f.Name(), "overwrite")
	if skip {
		t.Error("policy=overwrite: want skip=false")
	}
	if path != f.Name() {
		t.Errorf("path should be unchanged: got %q want %q", path, f.Name())
	}
}

func TestOverwritePolicy_RenameExisting(t *testing.T) {
	t.Parallel()
	f, err := os.CreateTemp("", "am-export-test-*.m4a")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	path, skip := overwritePath(f.Name(), "rename")
	if skip {
		t.Error("policy=rename: want skip=false")
	}
	if path == f.Name() {
		t.Error("policy=rename: output path should differ from input")
	}
	ext := filepath.Ext(path)
	if ext != ".m4a" {
		t.Errorf("renamed path has wrong ext: %q", ext)
	}
}

// ── yearFromDate ──────────────────────────────────────────────────────────────

func TestYearFromDate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want int
	}{
		{"2024-03-14", 2024},
		{"1989-10-27", 1989},
		{"2024", 2024},
		{"", 0},
		{"invalid", 0},
		{"99-01-01", 0}, // 2-digit year
	}
	for _, c := range cases {
		got := yearFromDate(c.in)
		if got != c.want {
			t.Errorf("yearFromDate(%q) = %d want %d", c.in, got, c.want)
		}
	}
}

// ── artworkURL ────────────────────────────────────────────────────────────────

func TestArtworkURL_SubstitutesWidthAndHeight(t *testing.T) {
	t.Parallel()
	tmpl := "https://is1-ssl.mzstatic.com/image/thumb/Music1/abc/{w}x{h}bb.jpg"
	got := artworkURL(tmpl, 3000)
	want := "https://is1-ssl.mzstatic.com/image/thumb/Music1/abc/3000x3000bb.jpg"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestArtworkURL_DefaultSize(t *testing.T) {
	t.Parallel()
	tmpl := "https://cdn.example.com/{w}x{h}.jpg"
	got := artworkURL(tmpl, 0) // 0 → use default 3000
	if !strings.Contains(got, "3000") {
		t.Errorf("default size not applied: %q", got)
	}
}

// ── formatDuration ────────────────────────────────────────────────────────────

func TestFormatDuration(t *testing.T) {
	t.Parallel()
	cases := []struct {
		ms   int
		want string
	}{
		{0, "0:00"},
		{60000, "1:00"},
		{90500, "1:30"},
		{3600000, "1:00:00"},
		{3661000, "1:01:01"},
		{201569, "3:21"}, // ALAC track duration
	}
	for _, c := range cases {
		got := formatDuration(c.ms)
		if got != c.want {
			t.Errorf("formatDuration(%d) = %q want %q", c.ms, got, c.want)
		}
	}
}
