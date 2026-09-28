package lyrics

import "testing"

func TestConvertersRejectMalformedTTML(t *testing.T) {
	for _, in := range []string{"<x/>", "<tt/>", `<tt itunes:timing="Word"/>`} {
		if _, err := TtmlToLrc(in); err == nil {
			t.Errorf("TtmlToLrc(%q): want error", in)
		}
		if _, err := TtmlToVtt(in); err == nil {
			t.Errorf("TtmlToVtt(%q): want error", in)
		}
	}
}

func TestParseLRCBeginTimeFractions(t *testing.T) {
	for in, want := range map[string][3]int{
		"12.5":         {0, 12, 50},
		"1.05":         {0, 1, 5},
		"9.527":        {0, 9, 52},
		"1:02.3":       {1, 2, 30},
		"01:02:03.450": {62, 3, 45},
		"7s":           {0, 7, 0},
	} {
		m, s, cs, err := parseLRCBeginTime(in)
		if err != nil || [3]int{m, s, cs} != want {
			t.Errorf("parseLRCBeginTime(%q) = %d:%d.%d, %v; want %v", in, m, s, cs, err, want)
		}
	}
	if _, _, _, err := parseLRCBeginTime("abc"); err == nil {
		t.Error("want error for non-numeric time")
	}
}

func TestSyllableConverterSkipsComments(t *testing.T) {
	ttml := `<tt itunes:timing="Word"><body><div><p><!-- note --><span begin="1.5" end="2">Hi</span></p></div></body></tt>`
	out, err := TtmlToLrc(ttml)
	if err != nil || out == "" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if want := "[00:01.50]<00:01.50>Hi<00:02.00>"; out != want {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestParseTtmlMs(t *testing.T) {
	for in, want := range map[string]int{
		"12.5": 12500, "01:05.5": 65500, "1:02:03.450": 3723450, "9.527": 9527, "42": 42000, "3.25s": 3250,
	} {
		if got := parseTtmlMs(in); got != want {
			t.Errorf("parseTtmlMs(%q) = %d, want %d", in, got, want)
		}
	}
}
