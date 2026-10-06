//go:build linux && native_backend && drm_testhelpers

package drm

/*
#include <stdlib.h>
#include <stdint.h>
extern void nativeBridgeAuth(char *kind, char *buffer, int size, void *userdata);
static void invoke_auth_callback(char *kind, char *buffer, int size, uintptr_t userdata) {
    nativeBridgeAuth(kind, buffer, size, (void *)userdata);
}
*/
import "C"

import (
	"context"
	"runtime/cgo"
	"unsafe"
)

// This adapter is built only for callback integration tests: Go -> C -> Go.
func nativeAuthRoundTrip(ctx context.Context, source AuthSource, kind string, capacity int) string {
	session := &nativeAuthSession{ctx: ctx, source: source}
	handle := cgo.NewHandle(session)
	defer handle.Delete()
	cKind := C.CString(kind)
	defer C.free(unsafe.Pointer(cKind))
	buffer := C.calloc(C.size_t(capacity), 1)
	defer C.free(buffer)
	C.invoke_auth_callback(cKind, (*C.char)(buffer), C.int(capacity), C.uintptr_t(handle))
	return C.GoString((*C.char)(buffer))
}
