//go:build linux && native_backend

package drm

/*
#include <string.h>
#include <stdlib.h>
*/
import "C"

import (
	"runtime"
	"runtime/cgo"
	"unsafe"
)

//export nativeBridgeAuth
func nativeBridgeAuth(cType *C.char, buf *C.char, size C.int, ud unsafe.Pointer) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Auth is handled via callbacks - for now just return empty
	if size > 0 {
		C.memset(unsafe.Pointer(buf), 0, C.size_t(size))
	}
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
