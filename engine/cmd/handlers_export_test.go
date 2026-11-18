package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"engine/core/drm"
	"engine/core/export"
)

// Queue semantics (200/409 paths) are covered in core/export; this pins the
// HTTP contract for bad input and unknown jobs.
func TestHandleExportPriority_BadRequestAndNotFound(t *testing.T) {
	s := &APIServer{em: export.NewManager(nil, nil, export.Options{})}

	for _, body := range []string{``, `{}`, `{"priority":"high"}`, `not json`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/export/x/priority", strings.NewReader(body))
		req.SetPathValue("id", "x")
		rr := httptest.NewRecorder()
		s.handleExportPriority(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", body, rr.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/export/nope/priority", strings.NewReader(`{"priority":3}`))
	req.SetPathValue("id", "nope")
	rr := httptest.NewRecorder()
	s.handleExportPriority(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("unknown job: status %d, want 404", rr.Code)
	}
}

func TestDowngradeExportCapabilities(t *testing.T) {
	ready := drm.CapabilityState{CBCS: true, ALAC: true, Atmos: true}
	readyHiRes := drm.CapabilityState{CBCS: true, ALAC: true, Atmos: true, HiRes: true}
	cases := []struct {
		name        string
		in          export.ExportCapabilities
		have        drm.CapabilityState
		want        export.ExportCapabilities
		wantDropped bool
	}{
		{"lossless without DRM becomes AAC", export.ExportCapabilities{Lossless: true}, drm.CapabilityState{}, export.ExportCapabilities{}, true},
		{"atmos without DRM becomes AAC", export.ExportCapabilities{Atmos: true}, drm.CapabilityState{}, export.ExportCapabilities{}, true},
		{"both without DRM", export.ExportCapabilities{Lossless: true, Atmos: true}, drm.CapabilityState{}, export.ExportCapabilities{}, true},
		{"lossless with DRM is untouched", export.ExportCapabilities{Lossless: true}, ready, export.ExportCapabilities{Lossless: true}, false},
		{"atmos with DRM is untouched", export.ExportCapabilities{Atmos: true}, ready, export.ExportCapabilities{Atmos: true}, false},
		{"AAC request is untouched", export.ExportCapabilities{}, drm.CapabilityState{}, export.ExportCapabilities{}, false},
		{"music video does not need FairPlay", export.ExportCapabilities{Video: true, Lossless: true}, drm.CapabilityState{}, export.ExportCapabilities{Video: true}, true},
		{"playlist flags survive", export.ExportCapabilities{Playlist: true, LibraryPlaylist: true, Lossless: true}, drm.CapabilityState{}, export.ExportCapabilities{Playlist: true, LibraryPlaylist: true}, true},
		{"hi-res with DRM ready is untouched", export.ExportCapabilities{Lossless: true, HiRes: true}, readyHiRes, export.ExportCapabilities{Lossless: true, HiRes: true}, false},
		{"hi-res without DRM becomes AAC", export.ExportCapabilities{Lossless: true, HiRes: true}, drm.CapabilityState{}, export.ExportCapabilities{}, true},
		{"hi-res the engine disallows keeps lossless", export.ExportCapabilities{Lossless: true, HiRes: true}, ready, export.ExportCapabilities{Lossless: true}, true},
		{"hi-res without lossless is dropped", export.ExportCapabilities{HiRes: true}, readyHiRes, export.ExportCapabilities{}, true},
	}
	for _, tc := range cases {
		got, dropped := downgradeExportCapabilities(tc.in, tc.have)
		if got != tc.want || dropped != tc.wantDropped {
			t.Errorf("%s: got %+v dropped=%v, want %+v dropped=%v", tc.name, got, dropped, tc.want, tc.wantDropped)
		}
	}
}
