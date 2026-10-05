package drm

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func writeShort(t *testing.T, w io.Writer, s string) {
	t.Helper()
	if _, err := w.Write(append([]byte{byte(len(s))}, s...)); err != nil {
		t.Fatal(err)
	}
}

func roundTrip(t *testing.T, c net.Conn, sample []byte) []byte {
	t.Helper()
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(sample)))
	if _, err := c.Write(append(hdr[:], sample...)); err != nil {
		t.Fatal(err)
	}
	out := make([]byte, len(sample))
	if _, err := io.ReadFull(c, out); err != nil {
		t.Fatalf("read decrypted sample: %v", err)
	}
	return out
}

// A zero size switches keys on the SAME connection (wrapper main.c handle());
// the connection must survive it.
func TestServeCBCSKeySwitchKeepsConnection(t *testing.T) {
	client, server := net.Pipe()
	var opened []string
	done := make(chan error, 1)
	go func() {
		done <- serveCBCS(context.Background(), server, func(adamID, uri string) (func([]byte) error, error) {
			opened = append(opened, adamID+"|"+uri)
			k := byte(len(opened)) // key 1 XORs with 1, key 2 with 2
			return func(b []byte) error {
				for i := range b {
					b[i] ^= k
				}
				return nil
			}, nil
		})
		server.Close()
	}()

	writeShort(t, client, "0")
	writeShort(t, client, "skd://prefetch")
	if got := roundTrip(t, client, []byte{0, 0}); got[0] != 1 {
		t.Fatalf("first key not applied: %v", got)
	}
	client.Write([]byte{0, 0, 0, 0}) // alacstream.SwitchKeys
	writeShort(t, client, "1440833098")
	writeShort(t, client, "skd://real")
	if got := roundTrip(t, client, []byte{0, 0}); got[0] != 2 {
		t.Fatalf("second key not applied after switch: %v", got)
	}
	client.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveCBCS: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serveCBCS did not end when the client closed")
	}
	if len(opened) != 2 || opened[1] != "1440833098|skd://real" {
		t.Fatalf("keys opened: %v", opened)
	}
}

func TestServeCBCSKeyOpenFailureEndsSession(t *testing.T) {
	client, server := net.Pipe()
	go func() {
		writeShort(t, client, "1")
		writeShort(t, client, "skd://bad")
	}()
	err := serveCBCS(context.Background(), server, func(string, string) (func([]byte) error, error) {
		return nil, errors.New("no kd ctx")
	})
	if err == nil {
		t.Fatal("want the key-open error")
	}
}
