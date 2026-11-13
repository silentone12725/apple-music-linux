//go:build !linux

package main

import "os"

// Non-Linux platforms keep the named-spool path in newTransientVLCSource.
func validateAnonymousVLCFile(*os.File) error { return os.ErrInvalid }
