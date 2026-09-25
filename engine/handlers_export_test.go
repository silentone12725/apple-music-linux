package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
