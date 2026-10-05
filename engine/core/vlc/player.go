// Package vlc wraps libvlc to play a single HTTP audio stream.
// It is used for lossless/ALAC tracks that the browser's MSE cannot handle.
package vlc

// #cgo LDFLAGS: -lvlc
// #include <vlc/vlc.h>
// #include <stdlib.h>
import "C"
import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
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
	volume  int            // 0-200; default 100
	loadGen int            // incremented on each Load; goroutines compare to detect staleness
	cur     *callbackMedia // non-nil while a LoadSource media is attached
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
	return p.playLocked()
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
	myGen := p.loadGen
	vol := p.volume
	if ret := C.libvlc_media_player_play(p.mp); ret != 0 {
		return fmt.Errorf("vlc: play failed (ret %d)", int(ret))
	}
	// A previous libvlc session can leave the player muted even when the
	// requested software volume is non-zero. Clear that state before the
	// audio output is opened.
	C.libvlc_audio_set_mute(p.mp, 0)
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
	// WirePlumber applies its stored per-app stream volume asynchronously after
	// VLC opens the audio device, overriding the libvlc software volume above.
	// Re-apply after VLC reaches playing state so our value lands last.
	go p.reapplyVolumeOnPlay(vol, myGen)
	return nil
}

// reapplyVolumeOnPlay waits until VLC enters playing state then sets the
// libvlc software volume and resets any WirePlumber stream mute via wpctl.
func (p *Player) reapplyVolumeOnPlay(vol int, myGen int) {
	// Wait for VLC to reach Playing state. Bail out immediately if a newer
	// Load() call has fired (myGen no longer matches p.loadGen).
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		p.mu.Lock()
		if p.loadGen != myGen {
			p.mu.Unlock()
			return // stale — new track loaded or player closed
		}
		state := C.libvlc_media_player_get_state(p.mp)
		p.mu.Unlock()
		if state == C.libvlc_Playing {
			break
		}
	}

	// Re-apply libvlc software volume then apply wpctl correction.
	// WirePlumber applies vol=0 asynchronously after VLC opens the audio
	// device; repeated calls ensure our value lands last.
	p.mu.Lock()
	if p.loadGen != myGen {
		p.mu.Unlock()
		return
	}
	C.libvlc_audio_set_mute(p.mp, 0)
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
	log.Printf("[vlc] audio output volume=%d mute=%d", vol, int(C.libvlc_audio_get_mute(p.mp)))
	p.mu.Unlock()

	for range 8 {
		p.mu.Lock()
		stale := p.loadGen != myGen
		p.mu.Unlock()
		if stale {
			return
		}
		resetPipeWireVolume(vol)
		time.Sleep(250 * time.Millisecond)
	}
}

// resetPipeWireVolume targets the sink input owned by this engine process.
// libVLC is embedded in the Go engine, so PipeWire names the stream after the
// engine process rather than after a standalone "vlc" application.
func resetPipeWireVolume(vol int) {
	out, err := exec.Command("pactl", "list", "sink-inputs").Output()
	if err != nil {
		return
	}
	pid := strconv.Itoa(os.Getpid())
	sinkID := ""
	matchesPID := false
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "Sink Input #") {
			sinkID = strings.TrimSpace(strings.TrimPrefix(line, "Sink Input #"))
			matchesPID = false
			continue
		}
		if strings.Contains(line, "application.process.id =") &&
			strings.Contains(line, `"`+pid+`"`) {
			matchesPID = true
		}
		if matchesPID && sinkID != "" {
			_ = exec.Command("pactl", "set-sink-input-mute", sinkID, "0").Run()
			_ = exec.Command("pactl", "set-sink-input-volume", sinkID,
				fmt.Sprintf("%d%%", vol)).Run()
			return
		}
	}
}

// SeekURL stops current playback, loads seekURL, and logs the actual landed
// position once VLC reaches playing state. seekURL should be an HTTP URL with
// a ?t= parameter so the engine can stream from the correct fMP4 fragment,
// bypassing any truncated disk-cached file.
func (p *Player) SeekURL(seekURL string, posMs int64) error {
	p.mu.Lock()
	C.libvlc_media_player_stop(p.mp)
	p.mu.Unlock()

	log.Printf("[vlc seek] ► SEND  requested=%dms  start-time=%.3fs  url=%s", posMs, float64(posMs)/1000.0, seekURL)

	if err := p.Load(seekURL); err != nil {
		return err
	}

	p.mu.Lock()
	myGen := p.loadGen
	p.mu.Unlock()

	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			p.mu.Lock()
			if p.loadGen != myGen {
				p.mu.Unlock()
				log.Printf("[vlc seek] ⚠ stale — new load fired before position confirmed")
				return
			}
			state := C.libvlc_media_player_get_state(p.mp)
			pos := int64(C.libvlc_media_player_get_time(p.mp))
			gen := p.loadGen
			p.mu.Unlock()
			if gen != myGen {
				log.Printf("[vlc seek] ⚠ stale — new load fired before position confirmed")
				return
			}
			if state == C.libvlc_Playing && pos > 0 {
				delta := pos - posMs
				sign := "+"
				if delta < 0 {
					sign = ""
				}
				log.Printf("[vlc seek] ◄ LANDED  requested=%dms  actual=%dms  Δ=%s%dms", posMs, pos, sign, delta)
				return
			}
		}
		log.Printf("[vlc seek] ✗ TIMEOUT — VLC did not reach playing state within 5s (requested=%dms)", posMs)
	}()
	return nil
}

// SeekReload seeks by reloading the current media with the libvlc :start-time
// option. This is reliable for fMP4/ALAC files where set_time silently fails
// (Apple fMP4 fragments lack a usable time→byte index that libvlc can follow).
// VLC estimates the byte offset from the file's duration and bitrate, then
// scans forward to the next valid moof boundary — accurate to ±1 fragment.
func (p *Player) SeekReload(posMs int64) error {
	if posMs < 0 {
		posMs = 0
	}
	p.mu.Lock()
	url := p.lastURL
	vol := p.volume
	p.mu.Unlock()
	if url == "" {
		return nil
	}
	// Strip any existing query string from the URL so :start-time is the only
	// seek parameter (file:// URLs do not accept query strings).
	base := url
	if i := strings.Index(url, "?"); i >= 0 {
		base = url[:i]
	}

	cURL := C.CString(base)
	defer C.free(unsafe.Pointer(cURL))
	media := C.libvlc_media_new_location(p.inst, cURL)
	if media == nil {
		return fmt.Errorf("vlc: libvlc_media_new_location failed for %s", base)
	}
	defer C.libvlc_media_release(media)

	opt := C.CString(fmt.Sprintf(":start-time=%.3f", float64(posMs)/1000.0))
	defer C.free(unsafe.Pointer(opt))
	C.libvlc_media_add_option(media, opt)

	log.Printf("[vlc seek] ► SEND  requested=%dms  start-time=%.3fs  url=%s", posMs, float64(posMs)/1000.0, base)

	p.mu.Lock()
	p.detachLocked()
	C.libvlc_media_player_stop(p.mp)
	C.libvlc_media_player_set_media(p.mp, media)
	p.lastURL = base
	p.loadGen++
	myGen := p.loadGen
	p.mu.Unlock()

	if ret := C.libvlc_media_player_play(p.mp); ret != 0 {
		return fmt.Errorf("vlc: play failed (ret %d)", int(ret))
	}
	C.libvlc_audio_set_volume(p.mp, C.int(vol))
	go p.reapplyVolumeOnPlay(vol, myGen)
	// Verify actual landing position once VLC enters playing state.
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			p.mu.Lock()
			if p.loadGen != myGen {
				p.mu.Unlock()
				log.Printf("[vlc seek] ⚠ stale — new load fired before position confirmed")
				return
			}
			state := C.libvlc_media_player_get_state(p.mp)
			pos := int64(C.libvlc_media_player_get_time(p.mp))
			gen := p.loadGen
			p.mu.Unlock()
			if gen != myGen {
				log.Printf("[vlc seek] ⚠ stale — new load fired before position confirmed")
				return
			}
			if state == C.libvlc_Playing && pos > 0 {
				delta := pos - posMs
				sign := "+"
				if delta < 0 {
					sign = ""
				}
				log.Printf("[vlc seek] ◄ LANDED  requested=%dms  actual=%dms  Δ=%s%dms", posMs, pos, sign, delta)
				return
			}
		}
		log.Printf("[vlc seek] ✗ TIMEOUT — VLC did not reach playing state within 5s (requested=%dms)", posMs)
	}()
	return nil
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
	state := C.libvlc_media_player_get_state(p.mp)
	p.mu.Unlock()
	if state == C.libvlc_Playing || state == C.libvlc_Paused {
		p.mu.Lock()
		C.libvlc_media_player_set_time(p.mp, C.libvlc_time_t(posMs))
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

// SetRate adjusts the playback rate (1.0 = normal, 0.99 = 1% slow, 1.01 = 1% fast).
// Used for gradual drift correction instead of hard SetTime seeks.
func (p *Player) SetRate(rate float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	C.libvlc_media_player_set_rate(p.mp, C.float(rate))
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
