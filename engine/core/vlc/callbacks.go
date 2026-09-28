package vlc

/*
#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>
#include <vlc/vlc.h>

extern int     amlVlcOpen(void *opaque, void **datap, uint64_t *sizep);
extern ssize_t amlVlcRead(void *opaque, unsigned char *buf, size_t len);
extern int     amlVlcSeek(void *opaque, uint64_t offset);
extern void    amlVlcClose(void *opaque);
*/
import "C"

import (
	"errors"
	"io"
	"runtime/cgo"
	"unsafe"
)

// Source feeds libvlc directly from engine memory/disk, replacing the
// loopback HTTP fetch. Read may block until data is available; Abort must
// unblock it so libvlc_media_player_stop can join its input thread.
type Source interface {
	io.ReadSeeker
	Size() int64 // -1 when not yet known
	Abort()
	Close()
}

// callbackMedia owns a Source for the lifetime of one libvlc media.
// opaque is C memory holding the cgo.Handle, so no Go pointer crosses into C.
type callbackMedia struct {
	src    Source
	handle cgo.Handle
	opaque unsafe.Pointer
}

func newCallbackMedia(src Source) *callbackMedia {
	cm := &callbackMedia{src: src}
	cm.handle = cgo.NewHandle(cm)
	cm.opaque = C.malloc(C.size_t(unsafe.Sizeof(C.uintptr_t(0))))
	*(*C.uintptr_t)(cm.opaque) = C.uintptr_t(cm.handle)
	return cm
}

func (cm *callbackMedia) newMedia(inst *C.libvlc_instance_t) *C.libvlc_media_t {
	return C.libvlc_media_new_callbacks(inst,
		C.libvlc_media_open_cb(C.amlVlcOpen),
		C.libvlc_media_read_cb(C.amlVlcRead),
		C.libvlc_media_seek_cb(C.amlVlcSeek),
		C.libvlc_media_close_cb(C.amlVlcClose),
		cm.opaque)
}

// release must only be called after libvlc has stopped using the media.
func (cm *callbackMedia) release() {
	cm.src.Close()
	cm.handle.Delete()
	C.free(cm.opaque)
}

func mediaFromOpaque(opaque unsafe.Pointer) *callbackMedia {
	return cgo.Handle(*(*C.uintptr_t)(opaque)).Value().(*callbackMedia)
}

//export amlVlcOpen
func amlVlcOpen(opaque unsafe.Pointer, datap *unsafe.Pointer, sizep *C.uint64_t) C.int {
	cm := mediaFromOpaque(opaque)
	*datap = opaque
	if _, err := cm.src.Seek(0, io.SeekStart); err != nil {
		return -1
	}
	if n := cm.src.Size(); n >= 0 {
		*sizep = C.uint64_t(n)
	} else {
		*sizep = C.uint64_t(^uint64(0))
	}
	return 0
}

//export amlVlcRead
func amlVlcRead(opaque unsafe.Pointer, buf *C.uchar, n C.size_t) C.ssize_t {
	if n == 0 {
		return 0
	}
	cm := mediaFromOpaque(opaque)
	p := unsafe.Slice((*byte)(unsafe.Pointer(buf)), int(n))
	for {
		got, err := cm.src.Read(p)
		if got > 0 {
			return C.ssize_t(got)
		}
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			return -1
		}
	}
}

//export amlVlcSeek
func amlVlcSeek(opaque unsafe.Pointer, offset C.uint64_t) C.int {
	if _, err := mediaFromOpaque(opaque).src.Seek(int64(offset), io.SeekStart); err != nil {
		return -1
	}
	return 0
}

//export amlVlcClose
func amlVlcClose(unsafe.Pointer) {}
