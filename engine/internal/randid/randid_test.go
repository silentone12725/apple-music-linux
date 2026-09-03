package randid_test

import (
	"testing"

	"engine/internal/randid"
)

func TestNew_Format(t *testing.T) {
	id := randid.New()
	if len(id) != 16 {
		t.Fatalf("expected 16-char hex ID, got %q (len %d)", id, len(id))
	}
	for _, c := range id {
		if !('0' <= c && c <= '9') && !('a' <= c && c <= 'f') {
			t.Fatalf("non-hex char %q in ID %q", c, id)
		}
	}
}

func TestNew_Unique(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		id := randid.New()
		if seen[id] {
			t.Fatalf("duplicate ID generated: %q", id)
		}
		seen[id] = true
	}
}
