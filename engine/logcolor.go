package main

import (
	"fmt"
	"os"
)

// ttyColors reports whether stderr/stdout is a real terminal.
// When false, all color* functions return the input unchanged.
var ttyColors = func() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}()

const (
	_cReset  = "\033[0m"
	_cBold   = "\033[1m"
	_cRed    = "\033[31m"
	_cGreen  = "\033[32m"
	_cYellow = "\033[33m"
	_cBlue   = "\033[34m"
	_cCyan   = "\033[36m"
	_cPink   = "\033[35m"
)

func colorTag(color, tag string) string {
	if !ttyColors {
		return tag
	}
	return color + _cBold + tag + _cReset
}

// Colored tag helpers — use these in log.Printf calls.
func tagOK(tag string) string    { return colorTag(_cGreen, tag) }
func tagInfo(tag string) string  { return colorTag(_cCyan, tag) }
func tagWarn(tag string) string  { return colorTag(_cYellow, tag) }
func tagErr(tag string) string   { return colorTag(_cRed, tag) }
func tagVideo(tag string) string { return colorTag(_cPink, tag) }
func tagAudio(tag string) string { return colorTag(_cBlue, tag) }

// cprintf prints a colored line to stdout (same destination as log.Printf).
func cprintf(color, format string, args ...any) {
	if ttyColors {
		fmt.Printf(color+_cBold+format+_cReset+"\n", args...)
	} else {
		fmt.Printf(format+"\n", args...)
	}
}
