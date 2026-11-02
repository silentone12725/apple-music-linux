# Experimental spatial selection and native audio output

This change separates the requested stream format from the requested output
route. Neither setting verifies Dolby Atmos JOC or HDMI passthrough.

## Stream preference

Settings → Audio Quality → Spatial audio defaults to **Off**. **Prefer Atmos
stream (experimental)** requests EC-3 for songs using the native audio route
(Lossless Audio enabled, Streaming set to Lossless or Hi-Res Lossless). AAC and
music-video requests keep their existing behavior. Restart after changing the
spatial preference; this avoids reusing prewarmed sessions from the old mode.

The provider requires an exact manifest CODECS token. If a catalog-advertised
Atmos song has no EC-3 variant, it may fall back to ALAC only when the playback
request also permits lossless. It errors if neither permitted format exists;
it never silently selects the highest-bandwidth unrelated format. A track
without the catalog Atmos trait retains the existing ALAC/AAC selection policy.
There is no fallback on authentication, decryption or output failures.

The legacy API codec label `atmos` is retained for compatibility, but it means
**selected EC-3**, not verified JOC. Existing DRM capability flags describe
backend readiness, not output-device or passthrough capability. The MIME codec is `ec-3`; the UI displays
**EC-3**. Native audio sample rate, bit depth and channel count remain unknown
instead of being invented from catalog traits. Average bitrate is reported only
when the selected manifest declares AVERAGE-BANDWIDTH. Peak BANDWIDTH is not
presented as the average audio bitrate. The ALAC quality options remain upstream
preferences; this patch does not add sample-rate measurement or enforce a new
sample-rate ceiling. ALAC quality badges no longer appear before a session has
confirmed the codec.

## Output settings

These startup environment settings are independent of Spatial audio. They are
read when the native player is created and require an application restart.

| Setting | Values | Default |
| --- | --- | --- |
| `ADAM_AUDIO_OUTPUT` | `auto`, `pulse`, `alsa` | `auto` (libVLC default) |
| `ADAM_AUDIO_PASSTHROUGH` | `off`, `on` | `off` (no passthrough override) |
| `ADAM_ALSA_DEVICE` | Exact ALSA device name, only with output `alsa` | Unset |

For example, `ADAM_AUDIO_OUTPUT=alsa`,
`ADAM_ALSA_DEVICE=hdmi:CARD=YourCard,DEV=0` and
`ADAM_AUDIO_PASSTHROUGH=on` request direct ALSA output and libVLC's `--spdif`
option. The device above is a placeholder, not a detected device. `pulse` and
`alsa` require the corresponding Linux VLC output plugin. Invalid settings fail
native-player creation with a logged error rather than silently changing routes.
Defaults preserve the existing `libvlc_new(0, nil)` behavior. No arbitrary VLC
arguments are accepted. Enabling passthrough does not enable spatial selection,
and selecting spatial audio does not enable passthrough.

Actual output depends on the VLC build/plugins, audio server, HDMI device and
receiver. Software volume and Sound Check are not validated for encoded output;
this change does not implement capability detection, automatic DSP bypass, or
prove that the receiver receives the encoded stream. A future hardware test must
check those paths and confirm **Dolby Atmos**, not just Dolby Digital Plus, on
the receiver, as well as seeking, track switching, and ALAC fallback.

## Offline verification

The tests require no Apple account, proprietary runtime, downloaded music or
HDMI device:

- `cd engine && go test ./core/hls ./core/apple`
- `cd engine && CGO_ENABLED=0 go test ./core/vlc`
- With libVLC development libraries: `cd engine && go test -run '^TestOutputOptions$' ./core/vlc`
- `cd electron && node --test test/engine/spatial.test.mjs`

The VLC option test exercises configuration without creating a libVLC instance.
Tests cover absent codecs, explicit fallback permission, correct fallback labels,
exact codec token matching, unknown metadata, opt-in spatial requests, video/AAC
exclusion, playback handoff, output defaults and invalid settings.

Do not use this document as a runtime provisioning or sign-in guide. No
proprietary component, authentication path or live playback has been validated
by these tests.

## Optional Last.fm integration

No Last.fm application credentials are included in the renderer or generated
bundle, and opening Settings no longer seeds credentials. Without a complete
explicit configuration, the UI shows **Not configured** and the main-process
request path returns `not-configured` before signing or fetching. The existing
credential-configuration hook remains available; this change does not configure
it or create credentials. Existing saved configuration and upstream Git history
are not removed, and no credentials are revoked by this source cleanup.
