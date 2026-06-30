//go:build !linux

package main

func patchCookieStorage() {
	// Not required or supported on non-Linux platforms
}
