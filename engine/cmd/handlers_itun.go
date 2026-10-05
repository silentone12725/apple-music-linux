package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/itouakirai/mp4ff/mp4"
)

// itunDecryptBatchSize is how many samples to send to the wrapper's port 50020
// in a single TCP session. Keeps memory bounded while minimizing round-trips.
const itunDecryptBatchSize = 200

// prepareItunFaststart downloads the itun-encrypted progressive MP4 from the
// CDN, decrypts each video sample via port 50020, and writes a clean faststart
// MP4 to the disk cache. This is the "offline decryption" path — the HQ
// progressive flavor carries itun DRM which the wrapper's SVPastisDecryptor
// can handle locally, producing a fully seekable decrypted file.
func (s *APIServer) prepareItunFaststart(id, assetID string, cdnURL string, adamID uint64) {
	const qualifier = "mv-dl"
	pw, _ := s.diskCache.BeginPut(assetID, qualifier)
	if pw == nil {
		return
	}
	s.mvPreparing.Store(assetID, struct{}{})
	outPath := pw.File.Name()
	pw.File.Close()

	log.Printf("[itun-dec] start assetID=%s adamID=%d", assetID, adamID)
	ctx, cancel := context.WithTimeout(s.shutdownCtx, 20*time.Minute)
	defer cancel()

	err := itunDecryptToFile(ctx, s, cdnURL, adamID, outPath)
	s.mvPreparing.Delete(assetID)
	if err != nil {
		log.Printf("[itun-dec] FAILED assetID=%s: %v", assetID, err)
		pw.Discard()
		return
	}
	if err := pw.Commit(); err != nil {
		log.Printf("[itun-dec] commit FAILED assetID=%s: %v", assetID, err)
		return
	}
	if fi, e := os.Stat(func() string { p, _ := s.diskCache.Path(assetID, qualifier); return p }()); e == nil {
		log.Printf("[itun-dec] DONE assetID=%s size=%d", assetID, fi.Size())
	}
}

// itunDecryptToFile downloads the encrypted progressive MP4, decrypts all
// samples via port 50020, and writes a clean MP4 via FFmpeg faststart remux.
func itunDecryptToFile(ctx context.Context, s *APIServer, cdnURL string, adamID uint64, outPath string) error {
	// Download the encrypted file.
	tmpEnc, err := downloadToTemp(ctx, cdnURL)
	if err != nil {
		return err
	}
	defer os.Remove(tmpEnc.Name())
	defer tmpEnc.Close()

	// Decrypt in-place: parse moov, find video samples, decrypt each one
	// at its file offset. itun CBC preserves sample sizes.
	if err := itunDecryptInPlace(ctx, s, tmpEnc, adamID); err != nil {
		return err
	}

	// Now the temp file is a decrypted progressive MP4 (but with drmi/enca
	// sample entries instead of avc1/mp4a). FFmpeg -c:v copy handles this —
	// it reads the raw NAL data and produces a clean avc1 output.
	if _, err := tmpEnc.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek for ffmpeg: %w", err)
	}
	return transcodeVideoFaststart(ctx, func(dst io.Writer) error {
		_, err := io.Copy(dst, tmpEnc)
		return err
	}, outPath, 0)
}

// itunDecryptInPlace decrypts all video (and audio) samples in the file at
// their original offsets. itun CBC preserves sample sizes so the stbl/stco
// remain valid after decryption.
func itunDecryptInPlace(ctx context.Context, s *APIServer, f *os.File, adamID uint64) error {
	if s.dm == nil {
		return fmt.Errorf("itun decrypt: DRM backend not available")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek: %w", err)
	}
	parsed, err := mp4.DecodeFile(f, mp4.WithDecodeMode(mp4.DecModeLazyMdat))
	if err != nil {
		return fmt.Errorf("parse mp4: %w", err)
	}
	if parsed.Moov == nil {
		return fmt.Errorf("no moov box")
	}

	for _, trak := range parsed.Moov.Traks {
		if trak.Mdia == nil || trak.Mdia.Minf == nil {
			continue
		}
		handler := ""
		if trak.Mdia.Hdlr != nil {
			handler = trak.Mdia.Hdlr.HandlerType
		}
		stbl := trak.Mdia.Minf.Stbl
		if stbl == nil || stbl.Stsz == nil || stbl.Stsc == nil {
			continue
		}
		nrSamples := stbl.Stsz.GetNrSamples()
		if nrSamples == 0 {
			continue
		}
		log.Printf("[itun-dec] track handler=%s samples=%d", handler, nrSamples)

		// Build per-sample file offsets.
		type sampleLoc struct {
			offset uint64
			size   uint32
		}
		locs := make([]sampleLoc, nrSamples)
		for sn := uint32(1); sn <= nrSamples; sn++ {
			chunkNr, firstInChunk, cErr := stbl.Stsc.ChunkNrFromSampleNr(int(sn))
			if cErr != nil {
				return fmt.Errorf("chunk for sample %d: %w", sn, cErr)
			}
			var chunkOff uint64
			if stbl.Stco != nil {
				chunkOff, cErr = stbl.Stco.GetOffset(chunkNr)
			} else if stbl.Co64 != nil {
				chunkOff, cErr = stbl.Co64.GetOffset(chunkNr)
			} else {
				return fmt.Errorf("no stco/co64")
			}
			if cErr != nil {
				return fmt.Errorf("offset chunk %d: %w", chunkNr, cErr)
			}
			var intraOff uint64
			for prev := firstInChunk; prev < int(sn); prev++ {
				intraOff += uint64(stbl.Stsz.GetSampleSize(prev))
			}
			locs[sn-1] = sampleLoc{offset: chunkOff + intraOff, size: stbl.Stsz.GetSampleSize(int(sn))}
		}

		// Decrypt in batches.
		decrypted := 0
		for batchStart := 0; batchStart < len(locs); batchStart += itunDecryptBatchSize {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			batchEnd := batchStart + itunDecryptBatchSize
			if batchEnd > len(locs) {
				batchEnd = len(locs)
			}
			batch := locs[batchStart:batchEnd]

			encSamples := make([][]byte, len(batch))
			for i, loc := range batch {
				buf := make([]byte, loc.size)
				if _, err := f.ReadAt(buf, int64(loc.offset)); err != nil {
					return fmt.Errorf("read sample %d: %w", batchStart+i+1, err)
				}
				encSamples[i] = buf
			}

			decSamples, dErr := s.dm.DecryptItunSamples(ctx, adamID, encSamples)
			if dErr != nil {
				return fmt.Errorf("decrypt batch %d-%d: %w", batchStart+1, batchEnd, dErr)
			}

			// Write decrypted data back at the same offsets.
			for i, loc := range batch {
				dec := decSamples[i]
				if uint32(len(dec)) != loc.size {
					return fmt.Errorf("sample %d size mismatch: encrypted=%d decrypted=%d (itun size-preserving assumption violated)",
						batchStart+i+1, loc.size, len(dec))
				}
				if _, err := f.WriteAt(dec, int64(loc.offset)); err != nil {
					return fmt.Errorf("write sample %d: %w", batchStart+i+1, err)
				}
			}

			decrypted += len(batch)
			if decrypted%(itunDecryptBatchSize*5) == 0 || batchEnd == len(locs) {
				log.Printf("[itun-dec] %s: decrypted %d/%d samples", handler, decrypted, nrSamples)
			}
		}
	}
	return nil
}

// downloadToTemp downloads a URL to a temp file and returns the open file
// (seeked to position 0).
func downloadToTemp(ctx context.Context, url string) (*os.File, error) {
	tmp, err := os.CreateTemp("", "itun-enc-*.mp4")
	if err != nil {
		return nil, fmt.Errorf("create temp: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("cdn request: %w", err)
	}
	// Use a client without the 30s timeout — downloads can be large.
	client := &http.Client{
		Transport: mvCDNClient.Transport,
	}
	resp, err := client.Do(req)
	if err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("cdn download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("cdn HTTP %d", resp.StatusCode)
	}

	start := time.Now()
	n, err := io.Copy(tmp, resp.Body)
	if err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("cdn copy: %w", err)
	}
	log.Printf("[itun-dec] downloaded %d bytes in %s", n, time.Since(start).Truncate(time.Millisecond))

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("seek: %w", err)
	}
	return tmp, nil
}
