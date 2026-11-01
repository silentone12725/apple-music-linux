//go:build !cgo

package vlc

import (
	"errors"
	"io"
)

// Without cgo there is no libvlc, so lossless (ALAC) playback is unavailable. The engine already treats a
// failed New as "no player" (APIServer.vlcPlayer stays nil), so AAC and music videos, which play in the
// browser, are unaffected. This file replaces player.go and callbacks.go only when cgo is off; the API
// below must match theirs.
var ErrUnavailable = errors.New("vlc: built without cgo, lossless playback is unavailable")

// Source mirrors the interface in callbacks.go, which the engine's handlers implement.
type Source interface {
	io.ReadSeeker
	Size() int64
	Abort()
	Close()
}

// Player is never constructed: New always fails.
type Player struct{}

func New() (*Player, error) { return nil, ErrUnavailable }

func (p *Player) Load(string) error            { return ErrUnavailable }
func (p *Player) LoadSource(Source) error      { return ErrUnavailable }
func (p *Player) Volume() (int, bool)          { return 0, false }
func (p *Player) SetTime(int64)                {}
func (p *Player) Time() (int64, int64, string) { return 0, 0, "stopped" }
func (p *Player) SourceEnded() bool            { return false }
func (p *Player) Pause()                       {}
func (p *Player) Resume()                      {}
func (p *Player) SetVolume(int)                {}
func (p *Player) Stop()                        {}
func (p *Player) Close()                       {}
