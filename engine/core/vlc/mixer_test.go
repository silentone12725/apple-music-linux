package vlc

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

type pulseInput struct {
	Index      int               `json:"index"`
	Mute       bool              `json:"mute"`
	Properties map[string]string `json:"properties"`
	Volume     map[string]struct {
		ValuePercent string `json:"value_percent"`
	} `json:"volume"`
}

func ownedPulseInput(t *testing.T) pulseInput {
	t.Helper()
	end := time.Now().Add(4 * time.Second)
	for time.Now().Before(end) {
		out, err := exec.Command("pactl", "-f", "json", "list", "sink-inputs").Output()
		if err != nil {
			t.Fatal(err)
		}
		var inputs []pulseInput
		if err = json.Unmarshal(out, &inputs); err != nil {
			t.Fatal(err)
		}
		for _, input := range inputs {
			if input.Properties["application.process.id"] == strconv.Itoa(os.Getpid()) {
				return input
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("owned PulseAudio stream never opened")
	return pulseInput{}
}
func TestSystemMixerVolumeAndMuteSurviveTrackChange(t *testing.T) {
	if os.Getenv("AML_TEST_PULSE") != "1" {
		t.Skip("opt in to a silent real PulseAudio/PipeWire stream with AML_TEST_PULSE=1")
	}
	p := newTestPlayer(t)
	defer p.Close()
	if err := p.LoadSource(memSource{bytes.NewReader(silentWAV(8))}); err != nil {
		t.Fatal(err)
	}
	input := ownedPulseInput(t)
	for _, args := range [][]string{{"set-sink-input-volume", strconv.Itoa(input.Index), "37%"}, {"set-sink-input-mute", strconv.Itoa(input.Index), "1"}} {
		if out, err := exec.Command("pactl", args...).CombinedOutput(); err != nil {
			t.Fatalf("pactl: %v %s", err, out)
		}
	}
	time.Sleep(700 * time.Millisecond)
	assertMixer := func() {
		t.Helper()
		input = ownedPulseInput(t)
		if !input.Mute {
			t.Fatal("player overwrote system mixer mute")
		}
		for _, ch := range input.Volume {
			if ch.ValuePercent != "37%" {
				t.Fatalf("player overwrote mixer volume: %s", ch.ValuePercent)
			}
		}
	}
	assertMixer()
	if err := p.LoadSource(memSource{bytes.NewReader(silentWAV(8))}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond)
	assertMixer()
	if input.Properties["application.name"] != "Apple Music Linux test" {
		t.Fatalf("wrong mixer application name: %s", input.Properties["application.name"])
	}
}
