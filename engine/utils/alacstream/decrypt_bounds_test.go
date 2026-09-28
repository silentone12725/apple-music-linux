package alacstream

import (
	"bufio"
	"bytes"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

// A senc subsample that claims more protected bytes than the sample holds
// must return an error instead of panicking.
func TestCbcsDecryptSampleRejectsOversizedSubsample(t *testing.T) {
	rw := bufio.NewReadWriter(bufio.NewReader(&bytes.Buffer{}), bufio.NewWriter(&bytes.Buffer{}))
	tenc := &mp4.TencBox{DefaultCryptByteBlock: 1}
	patterns := []mp4.SubSamplePattern{{BytesOfClearData: 8, BytesOfProtectedData: 1000}}
	if err := cbcsDecryptSample(make([]byte, 64), rw, patterns, tenc); err == nil {
		t.Fatal("want an error for a subsample past the end of the sample")
	}
}

func TestCbcsDecryptSamplesRejectsShortSenc(t *testing.T) {
	rw := bufio.NewReadWriter(bufio.NewReader(&bytes.Buffer{}), bufio.NewWriter(&bytes.Buffer{}))
	senc := &mp4.SencBox{SubSamples: [][]mp4.SubSamplePattern{{}}}
	samples := make([]mp4.FullSample, 3)
	if err := cbcsDecryptSamples(samples, rw, &mp4.TencBox{}, senc); err == nil {
		t.Fatal("want an error when senc has fewer entries than samples")
	}
}
