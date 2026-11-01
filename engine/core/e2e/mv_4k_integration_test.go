package e2e

// mv_4k_integration_test.go — live check of 4K-class music video playback through the engine's own functions.
//
// Skipped unless AM_TEST_TOKEN and AM_TEST_MUT are set (the same credentials as integration_test.go).
//
//	AM_TEST_TOKEN         developer token, without the "Bearer " prefix
//	AM_TEST_MUT           Media User Token (x-apple-music-user-token)
//
// Optional:
//
//	AM_TEST_MV_IDS        comma-separated music-video Adam IDs (default: four whose master playlists offered 4K-class
//	                      heights in past logs)
//	AM_TEST_STOREFRONT    storefront code (default "us")
//	AM_TEST_CBCS_ADDR     FairPlay socket address, only used to build the provider
//	AM_TEST_MV_REQUIRE_4K set to 1 to fail when the selected variant is below 4K class
//
// Run:
//
//	AM_TEST_TOKEN=... AM_TEST_MUT=... go test ./core/e2e -run MV4K -v -timeout 300s
//
// For each ID it asks the engine for the video at a 2160 ceiling and reports: the variant heights Apple offered, the
// variant chosen and its codec, whether the key request and decryption succeeded (so whether the stream needed
// anything beyond the Widevine path), and what the decrypted init segment and first samples look like. It cannot say
// whether Electron on a given machine can decode HEVC; that is a player question.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/itouakirai/mp4ff/mp4"

	"engine/core/apple"
	"engine/core/fairplay"
	"engine/core/pipeline"
	"engine/core/playback"
	"engine/utils/mvlabel"
)

// Music videos whose master playlists listed heights up to ~1600-1660 (3840 wide) in past engine logs.
var defaultMV4KIDs = []string{"1635027392", "1648127675", "1659004934", "1658776333"}

const mvSampleCap = 6 << 20 // bytes of decrypted video to collect before stopping

var errMVCapReached = errors.New("sample cap reached")

// capWriter collects up to cap bytes, then fails the write so the stream stops early.
type capWriter struct {
	buf bytes.Buffer
	cap int
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.cap - w.buf.Len()
	if room <= 0 {
		return 0, errMVCapReached
	}
	if len(p) > room {
		w.buf.Write(p[:room])
		return room, errMVCapReached
	}
	return w.buf.Write(p)
}

type mv4kReport struct {
	AdamID         string   `json:"adamID"`
	Offered        []int    `json:"offeredHeights"`
	ChosenLabel    string   `json:"chosenResolution"`
	CodecString    string   `json:"codec"`
	IsHEVC         bool     `json:"hevc"`
	CatalogDurMs   int      `json:"reportedDurationMs"`
	StreamedBytes  int      `json:"streamedBytes"`
	InitFound      bool     `json:"initSegment"`
	SampleEntry    string   `json:"sampleEntry,omitempty"`
	TrackWidth     int      `json:"trackWidth,omitempty"`
	TrackHeight    int      `json:"trackHeight,omitempty"`
	Fragments      int      `json:"fragments"`
	FirstSampleOK  bool     `json:"firstSamplePlausible"`
	FirstSampleNAL string   `json:"firstSampleNAL,omitempty"`
	Notes          []string `json:"notes,omitempty"`
}

func TestIntegration_MV4K(t *testing.T) {
	token := os.Getenv("AM_TEST_TOKEN")
	mut := os.Getenv("AM_TEST_MUT")
	if token == "" || mut == "" {
		t.Skip("MV 4K integration test requires AM_TEST_TOKEN and AM_TEST_MUT")
	}
	sf := os.Getenv("AM_TEST_STOREFRONT")
	if sf == "" {
		sf = "us"
	}
	cbcsAddr := os.Getenv("AM_TEST_CBCS_ADDR")
	if cbcsAddr == "" {
		cbcsAddr = "127.0.0.1:10020"
	}
	ids := defaultMV4KIDs
	if v := strings.TrimSpace(os.Getenv("AM_TEST_MV_IDS")); v != "" {
		ids = nil
		for _, id := range strings.Split(v, ",") {
			if id = strings.TrimSpace(id); id != "" {
				ids = append(ids, id)
			}
		}
	}
	require4K := os.Getenv("AM_TEST_MV_REQUIRE_4K") == "1"

	mgr := playback.NewWithProvider(apple.NewProviderWithCBCS(fairplay.DialerFromAddr(cbcsAddr), nil))
	var reports []mv4kReport
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			rep := probeMV4K(t, mgr, id, sf, token, mut)
			reports = append(reports, rep)
			t.Logf("%s: offered=%v chosen=%s codec=%s hevc=%v entry=%s track=%dx%d bytes=%d fragments=%d firstSample=%v(%s)",
				id, rep.Offered, rep.ChosenLabel, rep.CodecString, rep.IsHEVC, rep.SampleEntry,
				rep.TrackWidth, rep.TrackHeight, rep.StreamedBytes, rep.Fragments, rep.FirstSampleOK, rep.FirstSampleNAL)
			for _, n := range rep.Notes {
				t.Logf("%s: note: %s", id, n)
			}
			if require4K && rep.TrackHeight < 1500 {
				t.Errorf("%s: selected variant is %dx%d, below 4K class", id, rep.TrackWidth, rep.TrackHeight)
			}
		})
	}
	if len(reports) > 0 {
		out, _ := json.MarshalIndent(map[string]any{
			"date":    time.Now().Format("2006-01-02"),
			"ceiling": 2160,
			"results": reports,
		}, "", "  ")
		writeArtifact(t, "mv-4k", fmt.Sprintf("mv-4k-%s.json", time.Now().Format("2006-01-02")), out)
	}
}

func probeMV4K(t *testing.T, mgr *playback.Manager, id, sf, token, mut string) mv4kReport {
	t.Helper()
	rep := mv4kReport{AdamID: id}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	sess, err := mgr.Open(ctx, playback.OpenRequest{
		AssetID: id, Storefront: sf, Token: token, MUT: mut, Video: true, MVMaxHeight: 2160,
	})
	if err != nil {
		t.Fatalf("Open %s at a 2160 ceiling: %v", id, err)
	}
	defer mgr.Release(sess.ID)

	rep.Offered = sess.VideoHeights
	rep.CodecString = sess.Capabilities.VideoCodec
	rep.IsHEVC = strings.Contains(rep.CodecString, "hvc1") || strings.Contains(rep.CodecString, "hev1")
	rep.CatalogDurMs = sess.DurationMs
	rep.ChosenLabel = mvlabel.Get()
	if !sess.Capabilities.Video {
		t.Fatalf("session has no video stream")
	}

	w := &capWriter{cap: mvSampleCap}
	err = mgr.Stream(ctx, sess.ID, pipeline.KindVideo, w)
	if err != nil && !errors.Is(err, errMVCapReached) {
		// A key or decrypt failure lands here: it is the answer to whether this variant needs more than the
		// Widevine path.
		rep.Notes = append(rep.Notes, "stream failed: "+err.Error())
		t.Errorf("Stream video %s: %v", id, err)
	}
	data := w.buf.Bytes()
	rep.StreamedBytes = len(data)
	if len(data) == 0 {
		t.Fatalf("no video bytes came back")
	}
	inspectFMP4(&rep, data)
	if !rep.InitFound {
		t.Errorf("no init segment (ftyp/moov) in the decrypted output")
	}
	if rep.Fragments == 0 {
		t.Errorf("no moof fragments in the first %d bytes", len(data))
	}
	if !rep.FirstSampleOK {
		t.Errorf("first sample does not look like decrypted video (%s): the key may be wrong", rep.FirstSampleNAL)
	}
	return rep
}

// inspectFMP4 walks the top-level boxes of a possibly truncated fragmented MP4.
func inspectFMP4(rep *mv4kReport, data []byte) {
	r := bytes.NewReader(data)
	var pos uint64
	var lastMdat []byte
	var firstMdatChecked bool
	for {
		box, err := mp4.DecodeBox(pos, r)
		if err != nil {
			break // truncated tail
		}
		switch b := box.(type) {
		case *mp4.MoovBox:
			rep.InitFound = true
			if b.Trak != nil {
				if b.Trak.Tkhd != nil {
					rep.TrackWidth = int(b.Trak.Tkhd.Width >> 16)
					rep.TrackHeight = int(b.Trak.Tkhd.Height >> 16)
				}
				if b.Trak.Mdia != nil && b.Trak.Mdia.Minf != nil && b.Trak.Mdia.Minf.Stbl != nil && b.Trak.Mdia.Minf.Stbl.Stsd != nil {
					stsd := b.Trak.Mdia.Minf.Stbl.Stsd
					switch {
					case stsd.HvcX != nil:
						rep.SampleEntry = stsd.HvcX.Type()
					case stsd.AvcX != nil:
						rep.SampleEntry = stsd.AvcX.Type()
					}
				}
			}
		case *mp4.MoofBox:
			rep.Fragments++
		case *mp4.MdatBox:
			if !firstMdatChecked {
				firstMdatChecked = true
				lastMdat = b.Data
			}
		}
		pos += box.Size()
		if _, err := r.Seek(int64(pos), 0); err != nil {
			break
		}
	}
	if len(lastMdat) >= 5 {
		// Length-prefixed NAL units: a 4-byte length, then a NAL header whose forbidden bit is clear. Ciphertext
		// almost never passes this.
		n := int(lastMdat[0])<<24 | int(lastMdat[1])<<16 | int(lastMdat[2])<<8 | int(lastMdat[3])
		h := lastMdat[4]
		var kind int
		if rep.IsHEVC {
			kind = int(h>>1) & 0x3f
			rep.FirstSampleOK = h&0x80 == 0 && kind <= 40
			rep.FirstSampleNAL = fmt.Sprintf("hevc nal type %d, length %d", kind, n)
		} else {
			kind = int(h) & 0x1f
			rep.FirstSampleOK = h&0x80 == 0 && kind >= 1 && kind <= 23
			rep.FirstSampleNAL = fmt.Sprintf("avc nal type %d, length %d", kind, n)
		}
		if n <= 0 || n > len(lastMdat) {
			rep.FirstSampleOK = false
		}
	} else {
		rep.FirstSampleNAL = "no mdat data in the sample"
	}
}
