// Package vlc wraps libvlc to play a single HTTP audio stream.
// It is used for lossless/ALAC tracks that the browser's MSE cannot handle.
package vlc

// #cgo LDFLAGS: -lvlc
// #include <vlc/vlc.h>
// #include <stdlib.h>
import "C"
import (
	"fmt"
	"sync"
	"unsafe"
)

// Player is a single-track libvlc player. Only one track plays at a time;
// Load replaces the current media. Safe for concurrent use.
type Player struct {
	mu      sync.Mutex
	inst    *C.libvlc_instance_t
	mp      *C.libvlc_media_player_t
	lastURL string // URL of the currently loaded media (for reload-to-seek)
}

// New creates a libvlc instance and media player.
// Returns an error if libvlc cannot be initialised (missing shared library).
func New() (*Player, error) {
	inst := C.libvlc_new(0, nil)
	if inst == nil {
		return nil, fmt.Errorf("vlc: libvlc_new failed — is libvlc.so.5 in LD_LIBRARY_PATH?")
	}
	mp := C.libvlc_media_player_new(inst)
	if mp == nil {
		C.libvlc_release(inst)
		return nil, fmt.Errorf("vlc: libvlc_media_player_new failed")
	}
	return &Player{inst: inst, mp: mp}, nil
}

// Load stops any current playback and starts playing url from the beginning.
func (p *Player) Load(url string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	cURL := C.CString(url)
	defer C.free(unsafe.Pointer(cURL))

	media := C.libvlc_media_new_location(p.inst, cURL)
	if media == nil {
		return fmt.Errorf("vlc: libvlc_media_new_location failed for %s", url)
	}
	defer C.libvlc_media_release(media)

	C.libvlc_media_player_set_media(p.mp, media)
	p.lastURL = url
	if ret := C.libvlc_media_player_play(p.mp); ret != 0 {
		return fmt.Errorf("vlc: play failed (ret %d)", int(ret))
	}
	return nil
}

// Seek reloads the current media at posMs offset (HLS streams are not
// seekable in-place; reload with ?t= is the only reliable approach).
func (p *Player) Seek(posMs int64) error {
	p.mu.Lock()
	url := p.lastURL
	p.mu.Unlock()
	if url == "" {
		return nil
	}
	// Strip any existing ?t= and append the new one.
	base := url
	if i := indexOf(url, "?t="); i >= 0 {
		base = url[:i]
	}
	startSec := float64(posMs) / 1000.0
	return p.Load(fmt.Sprintf("%s?t=%.3f&raw=1", base, startSec))
}

// Time returns the current position and total length in milliseconds, plus a
// short state string ("playing", "paused", "stopped", "ended", "error").
func (p *Player) Time() (posMs, lengthMs int64, state string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	posMs = int64(C.libvlc_media_player_get_time(p.mp))
	lengthMs = int64(C.libvlc_media_player_get_length(p.mp))
	state = vlcStateName(C.libvlc_media_player_get_state(p.mp))
	return
}

// Pause pauses playback.
func (p *Player) Pause() {
	p.mu.Lock()
	defer p.mu.Unlock()
	C.libvlc_media_player_set_pause(p.mp, 1)
}

// Resume resumes playback.
func (p *Player) Resume() {
	p.mu.Lock()
	defer p.mu.Unlock()
	C.libvlc_media_player_set_pause(p.mp, 0)
}

// SetVolume sets the audio volume. vol is 0–200 (100 = 100%).
func (p *Player) SetVolume(vol int) {
	if vol < 0 {
		vol = 0
	}
	if vol > 200 {
		vol = 200
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
}

// Close releases all libvlc resources.
func (p *Player) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp != nil {
		C.libvlc_media_player_stop(p.mp)
		C.libvlc_media_player_release(p.mp)
		p.mp = nil
	}
	if p.inst != nil {
		C.libvlc_release(p.inst)
		p.inst = nil
	}
}

func vlcStateName(s C.libvlc_state_t) string {
	switch s {
	case C.libvlc_NothingSpecial:
		return "stopped"
	case C.libvlc_Opening:
		return "opening"
	case C.libvlc_Buffering:
		return "buffering"
	case C.libvlc_Playing:
		return "playing"
	case C.libvlc_Paused:
		return "paused"
	case C.libvlc_Stopped:
		return "stopped"
	case C.libvlc_Ended:
		return "ended"
	case C.libvlc_Error:
		return "error"
	default:
		return "unknown"
	}
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
