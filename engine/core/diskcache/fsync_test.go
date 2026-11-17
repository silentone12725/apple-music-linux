package diskcache

import (
	"bytes"
	"log"
	"os"
	"syscall"
	"testing"
)

func pathErr(errno error) error { return &os.PathError{Op: "sync", Path: "track.tmp", Err: errno} }

func TestCommitWhenTheFilesystemCannotFlush(t *testing.T) {
	for _, errno := range []error{syscall.EINVAL, syscall.ENOTSUP, syscall.ENOSYS, syscall.EOPNOTSUPP} {
		t.Run(errno.Error(), func(t *testing.T) {
			for _, mode := range []string{"streaming", "plain"} {
				c, err := New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				c.syncFile = func(*os.File) error { return pathErr(errno) }
				var commit func() error
				if mode == "streaming" {
					sw, _ := c.BeginStreamingPut("a", "alac")
					sw.Write([]byte("whole track"))
					commit = sw.Commit
				} else {
					pw, _ := c.BeginPut("a", "alac")
					pw.Write([]byte("whole track"))
					commit = pw.Commit
				}
				if err := commit(); err != nil {
					t.Fatalf("%s: Commit failed on a filesystem without fsync: %v", mode, err)
				}
				if _, ok := c.Path("a", "alac"); !ok {
					t.Fatalf("%s: the track was dropped instead of cached", mode)
				}
			}
		})
	}
}

func TestCommitStillFailsOnRealFlushErrors(t *testing.T) {
	for _, errno := range []error{syscall.EIO, syscall.ENOSPC} {
		t.Run(errno.Error(), func(t *testing.T) {
			c, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			c.syncFile = func(*os.File) error { return pathErr(errno) }
			sw, _ := c.BeginStreamingPut("a", "alac")
			sw.Write([]byte("whole track"))
			if err := sw.Commit(); err == nil {
				t.Fatal("Commit hid a real flush failure")
			}
			if _, ok := c.Path("a", "alac"); ok {
				t.Fatal("a track whose flush failed was published")
			}
		})
	}
}

func TestUnsupportedFlushIsLoggedOnce(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c.syncFile = func(*os.File) error { return pathErr(syscall.EINVAL) }
	for _, id := range []string{"a", "b", "c"} {
		sw, _ := c.BeginStreamingPut(id, "alac")
		sw.Write([]byte("x"))
		if err := sw.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	if n := bytes.Count(buf.Bytes(), []byte("cannot flush files")); n != 1 {
		t.Fatalf("logged %d times, want once:\n%s", n, buf.String())
	}
}
