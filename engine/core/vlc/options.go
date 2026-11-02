package vlc

import (
	"fmt"
	"strings"
)

// OutputOptions requests an output route. Passthrough asks libVLC to preserve
// encoded audio; it is not a capability check or evidence of HDMI/JOC output.
// Zero values preserve the existing libVLC defaults.
type OutputOptions struct {
	Output      string
	Passthrough bool
	ALSADevice  string
}

// OutputOptionsFromEnv reads only the documented audio settings. No arbitrary
// VLC flags are accepted. Configuration is fixed for the player's lifetime.
func OutputOptionsFromEnv(getenv func(string) string) (OutputOptions, error) {
	o := OutputOptions{Output: getenv("ADAM_AUDIO_OUTPUT"), ALSADevice: getenv("ADAM_ALSA_DEVICE")}
	switch getenv("ADAM_AUDIO_PASSTHROUGH") {
	case "", "off":
	case "on":
		o.Passthrough = true
	default:
		return OutputOptions{}, fmt.Errorf("ADAM_AUDIO_PASSTHROUGH must be off or on")
	}
	if _, err := o.Args(); err != nil {
		return OutputOptions{}, err
	}
	return o, nil
}

// Args is pure so output configuration can be tested without loading libVLC.
func (o OutputOptions) Args() ([]string, error) {
	var args []string
	switch o.Output {
	case "", "auto":
	case "pulse", "alsa":
		args = append(args, "--aout="+o.Output)
	default:
		return nil, fmt.Errorf("ADAM_AUDIO_OUTPUT must be auto, pulse or alsa")
	}
	if o.ALSADevice != "" {
		if o.Output != "alsa" {
			return nil, fmt.Errorf("ADAM_ALSA_DEVICE requires ADAM_AUDIO_OUTPUT=alsa")
		}
		if strings.ContainsAny(o.ALSADevice, "\x00\r\n") || strings.TrimSpace(o.ALSADevice) != o.ALSADevice {
			return nil, fmt.Errorf("ADAM_ALSA_DEVICE contains invalid whitespace or NUL")
		}
		args = append(args, "--alsa-audio-device="+o.ALSADevice)
	}
	if o.Passthrough {
		args = append(args, "--spdif")
	}
	return args, nil
}
