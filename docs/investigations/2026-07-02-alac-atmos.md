# ALAC and Atmos DRM Path Investigation — 2026-07-02

## Motivation

Following the verified AAC CTR path (see `2026-07-02-drm-paths.md`), this
investigation establishes the DRM format used for ALAC and Atmos content so that
a CBCS `LicenseProvider` can be implemented with runtime-verified behaviour
rather than assumptions.

## Method

```
go run ./cmd/drminspect 1488408568 us
```

adamID 1488408568 is "Blinding Lights" by The Weeknd.
AudioTraits: `[atmos lossless lossy-stereo spatial]` — confirms ALAC and Atmos
are available for this track.

## Catalog enhanced-HLS: all variants

`EnhancedHls: https://aod.itunes.apple.com/…/P1238037727_default.m3u8`

Every variant (12 total) has the **same** EXT-X-KEY regardless of codec:

```
METHOD:            SAMPLE-AES
URI:               skd://itunes.apple.com/P000000000/s1/e1
KEYFORMAT:         com.apple.streamingkeydelivery
KEYFORMATVERSIONS: 1
```

No comma in the URI → `strings.SplitN(uri, ",", 2)` returns one part →
`engine/hls.OpenMedia` leaves `EncryptionInfo = nil` for **all** catalog variants.

### ALAC variant (Variant 1, highest bandwidth)

```
CODECS:    alac
BANDWIDTH: 1,781,673 (1,652 kbps avg)
AUDIO:     audio-alac-stereo-44100-24
URI:       …/P1238037727_A1488408568_audio_en_gr2116_alac.m3u8
EXT-X-MAP: P1238037727_A1488408568_audio_en_gr2116_alac_m.mp4
Segments:  14
```

### Atmos variants (Variants 2–3)

```
Variant 2:  CODECS=ec-3  AUDIO=audio-atmos-2768  770 kbps
Variant 3:  CODECS=ec-3  AUDIO=audio-atmos-2448  450 kbps
```

Both share the same `skd://P000000000/s1/e1` key URI.

### AAC variants (Variants 4–12)

Nine AAC variants at 256/128/64 kbps with stereo, binaural, and downmix
renditions — all use the same `skd://P000000000/s1/e1` key URI.

**Finding:** The catalog enhanced-HLS path uses a single generic FairPlay key URI
for every codec and bitrate. The TCP socket (`Config.DecryptM3u8Port`) handles
all of them identically.

## WebPlayback assets

Six flavors returned for this track:

| Flavor | METHOD | KEY URI | Comma-split? |
|--------|--------|---------|-------------|
| `30:cbcp256` | SAMPLE-AES | `skd://itunes.apple.com/afs_1488408568_31_a_/…` | No → nil |
| `34:cbcp64`  | SAMPLE-AES | `skd://itunes.apple.com/afs_1488408568_35_a_/…` | No → nil |
| `28:ctrp256` | ISO-23001-7 | `data:;base64,AAAAAFi3T/gAHZQU3cEXCA==` | **Yes → works** |
| `32:ctrp64`  | ISO-23001-7 | `data:;base64,AAAAAFi3T/gAIWm3NThmBQ==` | **Yes → works** |
| `37:ibhp256` | SAMPLE-AES | `https://play.itunes.apple.com/…/identityKeyRequest/…` | No → nil |
| `38:ibhp64`  | SAMPLE-AES | (same HTTPS format, different path)            | No → nil |

**Finding (scoped to this track):** The WebPlayback API returned no ALAC or
Atmos assets for adamID 1488408568.  All six flavors are AAC at different
bitrates.  Whether ALAC or Atmos assets ever appear in webplayback responses
— on different storefronts, account tiers, or for other content — has not
been investigated.

## DRM method taxonomy (observed for this track)

Three distinct key delivery systems:

### 1. CENC/CTR (ISO-23001-7)
- Flavors: `28:ctrp256`, `32:ctrp64`
- METHOD: `ISO-23001-7`
- KEY URI: `data:;base64,[base64-kid]`
- Key acquisition: Widevine CDM via wrapper server HTTP endpoint
- Engine: **implemented** (`engine/fairplay`, `runv3.AcquireKey`)

### 2. FairPlay CBCS (streamingkeydelivery)
- Sources: catalog enhanced-HLS (all variants); WebPlayback `30:cbcp256`, `34:cbcp64`
- METHOD: `SAMPLE-AES`
- KEYFORMAT: `com.apple.streamingkeydelivery`
- KEY URI:
  - Catalog: generic `skd://itunes.apple.com/P000000000/s1/e1`
  - WebPlayback CBCS: content-specific `skd://itunes.apple.com/afs_<adamID>_<n>_a_/…`
- Key acquisition: TCP socket at `Config.DecryptM3u8Port`
- Engine: **not yet implemented**

### 3. AES identity key (HTTPS)
- Flavors: `37:ibhp256`, `38:ibhp64`
- METHOD: `SAMPLE-AES`
- KEYFORMAT: `identity`
- KEY URI: full HTTPS URL to Apple's `identityKeyRequest` endpoint
- KEY IV: explicit 16-byte IV present
- Key acquisition: unknown; not used by any legacy code path
- Engine: **not implemented, not planned**

## Legacy code path for ALAC/Atmos

Traced from `main.go` and `stream.go`:

1. `extractMedia(track.M3u8, false)` where `track.M3u8 = ExtendedAssetUrls.EnhancedHls`
2. Opens the enhanced-HLS master playlist
3. Variant selection:
   - ALAC: `Codecs == "alac"` AND `sampleRate <= Config.AlacMax` (first match, sorted by avg bandwidth descending)
   - Atmos: `Codecs == "ec-3"` AND `Audio` contains `"atmos"` AND `bitrate <= Config.AtmosMax`
4. Returns the selected variant URL (this is the media playlist URL)
5. `runv2.Run(adamId, mediaPlaylistURL, outfile, Config)`:
   a. Fetches the media playlist → parses segments
   b. Opens the init segment file (`segments[0].URI` as the main download URL)
   c. Downloads the fMP4 file (streaming or buffered)
   d. Dials `Config.DecryptM3u8Port` TCP socket
   e. Processes fMP4 through TCP socket: sends key URI (`skd://P000000000/s1/e1`), sends encrypted fragment data, receives decrypted data
   f. Reassembles decrypted fMP4 into output

The TCP socket is a **stateful bidirectional decryption proxy**, not a simple
"return the key" service.

## Runtime verification — 2026-07-02

All four hypotheses are now verified.  See also
`docs/investigations/2026-07-02-tcp-socket-protocol.md` for the
full byte-level protocol trace.

**Hypothesis A — CONFIRMED:** The TCP socket is a decryption proxy.
Wire-verified via socat trace: client sends key URI + encrypted sample
bytes, socket returns decrypted bytes of equal length in-place.

**Hypothesis B — CONFIRMED:** `P000000000/s1/e1` is a prefetch
placeholder.  Wire-confirmed: SendString("0") + prefetch URI sent for
fragment 0; SendString(adamID) + content URI sent for fragment 1 (on
key rotation).  Socket processed all 14 fragments correctly.

**Hypothesis C — CONFIRMED:** All 14 ALAC segments are byte ranges of
one file (`P1238037727_A1488408568_audio_en_gr2116_alac_m.mp4`).
Engine downloads the file as a single HTTP GET, processes it
sequentially.

**Hypothesis D — CONFIRMED:** `Source.Stream()` is the correct
abstraction.  The `CBCSSource.Stream()` implementation in
`engine/fairplay/cbcs.go` is end-to-end verified (see below).

## Engine end-to-end results — 2026-07-02

Both ALAC and Atmos were verified end-to-end through the engine API:

```
POST /api/v1/playback {"assetId":"1488408568","storefront":"us","capabilities":{"lossless":true}}
→ HTTP 201  codec=alac  sampleRate=44100  bitDepth=24

GET /api/v1/playback/{id}/audio
→ 40 MB fMP4
→ mp4box: 14 fragments, 2171 samples, 00:03:21.569
→ codec=alac  rate=44100  channels=2  depth=24
```

```
POST /api/v1/playback {"assetId":"1488408568","storefront":"us","capabilities":{"atmos":true}}
→ HTTP 201  codec=atmos

GET /api/v1/playback/{id}/audio
→ 19 MB fMP4
→ mp4box: 14 fragments, 6252 samples, 00:03:20.064
→ codec=ec-3 (Enhanced AC-3)  rate=48000  channels=6
```

**ffprobe note:** ffprobe reports `duration=14.95s` for both outputs.
This is a known ffmpeg quirk with HLS CMAF fMP4 files (`hlsf` brand) —
ffprobe reads only the first fragment's duration from the init segment
and stops.  mp4box reads all fragments correctly and reports the correct
3:21 / 3:20 durations.  The decrypted content is fully correct.

See `docs/investigations/2026-07-02-tcp-socket-protocol.md` for the
full byte-level protocol trace.

## Open questions

1. Does the TCP socket handle the specific `skd://` WebPlayback CBCS URIs
   (`afs_<adamID>_…`) the same way as the generic catalog URI
   (`P000000000/s1/e1`)? Not yet verified.

2. Are there ALAC or Atmos tracks that appear in the WebPlayback assets on
   different storefronts or for different account tiers? Not investigated.

3. What does the `ibhp` (identity-based HLS playback) path require? Not planned.

## How to rerun

```bash
go run ./cmd/drminspect <adamID> [storefront]
```

Requires `config.yaml` with a valid `media-user-token`. Bearer token is
auto-fetched if absent.
