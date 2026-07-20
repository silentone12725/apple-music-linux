package pipeline

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"sync"
	"testing"
)

// ── Fakes ───────────────────────────────────────────────────────────────────

// fakeSource writes a fixed payload to w, respecting ctx cancellation.
type fakeSource struct {
	payload []byte
}

func (f *fakeSource) Stream(ctx context.Context, w io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := w.Write(f.payload)
	return err
}

// fakeErrorSource returns an error after writing some bytes.
type fakeErrorSource struct {
	err error
}

func (f *fakeErrorSource) Stream(ctx context.Context, w io.Writer) error {
	_, _ = w.Write([]byte("partial"))
	return f.err
}

// fakeStage appends a suffix to everything it reads.
type fakeStage struct {
	suffix string
	// order tracking
	name  string
	log   *[]string
	logMu *sync.Mutex
}

func (s *fakeStage) Process(ctx context.Context, r io.Reader, w io.Writer) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	// Record after reading so the log reflects data-flow order (inner stages
	// finish reading before outer stages): source → s1 → s2 → s3.
	if s.log != nil {
		s.logMu.Lock()
		*s.log = append(*s.log, s.name)
		s.logMu.Unlock()
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	_, err = w.Write([]byte(s.suffix))
	return err
}

// fakeErrorStage returns an error.
type fakeErrorStage struct {
	err error
}

func (s *fakeErrorStage) Process(ctx context.Context, r io.Reader, w io.Writer) error {
	_, _ = io.Copy(io.Discard, r)
	return s.err
}

// fakeDecryptor records whether Decrypt was called and echoes r → w.
type fakeDecryptor struct {
	called bool
	gotR   io.Reader
	gotW   io.Writer
}

func (d *fakeDecryptor) Decrypt(ctx context.Context, r io.Reader, w io.Writer) error {
	d.called = true
	d.gotR = r
	d.gotW = w
	_, err := io.Copy(w, r)
	return err
}

// ── Tests ───────────────────────────────────────────────────────────────────

func TestRun_ZeroStages(t *testing.T) {
	t.Parallel()
	want := []byte("hello world")
	stream := &Stream{Source: &fakeSource{payload: want}}
	var dst bytes.Buffer
	if err := Run(context.Background(), stream, &dst); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !bytes.Equal(dst.Bytes(), want) {
		t.Fatalf("got %q want %q", dst.Bytes(), want)
	}
}

func TestRun_OneStage(t *testing.T) {
	t.Parallel()
	stream := &Stream{
		Source: &fakeSource{payload: []byte("body")},
		Stages: []Stage{&fakeStage{suffix: "-END"}},
	}
	var dst bytes.Buffer
	if err := Run(context.Background(), stream, &dst); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := dst.String(); got != "body-END" {
		t.Fatalf("got %q want %q", got, "body-END")
	}
}

func TestRun_ThreeStages(t *testing.T) {
	t.Parallel()
	var log []string
	var mu sync.Mutex
	mk := func(name, suffix string) *fakeStage {
		return &fakeStage{suffix: suffix, name: name, log: &log, logMu: &mu}
	}
	stream := &Stream{
		Source: &fakeSource{payload: []byte("x")},
		Stages: []Stage{mk("s1", "1"), mk("s2", "2"), mk("s3", "3")},
	}
	var dst bytes.Buffer
	if err := Run(context.Background(), stream, &dst); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := dst.String(); got != "x123" {
		t.Fatalf("got %q want %q", got, "x123")
	}
	// Stages must execute in order s1, s2, s3.
	mu.Lock()
	defer mu.Unlock()
	want := []string{"s1", "s2", "s3"}
	if len(log) != 3 {
		t.Fatalf("expected 3 stage executions, got %v", log)
	}
	for i := range want {
		if log[i] != want[i] {
			t.Fatalf("stage order = %v want %v", log, want)
		}
	}
}

func TestRun_ContextCancel(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before running
	stream := &Stream{Source: &fakeSource{payload: []byte("data")}}
	var dst bytes.Buffer
	err := Run(ctx, stream, &dst)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestRun_SourceError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("source boom")
	stream := &Stream{
		Source: &fakeErrorSource{err: sentinel},
		Stages: []Stage{&fakeStage{suffix: "x"}},
	}
	var dst bytes.Buffer
	err := Run(context.Background(), stream, &dst)
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected %v, got %v", sentinel, err)
	}
}

func TestRun_StageError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("stage boom")
	stream := &Stream{
		Source: &fakeSource{payload: []byte("data")},
		Stages: []Stage{&fakeErrorStage{err: sentinel}},
	}
	var dst bytes.Buffer
	err := Run(context.Background(), stream, &dst)
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected %v, got %v", sentinel, err)
	}
}

func TestRun_LargePayload(t *testing.T) {
	t.Parallel()
	const size = 1 << 20 // 1 MB
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i * 31)
	}
	wantSum := sha256.Sum256(payload)

	stream := &Stream{Source: &fakeSource{payload: payload}}
	var dst bytes.Buffer
	if err := Run(context.Background(), stream, &dst); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if dst.Len() != size {
		t.Fatalf("got %d bytes want %d", dst.Len(), size)
	}
	gotSum := sha256.Sum256(dst.Bytes())
	if gotSum != wantSum {
		t.Fatalf("checksum mismatch: payload corrupted")
	}
}

func TestRun_DecryptStage(t *testing.T) {
	t.Parallel()
	dec := &fakeDecryptor{}
	stream := &Stream{
		Source: &fakeSource{payload: []byte("encrypted-bytes")},
		Stages: []Stage{DecryptStage(dec)},
	}
	var dst bytes.Buffer
	if err := Run(context.Background(), stream, &dst); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !dec.called {
		t.Fatal("expected Decrypt to be called")
	}
	if dec.gotR == nil || dec.gotW == nil {
		t.Fatal("Decrypt received nil reader or writer")
	}
	if got := dst.String(); got != "encrypted-bytes" {
		t.Fatalf("got %q want passthrough of source", got)
	}
}

// ── Benchmarks ──────────────────────────────────────────────────────────────

func benchPayload() []byte {
	p := make([]byte, 1<<20)
	for i := range p {
		p[i] = byte(i)
	}
	return p
}

func BenchmarkRunNoStages(b *testing.B) {
	b.ReportAllocs()
	stream := &Stream{Source: &fakeSource{payload: benchPayload()}}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var dst bytes.Buffer
		if err := Run(context.Background(), stream, &dst); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRunOneStage(b *testing.B) {
	b.ReportAllocs()
	stream := &Stream{
		Source: &fakeSource{payload: benchPayload()},
		Stages: []Stage{&fakeStage{suffix: ""}},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var dst bytes.Buffer
		if err := Run(context.Background(), stream, &dst); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRunThreeStages(b *testing.B) {
	b.ReportAllocs()
	stream := &Stream{
		Source: &fakeSource{payload: benchPayload()},
		Stages: []Stage{&fakeStage{suffix: ""}, &fakeStage{suffix: ""}, &fakeStage{suffix: ""}},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var dst bytes.Buffer
		if err := Run(context.Background(), stream, &dst); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRun1MB(b *testing.B) {
	b.ReportAllocs()
	stream := &Stream{Source: &fakeSource{payload: benchPayload()}}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var dst bytes.Buffer
		if err := Run(context.Background(), stream, &dst); err != nil {
			b.Fatal(err)
		}
	}
}
