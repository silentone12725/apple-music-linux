package main

import (
	"errors"
	"io"
	"os/exec"
	"testing"
	"time"
)

// endless writes until its writer fails, like a network stream longer than -t.
func endless(w io.Writer) error {
	buf := make([]byte, 4096)
	for {
		if _, err := w.Write(buf); err != nil {
			return err
		}
	}
}

func TestRunFFmpegFromSource_ReaderStopsEarly(t *testing.T) {
	done := make(chan struct{})
	var runErr, srcErr error
	go func() {
		runErr, srcErr = runFFmpegFromSource(exec.Command("head", "-c", "10"), endless, "[test]")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("source stayed blocked after the consumer exited")
	}
	if runErr != nil || srcErr != nil {
		t.Fatalf("runErr=%v srcErr=%v, want both nil (early stop is normal)", runErr, srcErr)
	}
}

func TestRunFFmpegFromSource_SourceErrorReported(t *testing.T) {
	boom := errors.New("cdn reset")
	_, srcErr := runFFmpegFromSource(exec.Command("cat"), func(w io.Writer) error {
		w.Write([]byte("partial"))
		return boom
	}, "[test]")
	if !errors.Is(srcErr, boom) {
		t.Fatalf("srcErr = %v, want the source's error", srcErr)
	}
}

func TestBoxCoalescerLargeBoxPassesThrough(t *testing.T) {
	var out countingWriter
	out.w = io.Discard
	c := &boxCoalescer{w: &out}
	hdr := []byte{0, 0, 0, 1, 'm', 'd', 'a', 't', 0, 0, 0, 1, 0, 0, 0, 0} // 64-bit size = 4 GiB
	c.Write(hdr)
	c.Write(make([]byte, 1<<20))
	if !c.pass || out.n != int64(len(hdr)+1<<20) {
		t.Fatalf("pass=%v forwarded=%d: a 4 GiB box must stream, not buffer", c.pass, out.n)
	}
}
