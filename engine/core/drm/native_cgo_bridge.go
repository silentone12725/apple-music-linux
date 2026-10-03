//go:build linux && native_backend

package drm

/*
#include <string.h>
#include <stdlib.h>
*/
import "C"

import (
	"runtime"
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

	// State changes are emitted via eventCh
}
