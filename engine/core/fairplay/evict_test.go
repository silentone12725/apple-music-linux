package fairplay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"
)

func TestShouldEvictKey(t *testing.T) {
	live := context.Background()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"success", live, nil, false},
		{"decrypt failure", live, errors.New("sample decrypt: bad padding"), true},
		{"user skipped", cancelled, errors.New("anything"), false},
		{"canceled error", live, fmt.Errorf("write: %w", context.Canceled), false},
		{"downstream closed", live, fmt.Errorf("copy: %w", io.ErrClosedPipe), false},
	} {
		if got := shouldEvictKey(c.ctx, c.err); got != c.want {
			t.Errorf("%s: shouldEvictKey = %v, want %v", c.name, got, c.want)
		}
	}
}
