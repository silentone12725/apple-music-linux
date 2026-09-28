//go:build linux && hybris_backend

package drm

// hybris_cgo_bridge.go — CGO //export callbacks for libdrm-native.so.
//
// CGO rule: a file that uses //export must NOT have C function definitions in
// its preamble (only declarations). Keep all C preamble code in hybris_backend.go.

/*
#include <stdint.h>
*/
import "C"

import (
	"context"
	"time"
	"unsafe"
)

// hybrisBridgeAuth is called by the C auth callback in drm_lib.c when
// libdrm-native needs a credential string ("credentials") or a 2FA code ("2fa").
// It fills out_buf with the reply string (null-terminated).
//
//export hybrisBridgeAuth
func hybrisBridgeAuth(ctype *C.char, buf *C.char, size C.int, ud unsafe.Pointer) {
	b := hybrisBackendFromUD(ud)
	if b == nil {
		return
	}
	b.mu.RLock()
	auth := b.auth
	b.mu.RUnlock()
	if auth == nil {
		return
	}
	var ct AuthChallengeType
	switch C.GoString(ctype) {
	case "2fa":
		ct = ChallengeTwoFactor
	default:
		ct = ChallengeCredentials
	}
	// Bounded: this runs on the C auth thread inside drm_lib_init, which holds
	// the start lock; an abandoned 2FA prompt must not block DRM forever.
	ctx, cancel := context.WithTimeout(context.Background(), authChallengeTimeout)
	defer cancel()
	reply, err := auth.Challenge(ctx, AuthChallenge{Type: ct})
	if err != nil || reply == "" {
		return
	}
	n := len(reply)
	if n >= int(size)-1 {
		n = int(size) - 1
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(buf)), int(size))
	copy(dst, reply[:n])
	dst[n] = 0
}

// hybrisBridgeState is called by the C state callback in drm_lib.c whenever
// write_drm_state() fires (via the g_drm_state_cb hook in main.c).
//
//export hybrisBridgeState
func hybrisBridgeState(state *C.char, ud unsafe.Pointer) {
	b := hybrisBackendFromUD(ud)
	if b == nil {
		return
	}
	s := C.GoString(state)
	r := stateFileStrings[s]
	b.emit(DRMEvent{Snapshot: DRMSnapshot{
		State: DRMState{
			Process:        r.Process,
			FairPlay:       r.FairPlay,
			Authentication: r.Auth,
			Recovery:       r.Recovery,
		},
		Timestamp: time.Now(),
		Message:   s,
	}})
}
