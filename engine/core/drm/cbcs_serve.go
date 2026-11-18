package drm

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
)

// maxCBCSSample bounds one sample: real audio/video samples are well under a megabyte, and
// the size comes off the wire as a uint32 that would otherwise allocate up to 4 GiB.
const maxCBCSSample = 64 << 20

// serveCBCS speaks over conn the FairPlay sample protocol the wrapper's former handle() in
// main.c spoke, with key-context creation and sample decryption injected
// so the protocol is testable without the native library:
//
//	repeat:  [uint8 len][adamID] [uint8 len][keyURI]                    — select a key
//	         ([uint32LE size][sample] → [decrypted sample])*              — decrypt samples
//	         [uint32LE 0]                                                 — end of this key
//
// A zero size ends the current key, NOT the connection.
// The connection ends when the client closes it at a record boundary
// (EOF where a header or size would start; EOF inside a record is an error), or
// when a header is empty or its key cannot be opened.
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
			if size > maxCBCSSample {
				return fmt.Errorf("CBCS sample of %d bytes exceeds the %d byte limit", size, maxCBCSSample)
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
	b, err := readShortBytes(r)
	if err != nil {
		return "", fmt.Errorf("short string: %w", err)
	}
	return string(b), nil
}

// readShortBytes reads a [uint8 length][bytes] field. An empty length byte is valid.
func readShortBytes(r io.Reader) ([]byte, error) {
	var n [1]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	if n[0] == 0 {
		return nil, nil
	}
	buf := make([]byte, n[0])
	if _, err := io.ReadFull(r, buf); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return buf, nil
}
