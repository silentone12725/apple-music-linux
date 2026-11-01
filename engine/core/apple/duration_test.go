package apple

import "testing"

func TestDeclaredDurationMs(t *testing.T) {
	for _, tc := range []struct {
		name string
		segs []float64
		want int
	}{
		{"none declared", nil, 0},
		{"sums segments", []float64{10, 10, 4.3456}, 24346},
		{"rounds to the millisecond", []float64{1.0004, 1.0004}, 2001},
		{"ignores non-positive entries", []float64{5, -3, 0, 2.5}, 7500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := declaredDurationMs(tc.segs); got != tc.want {
				t.Errorf("declaredDurationMs(%v) = %d, want %d", tc.segs, got, tc.want)
			}
		})
	}
}
