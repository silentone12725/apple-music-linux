// Package manifest resolves an Apple Music EnhancedHls master playlist to the
// media-playlist URL for a requested audio format.
//
// This logic was previously inlined in main.go's extractMedia, coupled to the
// package-level download-mode globals (dl_atmos, dl_aac). It is extracted here
// so both the legacy CLI and out-of-tree tools (cmd/parity) resolve variants
// through one code path — a prerequisite for a valid legacy-vs-engine parity
// comparison. Selection is byte-for-byte identical to the original loop.
package manifest

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/grafov/m3u8"

	"apple-music-cli/utils/structs"
)

// Format selects which variant to pick from the master playlist.
type Format int

const (
	// FormatALAC selects the highest ALAC variant within Config.AlacMax.
	FormatALAC Format = iota
	// FormatAtmos selects Dolby Atmos (ec-3) within Config.AtmosMax, falling
	// back to Dolby Audio (ac-3) — matching the legacy dl_atmos branch.
	FormatAtmos
	// FormatAAC selects the AAC variant matching Config.AacType.
	FormatAAC
)

// Selection is the resolved variant plus display metadata the caller may print.
type Selection struct {
	MediaURL string // absolute media-playlist URL
	Display  string // normal-mode line the legacy CLI printed for this pick ("" if none)
	Quality  string // human-readable quality tag (unchanged from legacy)
}

var aacStereoRe = regexp.MustCompile(`audio-stereo-\d+`)

// FetchMaster fetches and decodes a master playlist. The returned base URL is
// used to resolve relative variant URIs.
func FetchMaster(masterURL string) (*m3u8.MasterPlaylist, *url.URL, error) {
	base, err := url.Parse(masterURL)
	if err != nil {
		return nil, nil, err
	}
	resp, err := http.Get(masterURL)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, errors.New(resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	from, listType, err := m3u8.DecodeFrom(strings.NewReader(string(body)), true)
	if err != nil || listType != m3u8.MASTER {
		return nil, nil, errors.New("m3u8 not of master type")
	}
	return from.(*m3u8.MasterPlaylist), base, nil
}

// SelectVariant picks the media-playlist URL for f from an already-fetched
// master. It performs no I/O and reads no globals — the exact variant-selection
// logic lifted from the legacy extractMedia, parameterized by Format and cfg.
func SelectVariant(master *m3u8.MasterPlaylist, base *url.URL, f Format, cfg structs.ConfigSet) (Selection, error) {
	sort.Slice(master.Variants, func(i, j int) bool {
		return master.Variants[i].AverageBandwidth > master.Variants[j].AverageBandwidth
	})

	for _, variant := range master.Variants {
		switch f {
		case FormatAtmos:
			if variant.Codecs == "ec-3" && strings.Contains(variant.Audio, "atmos") {
				split := strings.Split(variant.Audio, "-")
				lengthInt, err := strconv.Atoi(split[len(split)-1])
				if err != nil {
					return Selection{}, err
				}
				if lengthInt <= cfg.AtmosMax {
					mediaURL, err := base.Parse(variant.URI)
					if err != nil {
						return Selection{}, err
					}
					return Selection{
						MediaURL: mediaURL.String(),
						Display:  variant.Audio,
						Quality:  split[len(split)-1] + " Kbps",
					}, nil
				}
			} else if variant.Codecs == "ac-3" { // Dolby Audio fallback
				mediaURL, err := base.Parse(variant.URI)
				if err != nil {
					return Selection{}, err
				}
				split := strings.Split(variant.Audio, "-")
				return Selection{
					MediaURL: mediaURL.String(),
					Quality:  split[len(split)-1] + " Kbps",
				}, nil
			}

		case FormatAAC:
			if variant.Codecs == "mp4a.40.2" {
				replaced := aacStereoRe.ReplaceAllString(variant.Audio, "aac")
				if replaced == cfg.AacType {
					mediaURL, err := base.Parse(variant.URI)
					if err != nil {
						return Selection{}, err
					}
					split := strings.Split(variant.Audio, "-")
					return Selection{
						MediaURL: mediaURL.String(),
						Display:  variant.Audio,
						Quality:  split[2] + " Kbps",
					}, nil
				}
			}

		default: // FormatALAC
			if variant.Codecs == "alac" {
				split := strings.Split(variant.Audio, "-")
				length := len(split)
				lengthInt, err := strconv.Atoi(split[length-2])
				if err != nil {
					return Selection{}, err
				}
				if lengthInt <= cfg.AlacMax {
					mediaURL, err := base.Parse(variant.URI)
					if err != nil {
						return Selection{}, err
					}
					khz := float64(lengthInt) / 1000.0
					return Selection{
						MediaURL: mediaURL.String(),
						Display:  split[length-1] + "-bit / " + split[length-2] + " Hz",
						Quality:  split[length-1] + "B-" + strconv.FormatFloat(khz, 'f', 1, 64) + "kHz",
					}, nil
				}
			}
		}
	}
	return Selection{}, errors.New("no codec found")
}

// ResolveMediaURL fetches the master and selects the media-playlist URL for f.
// Convenience wrapper for callers that only need the final URL (e.g. cmd/parity).
func ResolveMediaURL(masterURL string, f Format, cfg structs.ConfigSet) (Selection, error) {
	master, base, err := FetchMaster(masterURL)
	if err != nil {
		return Selection{}, err
	}
	return SelectVariant(master, base, f, cfg)
}
