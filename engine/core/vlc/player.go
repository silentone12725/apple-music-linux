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
	volume  int            // 0-200; default 100
	loadGen int            // incremented on each Load; goroutines compare to detect staleness
	cur     *callbackMedia // non-nil while a LoadSource media is attached
}

// New creates a libvlc instance and media player.
// Returns an error if libvlc cannot be initialised (missing shared library).
func New() (*Player, error) {
	return newPlayer("Adam", "io.github.silentone12725.Adam")
}

func newPlayer(applicationName, applicationID string) (*Player, error) {
	inst := C.libvlc_new(0, nil)
	if inst == nil {
		return nil, fmt.Errorf("vlc: libvlc_new failed — is libvlc.so.5 in LD_LIBRARY_PATH?")
	}
	mp := C.libvlc_media_player_new(inst)
	if mp == nil {
		C.libvlc_release(inst)
		return nil, fmt.Errorf("vlc: libvlc_media_player_new failed")
	}
	// Stable audio identity lets the desktop mixer retain its per-app settings (from PR #1: https://github.com/silentone12725/apple-music-linux/pull/1).
	name := C.CString(applicationName)
	agent := C.CString("Adam/1.4.1")
	appID := C.CString(applicationID)
	version := C.CString("1.4.1")
	icon := C.CString("adam")
	C.libvlc_set_user_agent(inst, name, agent)
	C.libvlc_set_app_id(inst, appID, version, icon)
	for _, value := range []*C.char{name, agent, appID, version, icon} {
		C.free(unsafe.Pointer(value))
	}
	return &Player{inst: inst, mp: mp, volume: 100}, nil
}

// Load stops any current playback and starts playing url from the beginning.
func (p *Player) Load(url string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.mp == nil {
		return fmt.Errorf("vlc: player closed")
	}

	cURL := C.CString(url)
	defer C.free(unsafe.Pointer(cURL))

	media := C.libvlc_media_new_location(p.inst, cURL)
	if media == nil {
		return fmt.Errorf("vlc: libvlc_media_new_location failed for %s", url)
	}
	defer C.libvlc_media_release(media)

	p.detachLocked()
	C.libvlc_media_player_set_media(p.mp, media)
	p.lastURL = url
	return p.playLocked()
}

// LoadSource stops any current playback and plays src directly through libvlc
// read/seek callbacks — no loopback HTTP. The player takes ownership of src
// and closes it when the media is replaced, stopped or the player is closed.
func (p *Player) LoadSource(src Source) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.mp == nil {
		src.Abort()
		src.Close()
		return fmt.Errorf("vlc: player closed")
	}

	p.detachLocked()
	cm := newCallbackMedia(src)
	media := cm.newMedia(p.inst)
	if media == nil {
		cm.release()
		return fmt.Errorf("vlc: libvlc_media_new_callbacks failed")
	}
	defer C.libvlc_media_release(media)

	C.libvlc_media_player_set_media(p.mp, media)
	p.cur = cm
	p.lastURL = ""
	if err := p.playLocked(); err != nil {
		p.detachLocked()
		return err
	}
	return nil
}

// detachLocked stops playback and frees the current callback source, if any.
// Abort runs first so a Read blocked on an in-progress download returns and
// libvlc_media_player_stop can join the input thread. The media is detached so
// nothing can re-invoke the open callback on a released source.
func (p *Player) detachLocked() {
	if p.cur == nil {
		return
	}
	p.cur.src.Abort()
	C.libvlc_media_player_stop(p.mp)
	C.libvlc_media_player_set_media(p.mp, nil)
	p.cur.release()
	p.cur = nil
}

func (p *Player) playLocked() error {
	p.loadGen++
	if ret := C.libvlc_media_player_play(p.mp); ret != 0 {
		return fmt.Errorf("vlc: play failed (ret %d)", int(ret))
	}
	// Volume/mute belong to the existing player and the desktop mixer. Repeated
	// reapplication here overwrote external mixer changes on every new track.
	return nil
}

// Volume reports the live mixer state rather than the last slider request.
// Together with not re-applying volume on every Load, this is from PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1).
func (p *Player) Volume() (int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp == nil {
		return p.volume, false
	}
	vol := int(C.libvlc_audio_get_volume(p.mp))
	if vol < 0 {
		vol = p.volume
	}
	return vol, C.libvlc_audio_get_mute(p.mp) == 1
}

// SetTime seeks within the currently loaded media to posMs milliseconds.
// If VLC is already playing the call is synchronous (instant disk-cache seek).
// If VLC is still opening (e.g. right after Load), it polls up to 5 s for the
// playing state before applying — so it is safe to call immediately after Load.
func (p *Player) SetTime(posMs int64) {
	if posMs < 0 {
		return
	}
	p.mu.Lock()
	if p.mp == nil {
		p.mu.Unlock()
		return
	}
	state := C.libvlc_media_player_get_state(p.mp)
	p.mu.Unlock()
	if state == C.libvlc_Playing || state == C.libvlc_Paused {
		p.mu.Lock()
		if p.mp != nil {
			C.libvlc_media_player_set_time(p.mp, C.libvlc_time_t(posMs))
		}
		p.mu.Unlock()
		return
	}
	p.mu.Lock()
	myGen := p.loadGen
	p.mu.Unlock()
	go func() {
		// 10s deadline — throttled CPUs take longer to open the HLS stream
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			p.mu.Lock()
			if p.loadGen != myGen {
				p.mu.Unlock()
				return // track changed or player closed — drop seek
			}
			if p.mp == nil {
				p.mu.Unlock()
				return
			}
			state := C.libvlc_media_player_get_state(p.mp)
			if state == C.libvlc_Playing || state == C.libvlc_Paused {
				C.libvlc_media_player_set_time(p.mp, C.libvlc_time_t(posMs))
				p.mu.Unlock()
				return
			}
			p.mu.Unlock()
		}
	}()
}

// Time returns the current position and total length in milliseconds, plus a
// short state string ("playing", "paused", "stopped", "ended", "error").
func (p *Player) Time() (posMs, lengthMs int64, state string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp == nil {
		return 0, 0, "stopped"
	}
	posMs = int64(C.libvlc_media_player_get_time(p.mp))
	lengthMs = int64(C.libvlc_media_player_get_length(p.mp))
	state = vlcStateName(C.libvlc_media_player_get_state(p.mp))
	return
}

// SourceEnded reports whether the attached source delivered all of its data and ended cleanly, as opposed to failing or
// being aborted. libvlc reaching its end while this is false means the read failed, not that the track ended.
func (p *Player) SourceEnded() bool {
	p.mu.Lock()
	cm := p.cur
	p.mu.Unlock()
	return cm != nil && cm.eof.Load()
}

func (p *Player) SourceFailed() bool {
	p.mu.Lock()
	cm := p.cur
	p.mu.Unlock()
	return cm != nil && cm.failed.Load()
}

// Pause pauses playback.
func (p *Player) Pause() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp == nil {
		return
	}
	C.libvlc_media_player_set_pause(p.mp, 1)
}

// Resume resumes playback.
func (p *Player) Resume() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp == nil {
		return
	}
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
	if p.mp == nil {
		return
	}
	C.libvlc_audio_set_mute(p.mp, 0)
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
}

// Stop halts playback immediately without releasing the player.
// The player remains usable for a subsequent Load call.
func (p *Player) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mp != nil {
		p.detachLocked()
		C.libvlc_media_player_stop(p.mp)
		p.loadGen++ // cancel delayed seeks even if no new track follows Stop
	}
}

// Close releases all libvlc resources.
func (p *Player) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loadGen++ // background pollers see stale and never touch the released player
	if p.mp != nil {
		p.detachLocked()
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
