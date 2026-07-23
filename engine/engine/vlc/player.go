// Package vlc wraps libvlc to play a single HTTP audio stream.
// It is used for lossless/ALAC tracks that the browser's MSE cannot handle.
package vlc

// #cgo LDFLAGS: -lvlc
// #include <vlc/vlc.h>
// #include <stdlib.h>
import "C"
import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unsafe"
)

// Player is a single-track libvlc player. Only one track plays at a time;
// Load replaces the current media. Safe for concurrent use.
type Player struct {
	mu      sync.Mutex
	inst    *C.libvlc_instance_t
	mp      *C.libvlc_media_player_t
	lastURL string
	volume  int // 0-200; default 100
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
	return &Player{inst: inst, mp: mp, volume: 100}, nil
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
	vol := p.volume
	if ret := C.libvlc_media_player_play(p.mp); ret != 0 {
		return fmt.Errorf("vlc: play failed (ret %d)", int(ret))
	}
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
	// WirePlumber applies its stored per-app stream volume asynchronously after
	// VLC opens the audio device, overriding the libvlc software volume above.
	// Re-apply after VLC reaches playing state so our value lands last.
	go p.reapplyVolumeOnPlay(vol)
	return nil
}

// reapplyVolumeOnPlay waits until VLC enters playing state then sets the
// libvlc software volume and resets any WirePlumber stream mute via wpctl.
func (p *Player) reapplyVolumeOnPlay(vol int) {
	// Wait for VLC to reach Playing state.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		p.mu.Lock()
		state := C.libvlc_media_player_get_state(p.mp)
		p.mu.Unlock()
		if state == C.libvlc_Playing {
			break
		}
	}

	// Re-apply libvlc software volume then hammer wpctl for ~2s.
	// WirePlumber applies its stored vol=0 asynchronously after VLC opens the
	// audio device — sometimes hundreds of milliseconds after play() returns.
	// A single set-volume call races against that; repeated calls win.
	p.mu.Lock()
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
	p.mu.Unlock()

	const wpctlCmd = `id=$(wpctl status 2>/dev/null | grep -i "vlc" | awk '{print $1}' | tr -d '.' | grep -E '^[0-9]+$' | head -1); [ -n "$id" ] && wpctl set-mute "$id" 0 && wpctl set-volume "$id" 1.0`
	for range 8 {
		exec.Command("sh", "-c", wpctlCmd).Run() //nolint:errcheck
		time.Sleep(250 * time.Millisecond)
	}
}

// Seek reloads the media at posMs. fMP4 is not byte-range seekable (VLC has
// no time→byte map for fragmented files), so the engine serves a new fragment
// stream starting at posMs via the ?t= query param, same as the ALAC path.
func (p *Player) Seek(posMs int64) error {
	p.mu.Lock()
	url := p.lastURL
	p.mu.Unlock()
	if url == "" {
		return nil
	}
	base := url
	if i := strings.Index(url, "?"); i >= 0 {
		base = url[:i]
	}
	seekURL := fmt.Sprintf("%s?t=%.3f&raw=1", base, float64(posMs)/1000.0)
	fmt.Printf("[vlc] Seek posMs=%d → %s\n", posMs, seekURL)
	// Stop current playback so VLC flushes its audio buffer before loading the
	// seek stream. Without this, buffered audio from the old position plays out
	// first, making seeks appear to start from the wrong position.
	p.mu.Lock()
	C.libvlc_media_player_stop(p.mp)
	p.mu.Unlock()
	return p.Load(seekURL)
}

// SetTime fast-forwards within the currently playing stream to offsetMs
// milliseconds from the stream start. Used after a seek to skip past the gap
// between the HLS segment boundary (actualStart) and the requested position.
// Polls until VLC is playing before applying, so it is safe to call immediately
// after Load.
func (p *Player) SetTime(offsetMs int64) {
	if offsetMs <= 0 {
		return
	}
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			p.mu.Lock()
			state := C.libvlc_media_player_get_state(p.mp)
			p.mu.Unlock()
			if state == C.libvlc_Playing {
				p.mu.Lock()
				C.libvlc_media_player_set_time(p.mp, C.libvlc_time_t(offsetMs))
				p.mu.Unlock()
				return
			}
		}
	}()
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
	p.volume = vol
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

