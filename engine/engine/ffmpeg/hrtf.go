// Package ffmpeg – HRTF impulse-response extraction from SOFA datasets.
//
// This module is the Linux equivalent of DtsHrtfEnc.dll's SPAC-based HRTF
// engine from DTS Sound Unbound:
//
//	DtsHrtfEnc::InitializeConvInp/OutL/OutR → hrtf.go extraction + cache
//	DtsHrtfEnc::ProcessSingleBlock          → FFmpeg headphone HRTF filter
//	DtsHrtfEnc::MixChannelBed              → FFmpeg headphone accumulation
//	DTS SPAC.crypt FIR filter bank         → MIT KEMAR SOFA HRTF dataset
//
// The MIT KEMAR normal-pinna SOFA file ships with libmysofa on most Linux
// distributions (/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa).
package ffmpeg

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// sofaPath is the canonical MIT KEMAR SOFA location installed by libmysofa.
const sofaPath = "/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa"

// hrtf7dot1 defines the 7.1 ITU-R BS.775-3 speaker positions in SOFA
// azimuth convention (0°=front, 90°=left, 270°=right, counter-clockwise).
var hrtf7dot1 = []struct {
	name string
	az   float64
	el   float64
}{
	{"FL", 30.0, 0.0},  // front-left  30° left
	{"FR", 330.0, 0.0}, // front-right 30° right  (330° = -30°)
	{"FC", 0.0, 0.0},   // centre
	{"BL", 110.0, 0.0}, // back-left  110° left
	{"BR", 250.0, 0.0}, // back-right 110° right  (250° = -110°)
	{"SL", 90.0, 0.0},  // side-left   90° left
	{"SR", 270.0, 0.0}, // side-right  90° right  (270° = -90°)
	{"LFE", 0.0, 0.0},  // LFE sub — use front HRTF (low-pass anyway)
}

// HRTFSet holds HRTF impulse-response data for the binaural renderer.
//
// Mode "stereo": per-channel stereo WAV files extracted from a SOFA dataset
// (the original MIT KEMAR path). IRPaths maps channel name to WAV path.
//
// Mode "multich": a single 14-channel WAV in HeSuVi layout
// (FL FR FC BL BR SL SR, L+R per channel) used with FFmpeg hrir=multich.
// MultichWAV holds the path.
type HRTFSet struct {
	Mode       string            // "stereo" | "multich"
	IRPaths    map[string]string // stereo mode: channel→WAV path
	MultichWAV string            // multich mode: 14-ch WAV path
	PresetName string            // "kemar" | "custom" | ...
	SampleRate int
}

var (
	hrtfOnce  sync.Once
	hrtfCache *HRTFSet
	hrtfErr   error
)

// GetHRTFSet returns a cached HRTFSet. Detection priority:
//  1. ~/.config/aml/hrtf.wav — user-provided 14-ch HeSuVi WAV (multich mode)
//  2. /usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa — extracted per-channel (stereo mode)
//  3. nil, nil — crossfeed fallback; callers handle this case
func GetHRTFSet() (*HRTFSet, error) {
	hrtfOnce.Do(func() {
		// Priority 1: user-provided HeSuVi-format 14-channel WAV.
		if custom := customHRTFPath(); custom != "" {
			sr, err := wavSampleRate(custom)
			if err == nil {
				hrtfCache = &HRTFSet{
					Mode:       "multich",
					MultichWAV: custom,
					PresetName: "custom",
					SampleRate: sr,
				}
				return
			}
			log.Printf("hrtf: custom WAV at %s unreadable (%v), falling back to SOFA", custom, err)
		}

		// Priority 2: system SOFA (MIT KEMAR).
		if _, err := os.Stat(sofaPath); os.IsNotExist(err) {
			return // SOFA absent – silent crossfeed fallback
		}
		sofa, err := extractHRTFSet(sofaPath)
		if err != nil {
			hrtfErr = err
			return
		}
		sofa.Mode = "stereo"
		sofa.PresetName = "kemar"
		hrtfCache = sofa
	})
	return hrtfCache, hrtfErr
}

// customHRTFPath returns the user-provided HRTF WAV path if it exists.
func customHRTFPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	p := filepath.Join(home, ".config", "aml", "hrtf.wav")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// wavSampleRate reads the sample rate from bytes 24–27 of a WAV file header.
func wavSampleRate(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var buf [28]byte
	if _, err := io.ReadFull(f, buf[:]); err != nil {
		return 0, err
	}
	sr := binary.LittleEndian.Uint32(buf[24:28])
	if sr == 0 {
		return 0, fmt.Errorf("invalid sample rate 0 in WAV header")
	}
	return int(sr), nil
}

// hrtfCacheDir returns (creating if needed) ~/.cache/aml/hrtf/.
func hrtfCacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "aml", "hrtf")
	return dir, os.MkdirAll(dir, 0o755)
}

// stampRecord is serialised to stamp.json to detect SOFA file changes.
type stampRecord struct {
	SofaPath string `json:"sofa_path"`
	ModNS    int64  `json:"mod_ns"`
	SR       int    `json:"sample_rate"`
}

// extractHRTFSet extracts 7.1 HRTF impulse responses from the SOFA file into
// per-channel WAV files in the cache directory, using a stamp file to skip
// redundant extraction when the SOFA file has not changed.
func extractHRTFSet(sofa string) (*HRTFSet, error) {
	dir, err := hrtfCacheDir()
	if err != nil {
		return nil, fmt.Errorf("hrtf: cache dir: %w", err)
	}

	fi, err := os.Stat(sofa)
	if err != nil {
		return nil, fmt.Errorf("hrtf: stat: %w", err)
	}

	// Check whether already extracted for this SOFA version.
	stamp := filepath.Join(dir, "stamp.json")
	if raw, err := os.ReadFile(stamp); err == nil {
		var rec stampRecord
		if json.Unmarshal(raw, &rec) == nil &&
			rec.SofaPath == sofa &&
			rec.ModNS == fi.ModTime().UnixNano() {
			paths, allExist := collectWAVPaths(dir)
			if allExist {
				return &HRTFSet{Mode: "stereo", IRPaths: paths, SampleRate: rec.SR}, nil
			}
		}
	}

	// Extract via Python/h5py.
	irData, sr, err := readSOFAData(sofa)
	if err != nil {
		return nil, fmt.Errorf("hrtf: read sofa: %w", err)
	}

	paths := make(map[string]string, len(hrtf7dot1))
	for _, sp := range hrtf7dot1 {
		idx := nearestSOFAMeasurement(irData.positions, sp.az, sp.el)
		wavPath := filepath.Join(dir, sp.name+".wav")
		if err := writeStereoWAV(wavPath,
			irData.irLeft[idx], irData.irRight[idx], sr); err != nil {
			return nil, fmt.Errorf("hrtf: write %s: %w", sp.name, err)
		}
		paths[sp.name] = wavPath
	}

	// Write stamp.
	rec := stampRecord{SofaPath: sofa, ModNS: fi.ModTime().UnixNano(), SR: sr}
	raw, _ := json.Marshal(rec)
	_ = os.WriteFile(stamp, raw, 0o644)

	return &HRTFSet{Mode: "stereo", IRPaths: paths, SampleRate: sr}, nil
}

// collectWAVPaths checks whether all 8 channel WAV files exist.
func collectWAVPaths(dir string) (map[string]string, bool) {
	paths := make(map[string]string, len(hrtf7dot1))
	for _, sp := range hrtf7dot1 {
		p := filepath.Join(dir, sp.name+".wav")
		if _, err := os.Stat(p); err != nil {
			return nil, false
		}
		paths[sp.name] = p
	}
	return paths, true
}

// sofaIRData holds parsed SOFA impulse responses.
type sofaIRData struct {
	// irLeft/irRight are indexed [measurement][tap].
	irLeft    [][]float64
	irRight   [][]float64
	positions [][2]float64 // [measurement]{az, el}
}

// readSOFAData shells out to Python/h5py to parse the SOFA HDF5 file.
// The Python script writes a compact binary blob containing IR data and
// source positions, which we parse back in Go.
//
// The blob layout:
//
//	[4]byte  "SOFA"
//	int32 LE  M  (number of measurements)
//	int32 LE  N  (number of IR taps)
//	int32 LE  SR (sample rate, Hz)
//	[M*2*N]float64 LE  – IR: measurement-major, ear-minor (L then R), tap-innermost
//	[M*2]float64 LE    – SourcePosition: azimuth, elevation per measurement
func readSOFAData(sofa string) (*sofaIRData, int, error) {
	pyScript := `
import sys, struct, h5py, numpy as np
path = sys.argv[1]
with h5py.File(path, 'r') as f:
    ir  = np.array(f['Data.IR'], dtype=np.float64)        # [M,2,N]
    pos = np.array(f['SourcePosition'], dtype=np.float64)  # [M,3]
    sr  = int(np.array(f['Data.SamplingRate']).flatten()[0])
M, _, N = ir.shape
sys.stdout.buffer.write(b'SOFA')
sys.stdout.buffer.write(struct.pack('<iii', M, N, sr))
sys.stdout.buffer.write(ir.tobytes())                 # M*2*N float64, C-order
sys.stdout.buffer.write(pos[:, :2].astype(np.float64).tobytes())  # M*2 float64
`
	// Write helper script to a temp file.
	sf, err := os.CreateTemp("", "aml_sofa_*.py")
	if err != nil {
		return nil, 0, err
	}
	defer os.Remove(sf.Name())
	if _, err = sf.WriteString(pyScript); err != nil {
		return nil, 0, err
	}
	sf.Close()

	var stdout bytes.Buffer
	var stderr strings.Builder
	cmd := exec.Command("python3", sf.Name(), sofa)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, 0, fmt.Errorf("python3 sofa reader: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}

	return parseSOFABlob(stdout.Bytes())
}

// parseSOFABlob decodes the binary blob produced by readSOFAData's Python script.
func parseSOFABlob(raw []byte) (*sofaIRData, int, error) {
	if len(raw) < 16 || string(raw[:4]) != "SOFA" {
		return nil, 0, fmt.Errorf("hrtf: invalid sofa blob (len=%d)", len(raw))
	}
	M := int(int32(binary.LittleEndian.Uint32(raw[4:])))
	N := int(int32(binary.LittleEndian.Uint32(raw[8:])))
	sr := int(int32(binary.LittleEndian.Uint32(raw[12:])))
	off := 16

	want := M*2*N*8 + M*2*8
	if len(raw) < off+want {
		return nil, 0, fmt.Errorf("hrtf: blob too short (have %d, need %d)", len(raw), off+want)
	}

	irLeft := make([][]float64, M)
	irRight := make([][]float64, M)
	for m := 0; m < M; m++ {
		irLeft[m] = make([]float64, N)
		irRight[m] = make([]float64, N)
		for n := 0; n < N; n++ {
			irLeft[m][n] = math.Float64frombits(binary.LittleEndian.Uint64(raw[off:]))
			off += 8
		}
		for n := 0; n < N; n++ {
			irRight[m][n] = math.Float64frombits(binary.LittleEndian.Uint64(raw[off:]))
			off += 8
		}
	}

	positions := make([][2]float64, M)
	for m := 0; m < M; m++ {
		positions[m][0] = math.Float64frombits(binary.LittleEndian.Uint64(raw[off:]))
		off += 8
		positions[m][1] = math.Float64frombits(binary.LittleEndian.Uint64(raw[off:]))
		off += 8
	}

	return &sofaIRData{irLeft: irLeft, irRight: irRight, positions: positions}, sr, nil
}

// nearestSOFAMeasurement returns the measurement index with the smallest
// Euclidean distance to (targetAz, targetEl) in degrees.
func nearestSOFAMeasurement(positions [][2]float64, targetAz, targetEl float64) int {
	best, bestDist := 0, math.MaxFloat64
	for i, p := range positions {
		d := math.Hypot(p[0]-targetAz, p[1]-targetEl)
		if d < bestDist {
			bestDist = d
			best = i
		}
	}
	return best
}

// writeStereoWAV writes a two-channel IEEE float-32 WAV file suitable for
// FFmpeg's headphone filter (stereo hrir mode).  Left and right are the
// per-ear HRTF impulse responses.
func writeStereoWAV(path string, left, right []float64, sr int) error {
	n := len(left)

	// Convert float64 → float32 and interleave L/R.
	interleaved := make([]float32, n*2)
	for i := 0; i < n; i++ {
		interleaved[i*2] = float32(left[i])
		interleaved[i*2+1] = float32(right[i])
	}

	dataLen := n * 2 * 4 // samples × 2 channels × 4 bytes

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	le := binary.LittleEndian
	put16 := func(v uint16) { binary.Write(f, le, v) } //nolint:errcheck
	put32 := func(v uint32) { binary.Write(f, le, v) } //nolint:errcheck

	// RIFF header
	f.WriteString("RIFF")                        //nolint:errcheck
	put32(uint32(36 + dataLen))                  // file size − 8
	f.WriteString("WAVE")                        //nolint:errcheck
	f.WriteString("fmt ")                        //nolint:errcheck
	put32(18)                                    // fmt chunk size (includes 2-byte extension)
	put16(3)                                     // IEEE float
	put16(2)                                     // stereo
	put32(uint32(sr))                            // sample rate
	put32(uint32(sr * 2 * 4))                   // byte rate
	put16(2 * 4)                                 // block align
	put16(32)                                    // bits per sample
	put16(0)                                     // extension size
	f.WriteString("data")                        //nolint:errcheck
	put32(uint32(dataLen))                       // data chunk size
	binary.Write(f, le, interleaved)             //nolint:errcheck

	return nil
}
