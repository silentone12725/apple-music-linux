package media

import "testing"

func TestReconcileDurationMs(t *testing.T) {
	for _, tc := range []struct {
		name            string
		catalog, stream int
		want            int
	}{
		{"stream unknown keeps the catalog length", 200000, 0, 200000},
		{"no catalog length takes the stream's", 0, 187500, 187500},
		{"same length", 200000, 200000, 200000},
		{"padding inside the tolerance keeps the catalog length", 200000, 200900, 200000},
		{"exactly at the tolerance keeps the catalog length", 200000, 199000, 200000},
		{"shorter stream wins", 200000, 187000, 187000},
		{"longer stream wins", 200000, 214500, 214500},
		{"preview-length stream wins", 214000, 30000, 30000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ReconcileDurationMs(tc.catalog, tc.stream); got != tc.want {
				t.Errorf("ReconcileDurationMs(%d, %d) = %d, want %d", tc.catalog, tc.stream, got, tc.want)
			}
		})
	}
}
