package vlc

import (
	"reflect"
	"testing"
)

func TestOutputOptions(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		args []string
		bad  bool
	}{
		{name: "defaults"},
		{name: "explicit defaults", env: map[string]string{"ADAM_AUDIO_OUTPUT": "auto", "ADAM_AUDIO_PASSTHROUGH": "off"}},
		{name: "passthrough only", env: map[string]string{"ADAM_AUDIO_PASSTHROUGH": "on"}, args: []string{"--spdif"}},
		{name: "pulse independently", env: map[string]string{"ADAM_AUDIO_OUTPUT": "pulse"}, args: []string{"--aout=pulse"}},
		{name: "ALSA HDMI", env: map[string]string{"ADAM_AUDIO_OUTPUT": "alsa", "ADAM_ALSA_DEVICE": "hdmi:CARD=PCH,DEV=0", "ADAM_AUDIO_PASSTHROUGH": "on"}, args: []string{"--aout=alsa", "--alsa-audio-device=hdmi:CARD=PCH,DEV=0", "--spdif"}},
		{name: "no arbitrary output flags", env: map[string]string{"ADAM_AUDIO_OUTPUT": "alsa --foo"}, bad: true},
		{name: "invalid boolean", env: map[string]string{"ADAM_AUDIO_PASSTHROUGH": "true"}, bad: true},
		{name: "device needs ALSA", env: map[string]string{"ADAM_ALSA_DEVICE": "default"}, bad: true},
		{name: "NUL device", env: map[string]string{"ADAM_AUDIO_OUTPUT": "alsa", "ADAM_ALSA_DEVICE": "hdmi\x00bad"}, bad: true},
		{name: "newline device", env: map[string]string{"ADAM_AUDIO_OUTPUT": "alsa", "ADAM_ALSA_DEVICE": "hdmi\n"}, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o, err := OutputOptionsFromEnv(func(k string) string { return tc.env[k] })
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v wantBad=%v", err, tc.bad)
			}
			if tc.bad {
				return
			}
			args, err := o.Args()
			if err != nil || !reflect.DeepEqual(args, tc.args) {
				t.Fatalf("args=%v err=%v want=%v", args, err, tc.args)
			}
		})
	}
}
