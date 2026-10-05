package drm

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
)

// serveCBCS speaks the FairPlay sample protocol of handle() in the wrapper's
// main.c over conn, with key-context creation and sample decryption injected
// so the protocol is testable without the native library:
//
//	repeat:  [uint8 len][adamID] [uint8 len][keyURI]      — select a key
//	         ([uint32LE size][sample] → [decrypted sample])* — decrypt samples
//	         [uint32LE 0]                                   — end of this key
//
// A zero size ends the current key, NOT the connection: the client
// (alacstream.SwitchKeys) then sends the next adamID/URI on the same
// connection. The connection ends when the client closes it (EOF at a header),
// or when a header is empty or its key cannot be opened.
func serveCBCS(ctx context.Context, conn net.Conn, openKey func(adamID, uri string) (decrypt func([]byte) error, err error)) error {
	for {
		adamID, err := readShortString(conn)
		if errors.Is(err, io.EOF) {
			return nil // client finished
		}
		if err != nil {
			return err
		}
		if adamID == "" {
			return nil // matches handle(): adamSize <= 0 ends the session
		}
		uri, err := readShortString(conn)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		decrypt, err := openKey(adamID, uri)
		if err != nil {
			return err
		}
		for {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var sizeBuf [4]byte
			if _, err := io.ReadFull(conn, sizeBuf[:]); err != nil {
				if errors.Is(err, io.EOF) {
					return nil // client closed after its last sample
				}
				return err
			}
			size := binary.LittleEndian.Uint32(sizeBuf[:])
			if size == 0 {
				break // key switch: the next header selects a new key
			}
			sample := make([]byte, size)
			if _, err := io.ReadFull(conn, sample); err != nil {
				return err
			}
			if err := decrypt(sample); err != nil {
				return fmt.Errorf("decrypt CBCS sample: %w", err)
			}
			if _, err := conn.Write(sample); err != nil {
				return err
			}
		}
	}
}

func readShortString(r io.Reader) (string, error) {
	var n [1]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return "", err
	}
	buf := make([]byte, n[0])
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", fmt.Errorf("short string: %w", err)
	}
	return string(buf), nil
}
