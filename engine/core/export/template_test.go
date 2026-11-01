package export

import (
	"strings"
	"testing"
)

func TestRenderTemplate_AppendsExtWhenTitleContainsDot(t *testing.T) {
	for _, title := range []string{"Mr. Brightside", "St. Elmo's Fire", "Hello (feat. Adele)", "A.B.C."} {
		got := renderTemplate("{title}", templateVar{Title: title, Ext: "m4a"})
		if !strings.HasSuffix(got, ".m4a") {
			t.Errorf("title %q rendered %q: missing .m4a extension", title, got)
		}
	}
	// An explicit {ext} in the template must not be doubled.
	if got := renderTemplate("{title}.{ext}", templateVar{Title: "Song", Ext: "m4a"}); got != "Song.m4a" {
		t.Errorf("got %q, want Song.m4a", got)
	}
}

func TestWindowsSafeName(t *testing.T) {
	for in, want := range map[string]string{
		"Song":           "Song",
		"Song...":        "Song",
		"Song. ":         "Song",
		"CON":            "_CON",
		"nul.txt":        "_nul.txt",
		"Com1":           "_Com1",
		"LPT9.m4a":       "_LPT9.m4a",
		"COM0":           "COM0",
		"Console":        "Console",
		"Mr. Brightside": "Mr. Brightside",
		"...":            "...",
	} {
		if got := windowsSafeName(in); got != want {
			t.Errorf("windowsSafeName(%q) = %q, want %q", in, got, want)
		}
	}
}
