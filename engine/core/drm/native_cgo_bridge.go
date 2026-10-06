//go:build linux && native_backend

package drm

/*
#include <string.h>
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime"
	"runtime/cgo"
	"unsafe"
)

// nativeAuthSession is retained by a cgo.Handle until drm_shutdown finishes.
// Copy the AuthSource before entering C: Start holds the backend mutex while
// C invokes this callback, so taking that mutex from here would deadlock.
type nativeAuthSession struct {
	ctx    context.Context
	source AuthSource
}

func (s *nativeAuthSession) reply(kind string, capacity int) string {
	if s.source == nil {
		return ""
	}
	challenge, ok := nativeAuthChallenge(kind)
	if !ok {
		return ""
	}
	reply, err := s.source.Challenge(s.ctx, challenge)
	if err != nil || len(reply) >= capacity {
		return "" // reject truncation instead of sending corrupted credentials
	}
	return reply
}

//export nativeBridgeAuth
func nativeBridgeAuth(cType *C.char, buf *C.char, size C.int, ud unsafe.Pointer) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if buf == nil || size <= 0 {
		return
	}
	C.memset(unsafe.Pointer(buf), 0, C.size_t(size))
	if ud == nil || cType == nil {
		return
	}
	session, ok := cgo.Handle(uintptr(ud)).Value().(*nativeAuthSession)
	if !ok || session.source == nil {
		return
	}
	reply := session.reply(C.GoString(cType), int(size))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(buf)), int(size)), reply)
}

//export nativeBridgeState
func nativeBridgeState(cState *C.char, ud unsafe.Pointer) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Get the state channel from userdata
	if ud == nil {
		return
	}

	// Convert unsafe.Pointer to uintptr, then to cgo.Handle
	handle := cgo.Handle(uintptr(ud))
	stateCh, ok := handle.Value().(chan string)
	if !ok {
		return
	}

	// Convert C string to Go string
	state := C.GoString(cState)

	// Send to channel (non-blocking)
	select {
	case stateCh <- state:
	default:
		// Channel full, ignore
	}
}
