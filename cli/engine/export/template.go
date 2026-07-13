package export

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// templateVar holds the values available for substitution in a FilenameTemplate.
type templateVar struct {
	Title       string
	Artist      string
	AlbumArtist string
	Album       string
	TrackNumber int
	DiscNumber  int
	Year        int
	Genre       string
	Codec       string // "alac" | "aac" | "atmos" | "mv"
	Ext         string // "m4a" | "flac" | "mp4" — without leading dot
}

// yearFromDate parses the year from an Apple Music ReleaseDate string
// ("YYYY-MM-DD" or "YYYY").  Returns 0 if unparseable.
func yearFromDate(s string) int {
	if len(s) >= 4 {
		y, err := strconv.Atoi(s[:4])
		if err == nil {
			return y
		}
	}
	return 0
}

// reVar matches {variable} or {variable:format} in a template.
var reVar = regexp.MustCompile(`\{([^}:]+)(?::([^}]+))?\}`)

// renderTemplate substitutes variables in t and returns a path relative to
// OutputDir.  The extension is appended automatically from v.Ext.
// The result is cleaned (filepath.Clean) and has forbidden characters replaced.
func renderTemplate(t FilenameTemplate, v templateVar) string {
	if t == "" {
		t = "{album_artist}/{album}/{track_number:02d} - {title}"
	}
	s := string(t)

	s = reVar.ReplaceAllStringFunc(s, func(m string) string {
		parts := reVar.FindStringSubmatch(m)
		name := parts[1]
		format := parts[2] // may be empty

		var value string
		switch strings.ToLower(name) {
		case "title", "song":
			value = v.Title
		case "artist":
			value = v.Artist
		case "album_artist":
			if v.AlbumArtist != "" {
				value = v.AlbumArtist
			} else {
				value = v.Artist
			}
		case "album":
			value = v.Album
		case "track_number", "track":
			if format != "" {
				value = fmt.Sprintf("%"+format, v.TrackNumber)
			} else {
				value = strconv.Itoa(v.TrackNumber)
			}
		case "disc_number", "disc":
			if format != "" {
				value = fmt.Sprintf("%"+format, v.DiscNumber)
			} else {
				value = strconv.Itoa(v.DiscNumber)
			}
		case "year":
			if v.Year > 0 {
				value = strconv.Itoa(v.Year)
			}
		case "genre":
			value = v.Genre
		case "codec":
			value = v.Codec
		case "ext":
			value = v.Ext
		default:
			return m // unknown variable — leave as-is
		}
		return sanitizePathComponent(value)
	})

	// Remove any {ext} that was already substituted; we always append ext.
	path := filepath.Clean(s)
	if filepath.Ext(path) == "" {
		path = path + "." + v.Ext
	}
	return path
}

// sanitizePathComponent replaces characters that are forbidden in file or
// directory names on common operating systems.  It does not strip path
// separators since the template may produce subdirectory components.
func sanitizePathComponent(s string) string {
	// Replace control characters and OS-forbidden chars.
	forbidden := strings.NewReplacer(
		":", "꞉", // unicode colon look-alike (U+A789)
		"/", "⁄", // unicode fraction slash (U+2044) — inside a component
		"\\", "⧵", // unicode reverse solidus (U+29F5)
		"?", "？",
		"*", "＊",
		"\"", "＂",
		"<", "＜",
		">", "＞",
		"|", "｜",
	)
	s = forbidden.Replace(s)
	// Strip leading/trailing whitespace per component.
	return strings.TrimFunc(s, unicode.IsSpace)
}

// defaultOutputDir returns a sensible default output directory under the user's
// Music folder or home directory if Music is not available.
func defaultOutputDir() string {
	// Try $XDG_MUSIC_DIR, ~/Music, home directory in that order.
	if xdg := xdgMusicDir(); xdg != "" {
		return xdg
	}
	return filepath.Join(homeDir(), "Music")
}

func xdgMusicDir() string {
	return "" // populated by platform-specific init or env var; stub for now
}

func homeDir() string {
	h, err := userHomeDir()
	if err != nil {
		return "/tmp"
	}
	return h
}

// overwritePath returns the final path applying the OverwritePolicy.
// "skip" → (path, true=exists — caller should skip)
// "overwrite" → (path, false)
// "rename" → (path-N.ext, false)
func overwritePath(path, policy string) (finalPath string, skip bool) {
	exists := fileExists(path)
	if !exists {
		return path, false
	}
	switch policy {
	case "overwrite":
		return path, false
	case "rename":
		ext := filepath.Ext(path)
		base := strings.TrimSuffix(path, ext)
		for i := 1; ; i++ {
			candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
			if !fileExists(candidate) {
				return candidate, false
			}
		}
	default: // "skip" or empty
		return path, true
	}
}

// formatSize returns a human-readable byte size string.
func formatSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for n := n / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// formatDuration returns "H:MM:SS" or "M:SS".
func formatDuration(ms int) string {
	d := time.Duration(ms) * time.Millisecond
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}
