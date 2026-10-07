//go:build windows

package drm

// WindowsBackend implements DRMBackend for Windows.
//
// Architecture (from reverse engineering AMPLibraryAgent.exe):
//
//	The Windows Apple Music app splits FairPlay into two processes:
//	  - AppleMusic.exe: CoreFP + CoreADI64 — generates SPC, runs YlCJ3lg key derivation
//	  - AMPLibraryAgent.exe: full FPS stack — receives derived key via IPC, writes to SC Info
//
//	After the user plays a track in Apple Music for Windows, the 16-byte AES-128
//	content key is persisted in two stores for the content ID (SHA-1 of the skd:// URI):
//	  File:     %LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_nzyj5cx40ttqa\
//	               LocalCache\Local\Apple\SC Info\<SHA1HEX>
//	  Registry: HKCU\SOFTWARE\Apple\SC Info\<SHA1HEX> (different binary blob)
//
//	This backend reads from the file store. Blob formats (confirmed by Frida):
//	  64 bytes: raw blob, AES-128 key at offset 0
//	  84 bytes: header 00 01 00 50 + 80-byte payload, key at offset 4
//
//	CBCS decryption (Apple Music CBCS, confirmed by Frida T4_ivIsZero=true):
//	  - Mode: AES-128-CBC
//	  - Key:  16-byte key from SC Info at offset 0
//	  - IV:   all zeros (16 bytes of 0x00)
//	  - Only whole 16-byte blocks are decrypted (tail bytes pass through as-is)
//
// Implementation status: key reading + CBCS decryption implemented.
// GetM3U8 uses the Apple Music catalog API (EnhancedHls URL).
// Start/Stop/Auth are no-ops: Apple Music for Windows handles auth natively.

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1" //nolint:gosec // SHA-1 is mandated by Apple's FPS SC Info filename scheme
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"engine/utils/ampapi"
)

const (
	scInfoPkg        = "AppleInc.AppleMusicWin_nzyj5cx40ttqa"
	scInfoRelPath    = `LocalCache\Local\Apple\SC Info`
	scInfoKeyBytes   = 16
	scInfoBlob64     = 64
	scInfoBlob84     = 84
	scInfoHdrV1B0    = 0x00
	scInfoHdrV1B1    = 0x01
	scInfoHdrV1B2    = 0x00
	scInfoHdrV1B3    = 0x50
)

var errNotSupported = errors.New("operation not supported by the Windows SC Info backend")

// windowsBackend reads FairPlay content keys from the Apple Music for Windows
// SC Info file cache and decrypts CBCS samples in-process.
type windowsBackend struct {
	mu       sync.Mutex
	drmDir   string // directory containing drm/files/
	scDir    string // resolved SC Info directory
	authSrc  AuthSource
	eventCh  chan DRMEvent
	running  atomic.Bool

	// cached tokens (loaded by Start)
	musicToken   string
	storefrontID string
}

// NewNativeBackend returns a windowsBackend if the Apple Music for Windows
// SC Info directory can be located; otherwise returns nil (DRM disabled).
func NewNativeBackend(drmDir string) DRMBackend {
	b := &windowsBackend{
		drmDir:  drmDir,
		eventCh: make(chan DRMEvent, 32),
	}

	scDir, err := resolveSCInfoDir()
	if err != nil {
		return nil
	}
	b.scDir = scDir
	return b
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

func (b *windowsBackend) Start(ctx context.Context, cfg BackendConfig) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := b.loadTokensLocked(); err != nil {
		return fmt.Errorf("windows DRM: failed to load tokens: %w", err)
	}
	b.running.Store(true)
	b.emitLocked(DRMEvent{
		Snapshot: DRMSnapshot{
			State: DRMState{
				Process:        ProcessRunning,
				FairPlay:       FairPlayReady,
				Authentication: AuthLoggedIn,
			},
		},
	})
	return nil
}

func (b *windowsBackend) Authenticate(ctx context.Context) error { return nil }

func (b *windowsBackend) Stop() error {
	b.running.Store(false)
	b.emitLocked(DRMEvent{
		Snapshot: DRMSnapshot{
			State: DRMState{Process: ProcessStopped},
		},
	})
	return nil
}

func (b *windowsBackend) Running() bool { return b.running.Load() }

func (b *windowsBackend) SetAuthSource(s AuthSource) {
	b.mu.Lock()
	b.authSrc = s
	b.mu.Unlock()
}

func (b *windowsBackend) Events() <-chan DRMEvent { return b.eventCh }

// ── DRM operations ────────────────────────────────────────────────────────────

// Decrypt decrypts CBCS-encrypted samples using the AES-128 key stored in
// the Apple Music for Windows SC Info cache.
//
// Each sample is decrypted in-place: only the first len(sample)&^0xf bytes
// are touched (whole 16-byte AES blocks). The tail passes through unchanged.
// IV is all-zeros per the confirmed Apple Music CBCS scheme (T4_ivIsZero=true).
func (b *windowsBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	if !b.running.Load() {
		return DecryptResponse{}, ErrNotAuthenticated
	}

	key, err := b.readSCInfoKey(req.KeyURI)
	if err != nil {
		return DecryptResponse{}, fmt.Errorf("SC Info key for %s: %w", req.KeyURI, err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return DecryptResponse{}, fmt.Errorf("aes.NewCipher: %w", err)
	}

	decrypted := make([][]byte, len(req.Samples))
	iv := make([]byte, aes.BlockSize) // all zeros

	for i, sample := range req.Samples {
		n := len(sample) &^ 0xf // truncate to multiple of 16
		if n > 0 {
			dec := cipher.NewCBCDecrypter(block, iv)
			// decrypt in-place; CBC resets IV per call so we always start fresh
			dec.CryptBlocks(sample[:n], sample[:n])
		}
		decrypted[i] = sample
	}
	return DecryptResponse{Samples: decrypted}, nil
}

// GetM3U8 fetches the enhanced HLS URL for an Apple Music track via the
// catalog API using the stored user tokens.
func (b *windowsBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	if !b.running.Load() {
		return "", ErrNotAuthenticated
	}

	b.mu.Lock()
	sf := b.storefrontID
	tok := b.musicToken
	b.mu.Unlock()

	if sf == "" || tok == "" {
		return "", fmt.Errorf("windows DRM: missing storefront or token")
	}

	id := strconv.FormatUint(adamID, 10)
	resp, err := ampapi.GetSongRespContext(ctx, sf, id, "en-US", tok)
	if err != nil {
		return "", fmt.Errorf("GetM3U8 catalog lookup: %w", err)
	}
	if len(resp.Data) == 0 {
		return "", fmt.Errorf("GetM3U8: no data for adamID %d", adamID)
	}
	u := resp.Data[0].Attributes.ExtendedAssetUrls.EnhancedHls
	if u == "" {
		return "", fmt.Errorf("GetM3U8: no enhancedHls URL for adamID %d", adamID)
	}
	return u, nil
}

func (b *windowsBackend) GetAccount(ctx context.Context) (AccountInfo, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := b.loadTokensLocked(); err != nil {
		return AccountInfo{}, fmt.Errorf("windows DRM: load tokens: %w", err)
	}
	return AccountInfo{
		StorefrontID: b.storefrontID,
		MusicToken:   b.musicToken,
	}, nil
}

func (b *windowsBackend) GetProgressiveMVURL(ctx context.Context, adamID uint64) (string, string, error) {
	return "", "", errNotSupported
}

func (b *windowsBackend) DecryptItunSamples(ctx context.Context, adamID uint64, samples [][]byte) ([][]byte, error) {
	return nil, errNotSupported
}

// DialCBCS opens an in-process CBCS decryption pipe backed by SC Info keys.
// The protocol is the same as the Linux NativeBackend (serveCBCS wire format).
func (b *windowsBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	client, server := net.Pipe()

	go func() {
		defer server.Close()
		err := serveCBCS(ctx, server, func(adamID, uri string) (decrypt func([]byte) error, err error) {
			key, err := b.readSCInfoKey(uri)
			if err != nil {
				return nil, fmt.Errorf("SC Info key for %s: %w", uri, err)
			}
			block, err := aes.NewCipher(key)
			if err != nil {
				return nil, fmt.Errorf("aes.NewCipher: %w", err)
			}
			return func(sample []byte) error {
				n := len(sample) &^ 0xf
				if n > 0 {
					iv := make([]byte, aes.BlockSize) // zeros
					cipher.NewCBCDecrypter(block, iv).CryptBlocks(sample[:n], sample[:n])
				}
				return nil
			}, nil
		})
		if err != nil {
			_ = err // connection closed normally
		}
	}()

	return client, nil
}

// ── SC Info helpers ───────────────────────────────────────────────────────────

// resolveSCInfoDir returns the SC Info directory path for the Apple Music
// for Windows UWP package.  Returns an error if the directory does not exist.
func resolveSCInfoDir() (string, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return "", fmt.Errorf("LOCALAPPDATA not set")
	}
	dir := filepath.Join(localAppData, "Packages", scInfoPkg, scInfoRelPath)
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("SC Info directory %s: %w", dir, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("SC Info path %s is not a directory", dir)
	}
	return dir, nil
}

// scInfoFilename returns the 40-hex-char SHA-1 filename for a content ID.
// The content ID is the full skd:// URI from the HLS #EXT-X-KEY tag.
func scInfoFilename(contentID string) string {
	//nolint:gosec // SHA-1 is mandated by Apple's FPS SC Info filename scheme
	h := sha1.Sum([]byte(contentID))
	return strings.ToUpper(hex.EncodeToString(h[:]))
}

// readSCInfoKey reads the 16-byte AES-128 content key for the given skd://
// content ID URI from the SC Info file cache.
//
// Key offset within the blob (Frida instrumentation, AMPLibraryAgent.exe):
//   - 64-byte blob: key at bytes 0–15
//   - 84-byte blob (header 00 01 00 50): key at bytes 4–19
func (b *windowsBackend) readSCInfoKey(contentID string) ([]byte, error) {
	if b.scDir == "" {
		return nil, fmt.Errorf("SC Info directory not initialised")
	}

	name := scInfoFilename(contentID)
	path := filepath.Join(b.scDir, name)

	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("SC Info file %s: %w", name, err)
	}

	return extractKeyFromBlob(blob)
}

// extractKeyFromBlob extracts the 16-byte AES-128 content key from a raw SC
// Info blob.  Supports the 64-byte (raw) and 84-byte (versioned) formats.
func extractKeyFromBlob(blob []byte) ([]byte, error) {
	switch len(blob) {
	case scInfoBlob84:
		// Versioned format: 4-byte header 00 01 00 50 followed by 80-byte payload
		if blob[0] == scInfoHdrV1B0 && blob[1] == scInfoHdrV1B1 &&
			blob[2] == scInfoHdrV1B2 && blob[3] == scInfoHdrV1B3 {
			return append([]byte(nil), blob[4:4+scInfoKeyBytes]...), nil
		}
		// Unknown 84-byte variant: fall through to offset-0 extraction
		return append([]byte(nil), blob[:scInfoKeyBytes]...), nil

	case scInfoBlob64:
		return append([]byte(nil), blob[:scInfoKeyBytes]...), nil

	default:
		return nil, fmt.Errorf("unrecognised SC Info blob size %d (want 64 or 84)", len(blob))
	}
}

// ── Token loading ─────────────────────────────────────────────────────────────

// loadTokensLocked reads MUSIC_TOKEN and STOREFRONT_ID from the drm/files/
// directory.  The caller must hold b.mu.
func (b *windowsBackend) loadTokensLocked() error {
	tok, err := readTrimmedFile(filepath.Join(b.drmDir, "files", "MUSIC_TOKEN"))
	if err != nil {
		return fmt.Errorf("MUSIC_TOKEN: %w", err)
	}
	sf, err := readTrimmedFile(filepath.Join(b.drmDir, "files", "STOREFRONT_ID"))
	if err != nil {
		return fmt.Errorf("STOREFRONT_ID: %w", err)
	}
	b.musicToken = tok
	b.storefrontID = sf
	return nil
}

func readTrimmedFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (b *windowsBackend) emitLocked(ev DRMEvent) {
	select {
	case b.eventCh <- ev:
	default:
	}
}
