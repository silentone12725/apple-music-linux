package fairplay

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

type countingDialer struct{ dials int }

// drainedPipe returns a pipe end whose peer discards everything: closing a connection
// writes a goodbye frame, and net.Pipe blocks writes until the other side reads.
func drainedPipe() net.Conn {
	c, peer := net.Pipe()
	go io.Copy(io.Discard, peer)
	return c
}

func (d *countingDialer) DialCBCS(context.Context) (net.Conn, error) {
	d.dials++
	return drainedPipe(), nil
}

type inProcDialer struct{ countingDialer }

func (*inProcDialer) InProcess() bool { return true }

func idleConn(t *testing.T, d CBCSDialer) *drmConn {
	t.Helper()
	c := drainedPipe()
	t.Cleanup(func() { c.Close() })
	dc := newDRMConn(context.Background(), d, c)
	dc.lastUsed = time.Now().Add(-2 * drmConnIdleTimeout)
	return dc
}

func TestRefreshIfNeeded_IdleReconnectsSocketDialers(t *testing.T) {
	d := &countingDialer{}
	if !idleConn(t, d).refreshIfNeeded() || d.dials != 1 {
		t.Fatalf("idle socket connection was not reconnected (dials=%d)", d.dials)
	}
}

func TestRefreshIfNeeded_IdleKeepsInProcessPipe(t *testing.T) {
	d := &inProcDialer{}
	if idleConn(t, d).refreshIfNeeded() || d.dials != 0 {
		t.Fatalf("in-process connection was reconnected for idleness (dials=%d)", d.dials)
	}
}
