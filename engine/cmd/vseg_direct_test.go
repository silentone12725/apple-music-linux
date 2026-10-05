package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"

	"engine/core/diskcache"
	"engine/core/media"
	"engine/core/pipeline"
	"engine/core/playback"
)

// directFixture is a clear fMP4 on a raw timeline offset by 10s from the playlist's.
type directFixture struct {
	init  []byte
	frags [][]byte // moof+mdat, one second each; frags[i] starts at raw 10+i
}

func newDirectFixture(t *testing.T, n int) directFixture {
	t.Helper()
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(24, "video", "und")
	var ib bytes.Buffer
	if err := init.Encode(&ib); err != nil {
		t.Fatal(err)
	}
	fx := directFixture{init: ib.Bytes()}
	for i := 0; i < n; i++ {
		frag, err := mp4.CreateFragment(uint32(i+1), 1)
		if err != nil {
			t.Fatal(err)
		}
		frag.AddFullSample(mp4.FullSample{
			Sample:     mp4.Sample{Flags: mp4.SyncSampleFlags, Dur: 24, Size: 6000},
			DecodeTime: uint64((10 + i) * 24),
			Data:       bytes.Repeat([]byte{byte(i + 1)}, 6000),
		})
		var fb bytes.Buffer
		if err := frag.Encode(&fb); err != nil {
			t.Fatal(err)
		}
		fx.frags = append(fx.frags, fb.Bytes())
	}
	return fx
}

type fakeVideoSource struct {
	fx       directFixture
	directOK bool
}

func (f *fakeVideoSource) stream(from int) pipeline.Source {
	return sourceFunc(func(_ context.Context, w io.Writer) error {
		if _, err := w.Write(f.fx.init); err != nil {
			return err
		}
		for _, fr := range f.fx.frags[from:] {
			if _, err := w.Write(fr); err != nil {
				return err
			}
		}
		return nil
	})
}
func (f *fakeVideoSource) Stream(ctx context.Context, w io.Writer) error {
	return f.stream(0).Stream(ctx, w)
}
func (f *fakeVideoSource) SourceFrom(startSec float64) (pipeline.Source, float64) {
	return f.stream(int(startSec)), float64(int(startSec))
}
func (f *fakeVideoSource) DirectSourceFrom(_ context.Context, startSec float64) (pipeline.Source, pipeline.DirectInfo, error) {
	if !f.directOK {
		return nil, pipeline.DirectInfo{}, io.ErrUnexpectedEOF
	}
	from := int(startSec)
	return f.stream(from), pipeline.DirectInfo{StartSec: float64(from), TsOffset: -10}, nil
}

type sourceFunc func(ctx context.Context, w io.Writer) error

func (s sourceFunc) Stream(ctx context.Context, w io.Writer) error { return s(ctx, w) }

type identityStage struct{}

func (identityStage) Process(_ context.Context, r io.Reader, w io.Writer) error {
	_, err := io.Copy(w, r)
	return err
}

type fakeProvider struct{ src *fakeVideoSource }

func (p fakeProvider) Open(_ context.Context, _ media.OpenRequest) (*media.Session, error) {
	return &media.Session{
		Kind: "mv",
		Tracks: []media.Track{{
			Kind: pipeline.KindVideo, CodecString: "avc1.640028",
			Open: func(context.Context) (*pipeline.Stream, error) {
				return &pipeline.Stream{Source: p.src, Stages: []pipeline.Stage{identityStage{}}, Kind: pipeline.KindVideo}, nil
			},
		}},
	}, nil
}

func newDirectTestServer(t *testing.T, src *fakeVideoSource) (*APIServer, string) {
	t.Helper()
	dc, err := diskcache.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &APIServer{pm: playback.NewWithProvider(fakeProvider{src}), diskCache: dc, shutdownCtx: ctx}
	sess, err := s.pm.Open(ctx, playback.OpenRequest{AssetID: "mv-test", Video: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopVsegSession(sess.ID) })
	return s, sess.ID
}

func vsegCall(t *testing.T, h http.HandlerFunc, id, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	req.SetPathValue("id", id)
	if strings.HasPrefix(target, "/seg/") {
		req.SetPathValue("n", strings.TrimPrefix(target, "/seg/"))
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestDirectSeekServesFragmentsWithoutFFmpeg(t *testing.T) {
	fx := newDirectFixture(t, 6)
	s, id := newDirectTestServer(t, &fakeVideoSource{fx: fx, directOK: true})

	rec := vsegCall(t, s.handlePlaybackVsegSeek, id, "/seek?t=2.4")
	if rec.Code != http.StatusOK {
		t.Fatalf("seek status %d: %s", rec.Code, rec.Body)
	}
	var resp struct {
		N        int     `json:"n"`
		T        float64 `json:"t"`
		Direct   bool    `json:"direct"`
		TsOffset float64 `json:"tsOffset"`
		Reinit   bool    `json:"reinit"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Direct || resp.N != 0 || resp.T != 2 || resp.TsOffset != -10 || !resp.Reinit {
		t.Fatalf("seek response = %+v, want direct n=0 t=2 tsOffset=-10 reinit=true", resp)
	}

	if got := vsegCall(t, s.handlePlaybackVsegInit, id, "/init").Body.Bytes(); !bytes.Equal(got, fx.init) {
		t.Fatalf("init = %d bytes, want the decrypted init (%d bytes)", len(got), len(fx.init))
	}
	for i := 0; i < 4; i++ { // fragments 2..5 of the fixture
		got := vsegCall(t, s.handlePlaybackVsegSeg, id, "/seg/"+strconv.Itoa(i))
		if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), fx.frags[2+i]) {
			t.Fatalf("seg/%d: status %d, %d bytes — want fixture fragment %d (%d bytes)",
				i, got.Code, got.Body.Len(), 2+i, len(fx.frags[2+i]))
		}
	}
	if got := vsegCall(t, s.handlePlaybackVsegSeg, id, "/seg/4"); got.Code != http.StatusNotFound {
		t.Fatalf("seg past the end: status %d, want 404 (the player's end-of-stream signal)", got.Code)
	}

	// A second direct seek keeps the init kind: no re-append needed.
	rec = vsegCall(t, s.handlePlaybackVsegSeek, id, "/seek?t=4.1")
	var again struct {
		Direct bool `json:"direct"`
		Reinit bool `json:"reinit"`
		T      float64
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &again); err != nil {
		t.Fatal(err)
	}
	if !again.Direct || again.Reinit || again.T != 4 {
		t.Fatalf("second seek = %+v, want direct, reinit=false, t=4", again)
	}
	if got := vsegCall(t, s.handlePlaybackVsegSeg, id, "/seg/0"); !bytes.Equal(got.Body.Bytes(), fx.frags[4]) {
		t.Fatal("second direct session did not start at fragment 4")
	}
}

func TestVsegCodecIsCopyable(t *testing.T) {
	for codec, want := range map[string]bool{
		"avc1.640028": true, "avc1.64001f,mp4a.40.2": true, "avc3.640028": true,
		"hvc1.2.4.L123.B0": false, "hev1.1.6.L93.B0": false, "": false,
	} {
		if got := vsegCodecIsCopyable(codec); got != want {
			t.Errorf("vsegCodecIsCopyable(%q) = %v, want %v", codec, got, want)
		}
	}
}

func TestDirectSeekDisabledByRequestOrEnv(t *testing.T) {
	r := httptest.NewRequest("GET", "/seek?t=1", nil)
	if !directSeekEnabled(r) {
		t.Fatal("direct seek should be on by default")
	}
	if directSeekEnabled(httptest.NewRequest("GET", "/seek?t=1&direct=0", nil)) {
		t.Fatal("?direct=0 must disable it for the request")
	}
	t.Setenv("AML_MV_DIRECT_SEEK", "0")
	if directSeekEnabled(r) {
		t.Fatal("AML_MV_DIRECT_SEEK=0 must disable it")
	}
}

func TestStartVsegSessionDirectReportsPlanFailure(t *testing.T) {
	fx := newDirectFixture(t, 3)
	s, id := newDirectTestServer(t, &fakeVideoSource{fx: fx, directOK: false})
	if _, err := s.startVsegSessionDirect(id, "mv-test", 1); err == nil {
		t.Fatal("a failed plan must be reported so the handler can fall back to FFmpeg")
	}
}
