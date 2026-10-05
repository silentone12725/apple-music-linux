package aacstream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

const testTimescale = 24

func buildInit(t *testing.T) []byte {
	t.Helper()
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(testTimescale, "video", "und")
	var b bytes.Buffer
	if err := init.Encode(&b); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// (PlanDirectSeek takes the target as seconds into the segment; these cases use raw time minus 10.)
// buildSegment returns a segment of n one-second fragments starting at startSec on
// the raw timeline, plus each fragment's byte offset.
func buildSegment(t *testing.T, startSec, n int, payload int) (seg []byte, offs []int) {
	t.Helper()
	var b bytes.Buffer
	for i := 0; i < n; i++ {
		frag, err := mp4.CreateFragment(uint32(i+1), 1)
		if err != nil {
			t.Fatal(err)
		}
		data := bytes.Repeat([]byte{byte(i + 1)}, payload)
		frag.AddFullSample(mp4.FullSample{
			Sample:     mp4.Sample{Flags: mp4.SyncSampleFlags, Dur: testTimescale, Size: uint32(payload)},
			DecodeTime: uint64((startSec + i) * testTimescale),
			Data:       data,
		})
		offs = append(offs, b.Len())
		if err := frag.Encode(&b); err != nil {
			t.Fatal(err)
		}
	}
	return b.Bytes(), offs
}

// rangeServer serves files with HTTP Range support and counts requests.
func rangeServer(files map[string][]byte, honourRange bool, reqs *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reqs != nil {
			reqs.Add(1)
		}
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		h := r.Header.Get("Range")
		if !honourRange || h == "" {
			w.Write(data)
			return
		}
		var a, b int
		fmt.Sscanf(strings.TrimPrefix(h, "bytes="), "%d-%d", &a, &b)
		if a >= len(data) {
			http.Error(w, "range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if b >= len(data) {
			b = len(data) - 1
		}
		w.Header().Set("Content-Range", "bytes "+strconv.Itoa(a)+"-"+strconv.Itoa(b)+"/"+strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(data[a : b+1])
	}))
}

func TestPlanDirectSeekPicksTargetFragment(t *testing.T) {
	init := buildInit(t)
	seg, offs := buildSegment(t, 10, 5, 4000) // raw 10..15s
	next1, _ := buildSegment(t, 15, 2, 3000)
	next2, _ := buildSegment(t, 17, 2, 3000)
	var reqs atomic.Int32
	srv := rangeServer(map[string][]byte{"/init.mp4": init, "/s1.m4s": seg, "/s2.m4s": next1, "/s3.m4s": next2}, true, &reqs)
	defer srv.Close()

	cases := []struct {
		name   string
		target float64
		frag   int
	}{
		{"before the segment", 5, 0},
		{"first fragment", 10.2, 0},
		{"middle", 12.5, 2},
		{"exact boundary", 13.0, 3},
		{"last fragment", 14.9, 4},
		{"past the end", 99, 4},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s1.m4s",
				[]string{srv.URL + "/s2.m4s", srv.URL + "/s3.m4s"}, c.target-10)
			if err != nil {
				t.Fatal(err)
			}
			if int(p.fragOff) != offs[c.frag] {
				t.Fatalf("fragOff = %d, want %d (fragment %d)", p.fragOff, offs[c.frag], c.frag)
			}
			if want := float64(10 + c.frag); p.RawFragStart != want {
				t.Fatalf("RawFragStart = %v, want %v", p.RawFragStart, want)
			}
			if p.RawSegStart != 10 {
				t.Fatalf("RawSegStart = %v, want 10", p.RawSegStart)
			}
			if p.segSize != int64(len(seg)) {
				t.Fatalf("segSize = %d, want %d", p.segSize, len(seg))
			}
		})
	}

	t.Run("stream emits init, target tail, following segments in order", func(t *testing.T) {
		p, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s1.m4s",
			[]string{srv.URL + "/s2.m4s", srv.URL + "/s3.m4s"}, 2.5)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := p.Stream(context.Background(), &out); err != nil {
			t.Fatal(err)
		}
		want := append(append(append(append([]byte{}, init...), seg[offs[2]:]...), next1...), next2...)
		if !bytes.Equal(out.Bytes(), want) {
			t.Fatalf("stream mismatch: got %d bytes, want %d", out.Len(), len(want))
		}
	})

	t.Run("last segment has nothing to continue with", func(t *testing.T) {
		p, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s3.m4s", nil, 1.2)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := p.Stream(context.Background(), &out); err != nil {
			t.Fatal(err)
		}
		_, off3 := buildSegment(t, 17, 2, 3000)
		if !bytes.Equal(out.Bytes(), append(append([]byte{}, init...), next2[off3[1]:]...)) {
			t.Fatal("tail of the final segment not emitted exactly")
		}
	})
}

func TestPlanDirectSeekOnlyFetchesHeaders(t *testing.T) {
	init := buildInit(t)
	seg, _ := buildSegment(t, 10, 5, 200_000) // 1 MB segment
	var reqs atomic.Int32
	var bytesServed atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqs.Add(1)
		if r.URL.Path == "/init.mp4" {
			w.Write(init)
			return
		}
		var a, b int
		fmt.Sscanf(strings.TrimPrefix(r.Header.Get("Range"), "bytes="), "%d-%d", &a, &b)
		if b >= len(seg) {
			b = len(seg) - 1
		}
		bytesServed.Add(int64(b - a + 1))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, len(seg)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(seg[a : b+1])
	}))
	defer srv.Close()

	if _, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s1.m4s", nil, 3.5); err != nil {
		t.Fatal(err)
	}
	// Mapping 4 fragments reads 16 KiB windows, never whole 200 KB payloads.
	if got, max := bytesServed.Load(), int64(5*directProbeWindow); got > max {
		t.Fatalf("planning transferred %d bytes, want <= %d", got, max)
	}
}

func TestPlanDirectSeekFallbackSignals(t *testing.T) {
	init := buildInit(t)
	seg, _ := buildSegment(t, 10, 3, 1000)
	srv := rangeServer(map[string][]byte{"/init.mp4": init, "/s1.m4s": seg}, false, nil) // ignores Range
	defer srv.Close()

	if _, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s1.m4s", nil, 1); !errors.Is(err, ErrDirectUnsupported) {
		t.Fatalf("server ignoring Range: err = %v, want ErrDirectUnsupported", err)
	}
	if _, err := PlanDirectSeek(context.Background(), srv.URL+"/init.mp4", srv.URL+"/s1.m4s#bytes=0-100", nil, 1); !errors.Is(err, ErrDirectUnsupported) {
		t.Fatalf("byte-range URL: err = %v, want ErrDirectUnsupported", err)
	}
	bad := rangeServer(map[string][]byte{"/init.mp4": init, "/s1.m4s": bytes.Repeat([]byte("x"), 100)}, true, nil)
	defer bad.Close()
	if _, err := PlanDirectSeek(context.Background(), bad.URL+"/init.mp4", bad.URL+"/s1.m4s", nil, 1); !errors.Is(err, ErrDirectUnsupported) {
		t.Fatalf("non-fMP4 segment: err = %v, want ErrDirectUnsupported", err)
	}
}
