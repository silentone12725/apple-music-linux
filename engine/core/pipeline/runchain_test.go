package pipeline

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

type endlessSource struct{ done chan error }

func (s endlessSource) Stream(_ context.Context, w io.Writer) error {
	buf := make([]byte, 1024)
	for {
		if _, err := w.Write(buf); err != nil {
			s.done <- err
			return err
		}
	}
}

type failingStage struct{}

func (failingStage) Process(_ context.Context, r io.Reader, _ io.Writer) error {
	r.Read(make([]byte, 10)) // read a little, then give up
	return errors.New("stage failed")
}

func TestRunReleasesSourceWhenStageStopsEarly(t *testing.T) {
	src := endlessSource{done: make(chan error, 1)}
	err := Run(context.Background(), &Stream{Source: src, Stages: []Stage{failingStage{}}}, io.Discard)
	if err == nil || err.Error() != "stage failed" {
		t.Fatalf("Run err = %v", err)
	}
	select {
	case <-src.done:
	case <-time.After(2 * time.Second):
		t.Fatal("source goroutine still blocked after the stage returned")
	}
}
