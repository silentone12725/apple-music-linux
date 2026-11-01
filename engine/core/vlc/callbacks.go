package vlc

/*
#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>
#include <vlc/vlc.h>

extern int     adamVlcOpen(void *opaque, void **datap, uint64_t *sizep);
extern ssize_t adamVlcRead(void *opaque, unsigned char *buf, size_t len);
extern int     adamVlcSeek(void *opaque, uint64_t offset);
extern void    adamVlcClose(void *opaque);
*/
import "C"

import (
	"errors"
	"io"
	"runtime/cgo"
	"sync/atomic"
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
	// eof is set when the source reported a clean end of data (all bytes delivered, no error) and cleared when libvlc
	// seeks. A read that failed or was aborted never sets it, so it tells the real end of the data from a failure.
	eof atomic.Bool
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
		C.libvlc_media_open_cb(C.adamVlcOpen),
		C.libvlc_media_read_cb(C.adamVlcRead),
		C.libvlc_media_seek_cb(C.adamVlcSeek),
		C.libvlc_media_close_cb(C.adamVlcClose),
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

//export adamVlcOpen
func adamVlcOpen(opaque unsafe.Pointer, datap *unsafe.Pointer, sizep *C.uint64_t) C.int {
	cm := mediaFromOpaque(opaque)
	*datap = opaque
	if cm.seekTo(0) != 0 {
		return -1
	}
	if n := cm.src.Size(); n >= 0 {
		*sizep = C.uint64_t(n)
	} else {
		*sizep = C.uint64_t(^uint64(0))
	}
	return 0
}

//export adamVlcRead
func adamVlcRead(opaque unsafe.Pointer, buf *C.uchar, n C.size_t) C.ssize_t {
	if n == 0 {
		return 0
	}
	p := unsafe.Slice((*byte)(unsafe.Pointer(buf)), int(n))
	return C.ssize_t(mediaFromOpaque(opaque).read(p))
}

// read fills p for libvlc: the byte count, 0 at the end of the data, -1 on a read error.
func (cm *callbackMedia) read(p []byte) int {
	for {
		got, err := cm.src.Read(p)
		if got > 0 {
			return got
		}
		if errors.Is(err, io.EOF) {
			cm.eof.Store(true)
			return 0
		}
		if err != nil {
			return -1
		}
	}
}

//export adamVlcSeek
func adamVlcSeek(opaque unsafe.Pointer, offset C.uint64_t) C.int {
	return C.int(mediaFromOpaque(opaque).seekTo(int64(offset)))
}

// seekTo repositions the source; 0 on success, -1 on failure. Any seek means libvlc is not at the end any more.
func (cm *callbackMedia) seekTo(offset int64) int {
	cm.eof.Store(false)
	if _, err := cm.src.Seek(offset, io.SeekStart); err != nil {
		return -1
	}
	return 0
}

//export adamVlcClose
func adamVlcClose(unsafe.Pointer) {}
