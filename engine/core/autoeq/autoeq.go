// Package autoeq fetches pre-computed AutoEQ headphone correction filters and
// applies them to the FFmpeg audio pipeline as biquad filter chains.
//
// The jaakkopasanen/AutoEq repository contains 5,000+ pre-computed ParametricEQ.txt
// files at Harman target curves. We fetch them directly from raw.githubusercontent.com
// — no Python runtime or algorithm port required.
//
// Filter format (EqualizerAPO):
//
//	Preamp: -6.1 dB
//	Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
//	Filter 2: ON PK  Fc 8800 Hz Gain 5.1 dB Q 1.42
//	...
package autoeq

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Band describes one parametric EQ biquad filter in EqualizerAPO format.
type Band struct {
	Type    string  `json:"type"`    // "PK" | "LSC" | "HSC"
	Freq    float64 `json:"freq"`    // centre/shelf frequency in Hz
	Gain    float64 `json:"gain"`    // gain in dB
	Q       float64 `json:"q"`       // Q factor (bandwidth)
	Enabled bool    `json:"enabled"` // false = skip this band
}

// Settings is the stored EQ configuration (at ~/.config/aml/eq.json).
type Settings struct {
	Preamp float64 `json:"preamp"` // preamp gain in dB (already negative for AutoEQ files)
	Bands  []Band  `json:"bands"`
}

// Model is one entry from the AutoEQ headphone index.
type Model struct {
	Name   string `json:"name"`
	Source string `json:"source"`
	Rig    string `json:"rig"`
	Form   string `json:"form"`
}

var filterRe = regexp.MustCompile(
	`(?i)Filter\s+\d+:\s+ON\s+(PK|LSC|HSC)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+(-?[\d.]+)\s+dB\s+Q\s+([\d.]+)`)

var preampRe = regexp.MustCompile(`(?i)Preamp:\s*(-?[\d.]+)\s*dB`)

var httpClient = &http.Client{Timeout: 15 * time.Second}

// configDir returns ~/.config/aml, creating it if needed.
func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(home, ".config", "aml")
	return d, os.MkdirAll(d, 0o755)
}

// cacheDir returns ~/.cache/aml/autoeq, creating it if needed.
func cacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		base, _ = os.UserHomeDir()
		base = filepath.Join(base, ".cache")
	}
	d := filepath.Join(base, "aml", "autoeq")
	return d, os.MkdirAll(d, 0o755)
}

// LoadSettings reads the current EQ settings from ~/.config/aml/eq.json.
// Returns an empty Settings (no error) if the file does not exist.
func LoadSettings() (*Settings, error) {
	dir, err := configDir()
	if err != nil {
		return &Settings{}, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "eq.json"))
	if os.IsNotExist(err) {
		return &Settings{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("autoeq: read eq.json: %w", err)
	}
	var s Settings
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("autoeq: parse eq.json: %w", err)
	}
	return &s, nil
}

// SaveSettings writes s to ~/.config/aml/eq.json.
func SaveSettings(s *Settings) error {
	dir, err := configDir()
	if err != nil {
		return fmt.Errorf("autoeq: config dir: %w", err)
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "eq.json"), raw, 0o644)
}

// FFmpegChain returns the FFmpeg -af filter fragment for the current EQ settings.
// Returns "" when no bands are set.
func (s *Settings) FFmpegChain() string {
	if len(s.Bands) == 0 {
		return ""
	}
	parts := make([]string, 0, len(s.Bands)+1)
	if s.Preamp != 0 {
		parts = append(parts, fmt.Sprintf("volume=%.2fdB", s.Preamp))
	}
	typeMap := map[string]string{"PK": "equalizer", "LSC": "lowshelf", "HSC": "highshelf"}
	for _, b := range s.Bands {
		if !b.Enabled {
			continue
		}
		filter, ok := typeMap[strings.ToUpper(b.Type)]
		if !ok {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=f=%.0f:t=q:w=%.4f:g=%.2f",
			filter, b.Freq, b.Q, b.Gain))
	}
	return strings.Join(parts, ",")
}

// indexVariant is one measurement variant from the autoeq.app /entries response.
// The response is map[name][]indexVariant. Rig can be null in the JSON.
type indexVariant struct {
	Form   string  `json:"form"`
	Rig    *string `json:"rig"`
	Source string  `json:"source"`
}

// TargetCompat is a source/form/rig combination compatible with a target curve.
type TargetCompat struct {
	Source string `json:"source"`
	Form   string `json:"form"`
	Rig    string `json:"rig,omitempty"`
}

// TargetEntry is one target curve available from autoeq.app.
type TargetEntry struct {
	Label      string         `json:"label"`
	Compatible []TargetCompat `json:"compatible"`
}

type targetRaw struct {
	Label      string `json:"label"`
	Compatible []struct {
		Source string  `json:"source"`
		Form   string  `json:"form"`
		Rig    *string `json:"rig"`
	} `json:"compatible"`
}

// FetchTargets fetches the list of available target curves from autoeq.app/targets.
// Results are cached at ~/.cache/aml/autoeq/targets.json for 24 hours.
func FetchTargets(ctx context.Context) ([]TargetEntry, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}
	cachePath := filepath.Join(dir, "targets.json")
	if fi, err := os.Stat(cachePath); err == nil && time.Since(fi.ModTime()) < 24*time.Hour {
		if raw, err := os.ReadFile(cachePath); err == nil {
			var targets []TargetEntry
			if json.Unmarshal(raw, &targets) == nil && len(targets) > 0 {
				return targets, nil
			}
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://autoeq.app/targets", nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("autoeq: fetch targets: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("autoeq: targets HTTP %d", resp.StatusCode)
	}

	var raw []targetRaw
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("autoeq: parse targets: %w", err)
	}

	targets := make([]TargetEntry, 0, len(raw))
	for _, t := range raw {
		compat := make([]TargetCompat, 0, len(t.Compatible))
		for _, c := range t.Compatible {
			rig := ""
			if c.Rig != nil {
				rig = *c.Rig
			}
			compat = append(compat, TargetCompat{Source: c.Source, Form: c.Form, Rig: rig})
		}
		targets = append(targets, TargetEntry{Label: t.Label, Compatible: compat})
	}

	if out, err := json.Marshal(targets); err == nil {
		os.WriteFile(cachePath, out, 0o644) //nolint:errcheck
	}
	return targets, nil
}

// FetchIndex fetches the AutoEQ headphone model list from autoeq.app/entries.
// Results are cached at ~/.cache/aml/autoeq/index.json for 24 hours.
func FetchIndex(ctx context.Context) ([]Model, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}
	indexPath := filepath.Join(dir, "index.json")

	// Return cached copy if fresh.
	if fi, err := os.Stat(indexPath); err == nil && time.Since(fi.ModTime()) < 24*time.Hour {
		if raw, err := os.ReadFile(indexPath); err == nil {
			var models []Model
			if json.Unmarshal(raw, &models) == nil && len(models) > 0 {
				return models, nil
			}
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://autoeq.app/entries", nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("autoeq: fetch index: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("autoeq: index HTTP %d", resp.StatusCode)
	}

	// Response: {"headphone name": [{form, rig, source}, ...], ...}
	var raw map[string][]indexVariant
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("autoeq: parse index: %w", err)
	}

	models := make([]Model, 0, len(raw)*2)
	for name, variants := range raw {
		for _, v := range variants {
			rig := ""
			if v.Rig != nil {
				rig = *v.Rig
			}
			models = append(models, Model{Name: name, Source: v.Source, Rig: rig, Form: v.Form})
		}
	}

	// Cache to disk.
	if out, err := json.Marshal(models); err == nil {
		os.WriteFile(indexPath, out, 0o644) //nolint:errcheck
	}
	log.Printf("[autoeq] fetched index: %d models", len(models))
	return models, nil
}

// equalizeFilterResult is one filter entry in the parametric_eq API response.
type equalizeFilterResult struct {
	Type string  `json:"type"` // "LOW_SHELF" | "PEAKING" | "HIGH_SHELF"
	Fc   float64 `json:"fc"`
	Q    float64 `json:"q"`
	Gain float64 `json:"gain"`
}

// equalizePEQResult is the parametric_eq field in the /equalize API response.
type equalizePEQResult struct {
	FS      int                    `json:"fs"`
	Filters []equalizeFilterResult `json:"filters"`
	Preamp  float64                `json:"preamp"`
}


var apiTypeMap = map[string]string{
	"LOW_SHELF":  "LSC",
	"HIGH_SHELF": "HSC",
	"PEAKING":    "PK",
}

// FetchBands fetches optimized parametric EQ bands for the given model from the
// autoeq.app /equalize API. Results are cached at ~/.cache/aml/autoeq/<slug>_bands.json.
// If target is empty or incompatible, DefaultTarget(form) is used automatically.
func FetchBands(ctx context.Context, source, form, name, rig, target string) (*Settings, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}
	if target == "" {
		target = DefaultTarget(form)
	}
	tryCache := func(t string) *Settings {
		slug := slugify(source+"_"+name+"_"+t) + "_bands.json"
		if raw, err := os.ReadFile(filepath.Join(dir, slug)); err == nil {
			var s Settings
			if json.Unmarshal(raw, &s) == nil && len(s.Bands) > 0 {
				return &s
			}
		}
		return nil
	}
	if s := tryCache(target); s != nil {
		return s, nil
	}

	result, usedTarget, err := postEqualize(ctx, equalizeRequest{
		Name: name, Source: source, Rig: rig, Target: target,
		SoundSignature: nil, SoundSignatureSmoothingWindow: 1,
		BassBoostGain: 0, BassBoostFc: 105, BassBoostQ: 0.7,
		TrebleBoostGain: 0, TrebleBoostFc: 10000, TrebleBoostQ: 0.7,
		Tilt: 0, FS: 48000, BitDepth: 16, Phase: "minimum",
		FRes: 16, Preamp: 0, MaxGain: 12, MaxSlope: 18,
		WindowSize: 0.08, TrebleWindowSize: 2,
		TrebleFLower: 6000, TrebleFUpper: 8000, TrebleGainK: 1,
		GraphicEQ: false, ParametricEQ: true, FixedBandEQ: false, ConvolutionEQ: false,
		Response: equalizeResponse{FrFStep: 1.02, FrFields: []string{}, Base64Fp16: false},
	}, form)
	if err != nil {
		return nil, err
	}

	if usedTarget != target {
		if s := tryCache(usedTarget); s != nil {
			return s, nil
		}
	}

	if result.ParametricEQ == nil || len(result.ParametricEQ.Filters) == 0 {
		return nil, fmt.Errorf("autoeq: no parametric EQ in response for %s", name)
	}

	s := &Settings{Preamp: result.ParametricEQ.Preamp}
	for _, f := range result.ParametricEQ.Filters {
		typ, ok := apiTypeMap[f.Type]
		if !ok {
			typ = "PK"
		}
		s.Bands = append(s.Bands, Band{
			Type:    typ,
			Freq:    f.Fc,
			Gain:    f.Gain,
			Q:       f.Q,
			Enabled: true,
		})
	}

	slug := slugify(source+"_"+name+"_"+usedTarget) + "_bands.json"
	if out, err := json.Marshal(s); err == nil {
		os.WriteFile(filepath.Join(dir, slug), out, 0o644) //nolint:errcheck
	}
	return s, nil
}

// parseAPO parses EqualizerAPO parametric EQ text format.
func parseAPO(text string) (*Settings, error) {
	s := &Settings{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := scanner.Text()
		if m := preampRe.FindStringSubmatch(line); m != nil {
			s.Preamp, _ = strconv.ParseFloat(m[1], 64)
		} else if m := filterRe.FindStringSubmatch(line); m != nil {
			freq, _ := strconv.ParseFloat(m[2], 64)
			gain, _ := strconv.ParseFloat(m[3], 64)
			q, _ := strconv.ParseFloat(m[4], 64)
			s.Bands = append(s.Bands, Band{
				Type:    strings.ToUpper(m[1]),
				Freq:    freq,
				Gain:    gain,
				Q:       q,
				Enabled: true,
			})
		}
	}
	if len(s.Bands) == 0 {
		return nil, fmt.Errorf("autoeq: no filter bands found in response")
	}
	return s, nil
}

// ExportAPO returns the EQ settings in EqualizerAPO text format.
func ExportAPO(s *Settings) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Preamp: %.1f dB\n", s.Preamp)
	typeLabel := map[string]string{"PK": "PK", "LSC": "LSC", "HSC": "HSC"}
	for i, b := range s.Bands {
		on := "ON"
		if !b.Enabled {
			on = "OFF"
		}
		lbl := typeLabel[strings.ToUpper(b.Type)]
		if lbl == "" {
			lbl = "PK"
		}
		fmt.Fprintf(&sb, "Filter %d: %s %s Fc %.0f Hz Gain %.1f dB Q %.2f\n",
			i+1, on, lbl, b.Freq, b.Gain, b.Q)
	}
	return sb.String()
}

// FRPoint is a single frequency-response measurement point.
type FRPoint struct {
	Freq float64 `json:"freq"`
	Gain float64 `json:"gain"`
}

// FRData holds the original (smoothed) and corrected (equalized_smoothed) FR curves.
type FRData struct {
	Original  []FRPoint `json:"original"`
	Corrected []FRPoint `json:"corrected"`
}

// equalizeRequest is the minimal body sent to autoeq.app/equalize.
type equalizeRequest struct {
	Name                          string          `json:"name"`
	Source                        string          `json:"source"`
	Rig                           string          `json:"rig,omitempty"`
	Target                        string          `json:"target"`
	SoundSignature                interface{}     `json:"sound_signature"`
	SoundSignatureSmoothingWindow float64         `json:"sound_signature_smoothing_window_size"`
	BassBoostGain                 float64         `json:"bass_boost_gain"`
	BassBoostFc                   float64         `json:"bass_boost_fc"`
	BassBoostQ                    float64         `json:"bass_boost_q"`
	TrebleBoostGain               float64         `json:"treble_boost_gain"`
	TrebleBoostFc                 float64         `json:"treble_boost_fc"`
	TrebleBoostQ                  float64         `json:"treble_boost_q"`
	Tilt                          float64         `json:"tilt"`
	FS                            int             `json:"fs"`
	BitDepth                      int             `json:"bit_depth"`
	Phase                         string          `json:"phase"`
	FRes                          int             `json:"f_res"`
	Preamp                        float64         `json:"preamp"`
	MaxGain                       float64         `json:"max_gain"`
	MaxSlope                      float64         `json:"max_slope"`
	WindowSize                    float64         `json:"window_size"`
	TrebleWindowSize              float64         `json:"treble_window_size"`
	TrebleFLower                  float64         `json:"treble_f_lower"`
	TrebleFUpper                  float64         `json:"treble_f_upper"`
	TrebleGainK                   float64         `json:"treble_gain_k"`
	GraphicEQ                     bool            `json:"graphic_eq"`
	ParametricEQ                  bool            `json:"parametric_eq"`
	FixedBandEQ                   bool            `json:"fixed_band_eq"`
	ConvolutionEQ                 bool            `json:"convolution_eq"`
	Response                      equalizeResponse `json:"response"`
}

type equalizeResponse struct {
	FrFStep    float64  `json:"fr_f_step"`
	FrFields   []string `json:"fr_fields"`
	Base64Fp16 bool     `json:"base64fp16"`
}

type equalizeResult struct {
	FR           json.RawMessage    `json:"fr"`
	ParametricEQ *equalizePEQResult `json:"parametric_eq"`
}

// postEqualize POSTs to autoeq.app/equalize with the given request.
// If the response is non-200 and the target differs from DefaultTarget(form),
// it retries automatically with the default target.
func postEqualize(ctx context.Context, req equalizeRequest, form string) (*equalizeResult, string, error) {
	doPost := func(r equalizeRequest) (*equalizeResult, error) {
		body, err := json.Marshal(r)
		if err != nil {
			return nil, err
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://autoeq.app/equalize", strings.NewReader(string(body)))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Origin", "https://autoeq.app")
		resp, err := httpClient.Do(httpReq)
		if err != nil {
			return nil, fmt.Errorf("equalize request: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		var result equalizeResult
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("decode: %w", err)
		}
		return &result, nil
	}

	result, err := doPost(req)
	if err == nil {
		return result, req.Target, nil
	}
	// Retry with the default target for this form factor
	def := DefaultTarget(form)
	if req.Target == def {
		return nil, req.Target, fmt.Errorf("autoeq: equalize %s: %w", req.Name, err)
	}
	log.Printf("[autoeq] target %q failed for %s, retrying with %q: %v", req.Target, req.Name, def, err)
	req.Target = def
	result, err2 := doPost(req)
	if err2 != nil {
		return nil, def, fmt.Errorf("autoeq: equalize %s (default target): %w", req.Name, err2)
	}
	return result, def, nil
}

// DefaultTarget returns the default Harman target for the given headphone form factor.
func DefaultTarget(form string) string {
	if strings.EqualFold(form, "in-ear") {
		return "Harman in-ear 2019"
	}
	return "Harman over-ear 2018"
}

// FetchFR fetches raw and equalized frequency-response data for the given model
// from the autoeq.app /equalize API. Returns FRData with Original (smoothed) and
// Corrected (equalized_smoothed) curves.
// Results are cached at ~/.cache/aml/autoeq/<slug>_<targslug>_fr.json.
// If target is empty or incompatible, DefaultTarget(form) is used automatically.
func FetchFR(ctx context.Context, source, form, name, rig, target string) (*FRData, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}
	if target == "" {
		target = DefaultTarget(form)
	}
	if d := fetchFRFromCache(dir, source, name, target); d != nil {
		return d, nil
	}

	result, usedTarget, err := postEqualize(ctx, equalizeRequest{
		Name: name, Source: source, Rig: rig, Target: target,
		SoundSignature: nil, SoundSignatureSmoothingWindow: 1,
		BassBoostGain: 0, BassBoostFc: 105, BassBoostQ: 0.7,
		TrebleBoostGain: 0, TrebleBoostFc: 10000, TrebleBoostQ: 0.7,
		Tilt: 0, FS: 48000, BitDepth: 16, Phase: "minimum",
		FRes: 16, Preamp: 0, MaxGain: 12, MaxSlope: 18,
		WindowSize: 0.08, TrebleWindowSize: 2,
		TrebleFLower: 6000, TrebleFUpper: 8000, TrebleGainK: 1,
		GraphicEQ: false, ParametricEQ: false, FixedBandEQ: false, ConvolutionEQ: false,
		Response: equalizeResponse{FrFStep: 1.02, FrFields: []string{"frequency", "smoothed", "equalized_smoothed"}, Base64Fp16: true},
	}, form)
	if err != nil {
		return nil, err
	}

	if usedTarget != target {
		if d := fetchFRFromCache(dir, source, name, usedTarget); d != nil {
			return d, nil
		}
	}

	var frMap map[string]string
	if err := json.Unmarshal(result.FR, &frMap); err != nil {
		return nil, fmt.Errorf("autoeq: decode fr map: %w", err)
	}
	freqB64, ok1 := frMap["frequency"]
	smoothB64, ok2 := frMap["smoothed"]
	eqB64 := frMap["equalized_smoothed"] // may be absent if API doesn't return it
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("autoeq: response missing frequency/smoothed for %s", name)
	}

	freqBytes, err := decodeBase64(freqB64)
	if err != nil {
		return nil, fmt.Errorf("autoeq: decode frequency: %w", err)
	}
	smoothBytes, err := decodeBase64(smoothB64)
	if err != nil {
		return nil, fmt.Errorf("autoeq: decode smoothed: %w", err)
	}
	original, err := decodeFRCurve(freqBytes, smoothBytes)
	if err != nil {
		return nil, fmt.Errorf("autoeq: original: %w", err)
	}
	if len(original) == 0 {
		return nil, fmt.Errorf("autoeq: no valid FR points for %s", name)
	}

	var corrected []FRPoint
	if eqB64 != "" {
		eqBytes, err := decodeBase64(eqB64)
		if err == nil {
			corrected, _ = decodeFRCurve(freqBytes, eqBytes)
		}
	}

	d := &FRData{Original: original, Corrected: corrected}
	slug := slugify(source+"_"+name+"_"+usedTarget) + "_fr.json"
	if out, err := json.Marshal(d); err == nil {
		os.WriteFile(filepath.Join(dir, slug), out, 0o644) //nolint:errcheck
	}
	return d, nil
}

// fetchFRFromCache loads a cached FRData for the given model+target, or returns nil.
func fetchFRFromCache(dir, source, name, target string) *FRData {
	slug := slugify(source+"_"+name+"_"+target) + "_fr.json"
	raw, err := os.ReadFile(filepath.Join(dir, slug))
	if err != nil {
		return nil
	}
	var d FRData
	if json.Unmarshal(raw, &d) == nil && len(d.Original) > 0 {
		return &d
	}
	return nil
}

// decodeFRCurve builds FRPoints from paired float16 frequency and gain byte slices.
func decodeFRCurve(freqBytes, gainBytes []byte) ([]FRPoint, error) {
	n := len(freqBytes) / 2
	if n == 0 || len(gainBytes)/2 != n {
		return nil, fmt.Errorf("mismatched lengths freq=%d gain=%d", len(freqBytes), len(gainBytes))
	}
	pts := make([]FRPoint, 0, n)
	for i := 0; i < n; i++ {
		f := float64(f16ToF32(uint16(freqBytes[i*2]) | uint16(freqBytes[i*2+1])<<8))
		g := float64(f16ToF32(uint16(gainBytes[i*2]) | uint16(gainBytes[i*2+1])<<8))
		if f >= 20 && f <= 20000 {
			pts = append(pts, FRPoint{Freq: f, Gain: g})
		}
	}
	return pts, nil
}

// f16ToF32 converts an IEEE 754 half-precision float16 (little-endian uint16) to float32.
func f16ToF32(h uint16) float32 {
	sign := uint32(h&0x8000) << 16
	exp := uint32(h&0x7C00) >> 10
	mant := uint32(h & 0x03FF)
	var bits uint32
	switch exp {
	case 0:
		if mant == 0 {
			bits = sign
		} else {
			exp = 1
			for mant&0x0400 == 0 {
				mant <<= 1
				exp--
			}
			mant &= 0x03FF
			bits = sign | (exp+127-15)<<23 | mant<<13
		}
	case 31:
		bits = sign | 0x7F800000 | mant<<13
	default:
		bits = sign | (exp+127-15)<<23 | mant<<13
	}
	return math.Float32frombits(bits)
}

func decodeBase64(s string) ([]byte, error) {
	// autoeq.app uses standard base64
	return base64.StdEncoding.DecodeString(s)
}

func slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	return b.String()
}
