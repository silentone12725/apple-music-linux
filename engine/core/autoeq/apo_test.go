package autoeq

import (
	"math"
	"testing"
)

// ExportAPO and parseAPO are the two halves of EqualizerAPO text import/export; what one
// writes the other must read back (disabled bands are exported as OFF and not imported).
func TestAPORoundTrip(t *testing.T) {
	in := &Settings{Preamp: -3.5, Bands: []Band{
		{Type: "PK", Freq: 1000, Gain: 2.5, Q: 1.41, Enabled: true},
		{Type: "LSC", Freq: 105, Gain: -4, Q: 0.7, Enabled: true},
		{Type: "HSC", Freq: 8000, Gain: 1.5, Q: 0.7, Enabled: false},
		{Type: "PK", Freq: 250, Gain: -1.2, Q: 2, Enabled: true},
	}}
	out, err := parseAPO(ExportAPO(in))
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(out.Preamp-in.Preamp) > 0.05 {
		t.Errorf("preamp = %v, want %v", out.Preamp, in.Preamp)
	}
	var want []Band
	for _, b := range in.Bands {
		if b.Enabled {
			want = append(want, b)
		}
	}
	if len(out.Bands) != len(want) {
		t.Fatalf("%d bands imported, want %d (the OFF band must be dropped)", len(out.Bands), len(want))
	}
	for i, b := range out.Bands {
		w := want[i]
		if b.Type != w.Type || math.Abs(b.Freq-w.Freq) > 0.5 || math.Abs(b.Gain-w.Gain) > 0.05 || math.Abs(b.Q-w.Q) > 0.01 || !b.Enabled {
			t.Errorf("band %d = %+v, want %+v", i, b, w)
		}
	}
}

func TestParseAPORejectsTextWithoutFilters(t *testing.T) {
	if _, err := parseAPO("Preamp: -2.0 dB\nnot a filter line\n"); err == nil {
		t.Fatal("text with no filter bands must be an error, not an empty EQ")
	}
}
