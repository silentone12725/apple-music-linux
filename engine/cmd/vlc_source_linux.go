//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
)

func validateAnonymousVLCFile(f *os.File) error {
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat VLC spool: %w", err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("VLC spool must be an owner-only, unlinked regular file")
	}
	return nil
}
