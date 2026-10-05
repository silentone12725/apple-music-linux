package main

import (
	"bufio"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
)

// The API is unauthenticated and sits on a fixed loopback port, and loopback is shared by
// every user on the machine: without a check, any local account could drive playback,
// export files as the owner, or clear the DRM session. Browser origin checks (see
// corsPreflightHandler) only stop other web pages.
//
// On Linux the kernel tells us who owns the client end of a loopback connection: it is
// the uid column of the socket's entry in /proc/net/tcp{,6}. peerUIDListener refuses
// connections from any uid other than the server's own (or root, who could do anything
// anyway). Where /proc can't be read the check is switched off with a warning rather than
// bricking the app; AML_ALLOW_OTHER_USERS=1 switches it off deliberately.

// procNetPaths is where the socket table lives; a variable so tests can point it elsewhere.
var procNetPaths = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// peerUIDListener wraps a listener and drops connections from other users.
type peerUIDListener struct {
	net.Listener
	lookup func(net.Conn) (uint32, error)
	allow  func(uid uint32) bool
}

func (l *peerUIDListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		uid, err := l.lookup(c)
		if err == nil && l.allow(uid) {
			return c, nil
		}
		if err != nil {
			slog.Warn("refusing connection: could not identify the client user", "err", err)
		} else {
			slog.Warn("refusing connection from another user", "uid", uid)
		}
		c.Close()
	}
}

// guardListener applies the per-user check when it can be enforced.
func guardListener(l net.Listener) net.Listener {
	if os.Getenv("AML_ALLOW_OTHER_USERS") == "1" {
		slog.Warn("AML_ALLOW_OTHER_USERS=1: any local user can use the engine API")
		return l
	}
	if _, err := os.Stat(procNetPaths[0]); err != nil {
		slog.Warn("cannot identify local clients (no /proc/net/tcp); the engine API is open to every local user", "err", err)
		return l
	}
	euid := uint32(os.Geteuid())
	return &peerUIDListener{
		Listener: l,
		lookup:   peerUID,
		allow:    func(uid uint32) bool { return uid == euid || uid == 0 },
	}
}

// peerUID returns the uid of the process on the other end of a loopback TCP connection.
func peerUID(c net.Conn) (uint32, error) {
	client, ok1 := c.RemoteAddr().(*net.TCPAddr)
	server, ok2 := c.LocalAddr().(*net.TCPAddr)
	if !ok1 || !ok2 {
		return 0, errors.New("not a TCP connection")
	}
	// The client socket's own entry has *its* local address on the left: our remote one.
	wantLocal, wantRemote := procAddr(client), procAddr(server)
	var firstErr error
	for _, path := range procNetPaths {
		uid, found, err := scanProcNet(path, wantLocal, wantRemote)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if found {
			return uid, nil
		}
	}
	if firstErr != nil {
		return 0, firstErr
	}
	return 0, fmt.Errorf("no socket entry for %v -> %v", client, server)
}

// procAddr formats an address the way /proc/net/tcp does: each 32-bit word of the address
// as hex in host byte order (little-endian on the machines that matter), then ":" and
// the port in hex.
func procAddr(a *net.TCPAddr) string {
	var b strings.Builder
	if ip4 := a.IP.To4(); ip4 != nil {
		fmt.Fprintf(&b, "%02X%02X%02X%02X", ip4[3], ip4[2], ip4[1], ip4[0])
	} else {
		ip6 := a.IP.To16()
		for i := 0; i < 16; i += 4 {
			fmt.Fprintf(&b, "%02X%02X%02X%02X", ip6[i+3], ip6[i+2], ip6[i+1], ip6[i])
		}
	}
	fmt.Fprintf(&b, ":%04X", a.Port)
	return b.String()
}

var procNetMu sync.Mutex // one scan at a time keeps a burst of connections from re-reading the table in parallel

func scanProcNet(path, local, remote string) (uid uint32, found bool, err error) {
	procNetMu.Lock()
	defer procNetMu.Unlock()
	f, err := os.Open(path)
	if err != nil {
		return 0, false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		// sl local rem st tx:rx tr:tm retrnsmt uid timeout inode ...
		fields := strings.Fields(sc.Text())
		if len(fields) < 8 || fields[1] != local || fields[2] != remote {
			continue
		}
		n, perr := strconv.ParseUint(fields[7], 10, 32)
		if perr != nil {
			return 0, false, perr
		}
		return uint32(n), true, nil
	}
	return 0, false, sc.Err()
}

// requireToken adds an optional shared-secret check for embedders that expose the API
// beyond "the same user": when token is non-empty every request except CORS preflights
// must present it as "Authorization: Bearer <token>", "X-Api-Token" or ?access_token=.
func requireToken(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		got := r.Header.Get("X-Api-Token")
		if got == "" {
			if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				got = h[len("Bearer "):]
			}
		}
		if got == "" {
			got = r.URL.Query().Get("access_token")
		}
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="musickit-engine"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
