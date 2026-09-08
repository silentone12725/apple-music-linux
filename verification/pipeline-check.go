//go:build ignore

// pipeline-check.go — MV pipeline end-to-end validation tool.
//
// Usage:
//
//	go run verification/pipeline-check.go \
//	    -asset <adamID>   \
//	    -token <devJWT>   \
//	    -mut   <Music-User-Token>
//
// Flags:
//
//	-asset      Apple Music video adam ID (required)
//	-base       Engine base URL (default http://localhost:10767)
//	-token      Apple Music developer JWT (optional if engine already has one)
//	-mut        Music-User-Token cookie value (optional if engine already has one)
//	-maxheight  Maximum video height to request (default 1080)
//	-out        Output directory for captured files (default ./pipeline-out)
//	-sf         Storefront (default us)
//
// The tool runs each pipeline stage in order and validates it with ffprobe:
//
//	Stage 0: POST /api/v1/playback  — session open; logs quality tiers
//	Stage 1: /video-raw             — raw decrypted multi-track fMP4
//	Stage 2: /video                 — FFmpeg-remuxed single-track fMP4
//
// Each stage writes a .mp4 file to -out, runs ffprobe on it, and reports
// whether the file is valid MP4, what tracks it contains, and any errors.
// Exit code 0 means all stages passed; non-zero means at least one failed.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	fAsset     = flag.String("asset", "", "Apple Music video adam ID (required)")
	fBase      = flag.String("base", "http://localhost:10767", "Engine base URL")
	fToken     = flag.String("token", "", "Apple Music developer JWT")
	fMUT       = flag.String("mut", "", "Music-User-Token")
	fMaxHeight = flag.Int("maxheight", 1080, "Maximum video height to request")
	fOut       = flag.String("out", "./pipeline-out", "Output directory for captured files")
	fSF        = flag.String("sf", "us", "Storefront")
)

type playbackReq struct {
	AssetID     string       `json:"assetId"`
	Storefront  string       `json:"storefront"`
	Token       string       `json:"token,omitempty"`
	MUT         string       `json:"mediaUserToken,omitempty"`
	MVMaxHeight int          `json:"mvMaxHeight"`
	Capabilities capReq      `json:"capabilities"`
}

type capReq struct {
	Audio  bool `json:"audio"`
	Video  bool `json:"video"`
	Lossless bool `json:"lossless"`
}

func main() {
	flag.Parse()
	if *fAsset == "" {
		log.Fatal("-asset is required")
	}

	if err := os.MkdirAll(*fOut, 0755); err != nil {
		log.Fatalf("mkdir %s: %v", *fOut, err)
	}

	var failures []string

	// ── Stage 0: open session ─────────────────────────────────────────────────
	fmt.Println("\n══ Stage 0: POST /api/v1/playback (session open) ══")
	sess, sessionID, err := openSession()
	if err != nil {
		log.Fatalf("Stage 0 FAILED — cannot continue: %v", err)
	}
	printJSON("session", sess)

	if heights, ok := sess["videoHeights"]; ok {
		fmt.Printf("[quality] Available heights: %v\n", heights)
	}
	if maxH, ok := sess["mvMaxHeight"]; ok {
		fmt.Printf("[quality] Selected maxHeight: %v\n", maxH)
	}
	if codec, ok := sess["capabilities"].(map[string]any); ok {
		fmt.Printf("[quality] Video codec string: %v\n", codec["videoCodec"])
	}

	// ── Stage 1: raw decrypted fMP4 ───────────────────────────────────────────
	fmt.Println("\n══ Stage 1: /video-raw (raw decrypted multi-track fMP4) ══")
	rawFile := filepath.Join(*fOut, "stage1-raw.mp4")
	rawErr := downloadStream(sessionID, "video-raw", rawFile)
	if rawErr != nil {
		fmt.Printf("[FAIL] Stage 1 download: %v\n", rawErr)
		failures = append(failures, "Stage 1 download: "+rawErr.Error())
	} else {
		if err := probeFile("Stage 1 (raw)", rawFile); err != nil {
			failures = append(failures, "Stage 1 ffprobe: "+err.Error())
		}
	}

	// ── Stage 2: FFmpeg-remuxed fMP4 ─────────────────────────────────────────
	fmt.Println("\n══ Stage 2: /video (FFmpeg-remuxed single-track fMP4) ══")
	remuxFile := filepath.Join(*fOut, "stage2-remux.mp4")
	remuxErr := downloadStream(sessionID, "video", remuxFile)
	if remuxErr != nil {
		fmt.Printf("[FAIL] Stage 2 download: %v\n", remuxErr)
		failures = append(failures, "Stage 2 download: "+remuxErr.Error())
	} else {
		if err := probeFile("Stage 2 (remux)", remuxFile); err != nil {
			failures = append(failures, "Stage 2 ffprobe: "+err.Error())
		}
	}

	// ── Summary ───────────────────────────────────────────────────────────────
	fmt.Println("\n══ Summary ══")
	if len(failures) == 0 {
		fmt.Println("ALL STAGES PASSED")
		fmt.Printf("Output files in %s\n", *fOut)
	} else {
		fmt.Printf("FAILURES (%d):\n", len(failures))
		for _, f := range failures {
			fmt.Printf("  • %s\n", f)
		}
		os.Exit(1)
	}
}

func openSession() (map[string]any, string, error) {
	body := playbackReq{
		AssetID:     *fAsset,
		Storefront:  *fSF,
		Token:       *fToken,
		MUT:         *fMUT,
		MVMaxHeight: *fMaxHeight,
		Capabilities: capReq{
			Audio: true,
			Video: true,
		},
	}
	b, _ := json.Marshal(body)
	resp, err := http.Post(*fBase+"/api/v1/playback", "application/json", bytes.NewReader(b))
	if err != nil {
		return nil, "", fmt.Errorf("POST /api/v1/playback: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		return nil, "", fmt.Errorf("POST /api/v1/playback status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var sess map[string]any
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, "", fmt.Errorf("decode session: %w", err)
	}
	id, _ := sess["sessionId"].(string)
	if id == "" {
		return nil, "", fmt.Errorf("session has no sessionId field")
	}
	return sess, id, nil
}

func downloadStream(sessionID, kind, outPath string) error {
	url := fmt.Sprintf("%s/api/v1/playback/%s/%s", *fBase, sessionID, kind)
	fmt.Printf("[download] %s → %s\n", url, outPath)
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return fmt.Errorf("copy after %d bytes: %w", n, err)
	}
	fmt.Printf("[download] wrote %d bytes\n", n)
	return nil
}

func probeFile(label, path string) error {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		fmt.Printf("[%s] ffprobe not found — skipping probe\n", label)
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	fmt.Printf("[%s] file size: %d bytes (%.1f MB)\n", label, info.Size(), float64(info.Size())/(1<<20))

	cmd := exec.Command(ffprobe,
		"-v", "error",
		"-show_streams",
		"-show_format",
		"-print_format", "json",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		// Print stderr for diagnosis
		if ee, ok := err.(*exec.ExitError); ok {
			fmt.Printf("[%s] ffprobe stderr:\n%s\n", label, string(ee.Stderr))
		}
		return fmt.Errorf("ffprobe: %w", err)
	}

	var probe struct {
		Streams []struct {
			Index     int    `json:"index"`
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Profile   string `json:"profile"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
			Size       string `json:"size"`
			BitRate    string `json:"bit_rate"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return fmt.Errorf("probe decode: %w", err)
	}

	fmt.Printf("[%s] format: %s  duration: %ss  bitrate: %s bps\n",
		label, probe.Format.FormatName, probe.Format.Duration, probe.Format.BitRate)
	if len(probe.Streams) == 0 {
		return fmt.Errorf("no streams found in file")
	}
	for _, s := range probe.Streams {
		if s.CodecType == "video" {
			fmt.Printf("[%s]   stream[%d] VIDEO  codec=%s  %dx%d  profile=%s\n",
				label, s.Index, s.CodecName, s.Width, s.Height, s.Profile)
		} else {
			fmt.Printf("[%s]   stream[%d] %s  codec=%s\n",
				label, s.Index, strings.ToUpper(s.CodecType), s.CodecName)
		}
	}
	fmt.Printf("[%s] PASS\n", label)
	return nil
}

func printJSON(label string, v any) {
	b, _ := json.MarshalIndent(v, "  ", "  ")
	fmt.Printf("[%s]\n  %s\n", label, string(b))
}
