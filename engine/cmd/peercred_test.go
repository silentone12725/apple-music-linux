package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// The kernel's socket table must tell us the uid of the client on a real loopback
// connection — this exercises the /proc/net/tcp address formatting end to end.
func TestPeerUIDFindsTheClientOnALoopbackConnection(t *testing.T) {
	if _, err := os.Stat(procNetPaths[0]); err != nil {
		t.Skip("no /proc/net/tcp")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()

	uid, err := peerUID(server)
	if err != nil {
		t.Fatalf("peerUID: %v", err)
	}
	if int(uid) != os.Getuid() {
		t.Fatalf("peerUID = %d, want %d", uid, os.Getuid())
	}
}

func TestListenerAdmitsOwnUserAndDropsOthers(t *testing.T) {
	if _, err := os.Stat(procNetPaths[0]); err != nil {
		t.Skip("no /proc/net/tcp")
	}
	run := func(allow func(uint32) bool) (admitted bool) {
		raw, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		l := &peerUIDListener{Listener: raw, lookup: peerUID, allow: allow}
		defer l.Close()

		got := make(chan struct{}, 1)
		go func() {
			if c, err := l.Accept(); err == nil {
				c.Close()
				got <- struct{}{}
			}
		}()
		c, err := net.Dial("tcp", raw.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		select {
		case <-got:
			return true
		case <-time.After(300 * time.Millisecond):
			return false
		}
	}

	if !run(func(uid uint32) bool { return int(uid) == os.Getuid() }) {
		t.Error("a connection from the server's own user was refused")
	}
	if run(func(uint32) bool { return false }) {
		t.Error("a connection from a user that is not allowed was admitted")
	}
}

func TestListenerClosesRefusedConnections(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := &peerUIDListener{Listener: raw, lookup: func(net.Conn) (uint32, error) { return 4242, nil },
		allow: func(uint32) bool { return false }}
	defer l.Close()
	go l.Accept() //nolint:errcheck

	c, err := net.Dial("tcp", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(2 * time.Second)) //nolint:errcheck
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("read returned data from a refused connection")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("a refused connection was left open")
	}
}

func TestRequireToken(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := requireToken("s3cret", ok)

	for name, tc := range map[string]struct {
		method, target string
		header         map[string]string
		want           int
	}{
		"no token":          {"GET", "/x", nil, http.StatusUnauthorized},
		"wrong token":       {"GET", "/x", map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized},
		"bearer":            {"GET", "/x", map[string]string{"Authorization": "Bearer s3cret"}, http.StatusNoContent},
		"x-api-token":       {"GET", "/x", map[string]string{"X-Api-Token": "s3cret"}, http.StatusNoContent},
		"query (for media)": {"GET", "/x?access_token=s3cret", nil, http.StatusNoContent},
		"preflight":         {"OPTIONS", "/x", nil, http.StatusNoContent},
		"basic auth":        {"GET", "/x", map[string]string{"Authorization": "Basic s3cret"}, http.StatusUnauthorized},
	} {
		req := httptest.NewRequest(tc.method, tc.target, nil)
		for k, v := range tc.header {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: status %d, want %d", name, rec.Code, tc.want)
		}
	}

	// No token configured: the middleware must be a no-op, not a lockout.
	rec := httptest.NewRecorder()
	requireToken("", ok).ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("empty token must disable the check, got %d", rec.Code)
	}
}
