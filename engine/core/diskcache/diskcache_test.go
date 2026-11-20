package diskcache

import "testing"

func TestReaderAfterCommitAndLastReaderGoneStillReads(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sw, err := c.BeginStreamingPut("1", "alac")
	if err != nil || sw == nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := sw.Write([]byte("hello world")); err != nil {
		t.Fatal(err)
	}
	if err := sw.Commit(); err != nil { // the writer's reference was the only one: the file is now closed
		t.Fatal(err)
	}
	r := sw.NewReaderAt(6) // a caller that looked the writer up before the commit
	defer r.Close()
	buf := make([]byte, 16)
	n, err := r.Read(buf)
	if string(buf[:n]) != "world" {
		t.Fatalf("read %q err=%v", buf[:n], err)
	}
	if sw.NewReaderIfActive() != nil {
		t.Fatal("reader handed out for a finished writer")
	}
}

func TestReaderOfDiscardedWriterIsAbortedNotBroken(t *testing.T) {
	c, _ := New(t.TempDir())
	sw, _ := c.BeginStreamingPut("2", "alac")
	sw.Discard()
	r := sw.NewReader()
	defer r.Close()
	if _, err := r.Read(make([]byte, 4)); err == nil {
		t.Fatal("read from a discarded download succeeded")
	}
}
