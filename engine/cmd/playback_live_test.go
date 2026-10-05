//go:build native_backend && drmlive

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"engine/core/pipeline"
	"engine/core/playback"
	"engine/utils/ampapi"
)

// Live check of the real playback pipeline against Apple: open a session, stream it through the
// decrypt stages, then decode the result with FFmpeg. The tokens come from the engine's own state
// (the web developer token and the DRM session's media-user token) and are never printed.
//
// Opt-in: go test -tags "native_backend drmlive" -run TestPlaybackLive ./cmd
//
//	PLAY_ADAM      catalog id (song or music video)
//	PLAY_KIND      alac | aac | atmos | mv | mvaudio   (default alac; mv = the video stream,
//	               mvaudio = the audio stream of a music video)
//	PLAY_ADAM=auto with PLAY_KIND=atmos picks the first catalog search hit that has Dolby Atmos
//	PLAY_DRM_DIR   the drm directory (holds files/ and rootfs/)
//	PLAY_SF        storefront (default "in")
//	PLAY_MAXMB     stop after this many MiB of the stream (default: the whole stream)
//
// Set AML_VSEG_DRM to a directory whose rootfs/system/lib64 should be used instead of the
// default, to compare Android runtimes: the decrypted bytes must be identical.
func TestPlaybackLive(t *testing.T) {
	adam, drmDir := os.Getenv("PLAY_ADAM"), os.Getenv("PLAY_DRM_DIR")
	if adam == "" || drmDir == "" {
		t.Skip("PLAY_ADAM / PLAY_DRM_DIR not set")
	}
	kind := os.Getenv("PLAY_KIND")
	if kind == "" {
		kind = "alac"
	}
	sf := os.Getenv("PLAY_SF")
	if sf == "" {
		sf = "in"
	}
	maxBytes := int64(0)
	if v, err := strconv.Atoi(os.Getenv("PLAY_MAXMB")); err == nil && v > 0 {
		maxBytes = int64(v) << 20
	}

	s := NewAPIServer(0, ServerConfig{DRMBinaryPath: drmDir, DRMBaseDir: drmDir + "/files"})
	token, err := ampapi.GetToken()
	if err != nil || token == "" {
		t.Fatalf("developer token: %v", err)
	}
	if adam == "auto" && kind == "atmos" {
		var ferr error
		if adam, ferr = findAtmosSong(token, sf); ferr != nil {
			t.Skipf("no Atmos track found: %v", ferr)
		}
		t.Logf("using Atmos track %s", adam)
	}
	mut := s.mediaUserToken()
	if mut == "" {
		t.Fatal("no media-user token in the DRM session")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()

	t0 := time.Now()
	sess, err := s.pm.Open(ctx, playback.OpenRequest{
		AssetID: adam, Storefront: sf, Token: token, MUT: mut,
		Lossless: kind == "alac", Atmos: kind == "atmos", Video: kind == "mv" || kind == "mvaudio", Private: true,
	})
	if err != nil {
		t.Fatalf("open %s session: %v", kind, err)
	}
	defer s.pm.Release(sess.ID)
	t.Logf("opened in %s: codec=%q spatial=%q type=%s dur=%dms audio=%v video=%v",
		time.Since(t0).Truncate(time.Millisecond), sess.Codec, sess.SpatialAudio, sess.Type,
		sess.DurationMs, sess.Capabilities.Audio, sess.Capabilities.Video)

	streamKind := pipeline.KindAudio
	suffix := ".m4a"
	if kind == "mv" {
		streamKind, suffix = pipeline.KindVideo, ".mp4"
	}
	f, err := os.CreateTemp("", "playlive-*"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h := sha256.New()
	cw := &capWriter{w: io.MultiWriter(f, h), max: maxBytes}

	t1 := time.Now()
	err = s.pm.Stream(ctx, sess.ID, streamKind, cw)
	if err != nil && !errors.Is(err, errCapReached) {
		t.Fatalf("stream %s: %v", kind, err)
	}
	t.Logf("streamed %.1f MiB in %s (capped=%v)", float64(cw.n)/(1<<20), time.Since(t1).Truncate(time.Millisecond), errors.Is(err, errCapReached))
	t.Logf("SHA256 %s", hex.EncodeToString(h.Sum(nil)))
	if cw.n == 0 {
		t.Fatal("empty stream")
	}

	// A wrong key turns the media into noise, which the decoder rejects packet after packet.
	// An uncapped stream must decode cleanly; one cut at the byte cap ends mid-fragment, which
	// costs a handful of lines at the tail (a partial sample), so count errors instead of failing on the first; a wrong key produces hundreds.
	capped := errors.Is(err, errCapReached)
	out, derr := exec.Command("ffmpeg", "-v", "error", "-stats", "-i", f.Name(), "-f", "null", "-").CombinedOutput()
	errLines := 0
	for _, l := range strings.FieldsFunc(string(out), func(r rune) bool { return r == '\n' || r == '\r' }) {
		if l = strings.TrimSpace(l); l != "" && !strings.Contains(l, "time=") && !strings.HasPrefix(l, "size=") {
			errLines++
			if errLines <= 3 {
				t.Logf("ffmpeg: %s", l)
			}
		}
	}
	decoded := lastTime(string(out))
	t.Logf("ffmpeg decoded %.1f s of the %s stream, %d error line(s), capped=%v", decoded, kind, errLines, capped)
	if decoded < 3 {
		t.Fatalf("ffmpeg decoded only %.1f s: the stream is not valid media (exit: %v)", decoded, derr)
	}
	if capped && errLines > 10 {
		t.Fatalf("%d decode errors in a truncated stream: the decrypted data looks corrupt", errLines)
	}
	if !capped && (errLines != 0 || derr != nil) {
		t.Fatalf("ffmpeg could not decode the decrypted stream: %v (%d error lines)", derr, errLines)
	}
}

// lastTime returns the final "time=HH:MM:SS.xx" ffmpeg reported, in seconds.
func lastTime(out string) float64 {
	i := strings.LastIndex(out, "time=")
	if i < 0 || len(out) < i+13 {
		return 0
	}
	var h, m int
	var sec float64
	if _, err := fmt.Sscanf(out[i+5:i+13], "%d:%d:%f", &h, &m, &sec); err != nil {
		return 0
	}
	return float64(h)*3600 + float64(m)*60 + sec
}

var errCapReached = errors.New("byte cap reached")

type capWriter struct {
	w   io.Writer
	max int64
	n   int64
}

func (c *capWriter) Write(p []byte) (int, error) {
	if c.max > 0 && c.n+int64(len(p)) > c.max {
		p = p[:c.max-c.n]
		n, err := c.w.Write(p)
		c.n += int64(n)
		if err != nil {
			return n, err
		}
		return n, errCapReached
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// findAtmosSong returns the id of the first catalog search hit tagged with Dolby Atmos.
func findAtmosSong(token, sf string) (string, error) {
	u := "https://amp-api.music.apple.com/v1/catalog/" + sf + "/search?types=songs&limit=25&term=" + url.QueryEscape("dolby atmos")
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://music.apple.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var body struct {
		Results struct {
			Songs struct {
				Data []struct {
					ID         string `json:"id"`
					Attributes struct {
						AudioTraits []string `json:"audioTraits"`
					} `json:"attributes"`
				} `json:"data"`
			} `json:"songs"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	for _, d := range body.Results.Songs.Data {
		for _, tr := range d.Attributes.AudioTraits {
			if tr == "atmos" {
				return d.ID, nil
			}
		}
	}
	return "", errors.New("search returned no atmos-tagged song")
}
