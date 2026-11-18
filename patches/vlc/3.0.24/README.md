# PLAYBACK-01: VLC 3.0.24 MP4 fragment end-of-stream clock

Fragmented MP4 (seen with ALAC) can finish naturally while VLC's media position stays
about 2.73 s short of the duration. This directory holds an opt-in development patch
for VLC 3.0.24's MP4 demuxer and the tooling to build, pin, stage and validate it.
Stock VLC stays the default; release packages never contain the patched plugin.

**Status.** Current patch SHA256
`9eac960942eba7d147c662811c0a48013d797151eb16d9210c56edff18f3bb09`: automated and
synthetic checks pass (see [Evidence](#evidence)); real Adam playback with this patch
is **pending**. Earlier real-playback results apply to the previous, unbounded patch.

## The change

`playback01-candidate-c.patch` changes the exhausted-fragment branch of `DemuxMoof()`
in `modules/demux/mp4/mp4.c`.

- **Cause.** When every run of a fragment is demuxed, samples up to
  `DEMUX_TRACK_MAX_PRELOAD` ahead are already queued, but the presentation cursor
  (`i_nztime`, which `DEMUX_GET_TIME` reports) stays behind. Stock VLC's branch only
  looked at invalid (`!b_ok`) tracks, so it did nothing for valid ones, and the final
  `DemuxFrag()` EOF handling sets the PCR but not the cursor.
- **Fix.** For valid, selected, non-chapter tracks with runs in the fragment, the
  cursor and PCR advance towards the furthest track end in the usual 250 ms
  `DEMUX_INCREMENT` steps, keeping the fragment until reached. The cursor and PCR
  never move backwards. Non-seekable input selects every valid track in `DemuxFrag()`,
  so dropping stock's `!b_selected && !b_seekable` clause changes nothing there.
- **Bound.** The target is capped at the cursor at the fragment's first exhaustion
  plus `DEMUX_INCREMENT + DEMUX_TRACK_MAX_PRELOAD` (15.25 s): the most seekable input
  queues ahead of the clock. The cap is fixed once per fragment in
  `demux_sys_t.context`, cleared by `FragResetContext()` (new fragment and seek), and
  saturates at `INT64_MAX`. A corrupt final sample duration therefore cannot hold
  EndReached; beyond the cap the stock EOF handling applies.

There is no fixed position offset, and no duration, decoder or audio-output change.
The MP4 demuxer is shared by all codecs; this is not ALAC-specific code.

Upstream call chain (unchanged by this PR): `electron/main.mjs` points the Engine at
`dist/resources/vlc`; `engine/core/vlc/player.go` creates callback media
(`libvlc_media_new_callbacks`, always with a seek callback) or HTTP media;
`engine/cmd/handlers_vlc.go` `Time()` reads the media clock this patch corrects.
No Go, Renderer, DRM or FairPlay code changes, and nothing from PR #9 (cache writer,
gapless precache, ALAC gate, HTTP fallback, retry or advance) is required.

## Pins and build

`runtime-abi.json` pins the six compiled source units, the 21 source-tree headers
they include (`headerHashes`), the source revision, the VLC 3.0.24 SDK version and the
exact libVLC/libvlccore binaries the plugin links against. The `vlc_*.h` SDK headers
come from the version-checked `vlc-plugin` package. A different binary or source is
rejected, not assumed compatible from its soname.

`scripts/build-vlc-mp4.py` (called by `bundle-vlc.sh` when
`ADAM_VLC_CANDIDATE_C_SOURCE` is set):

- checks the pins, copies the source tree, **re-hashes the copy** and patches it. Each
  of the patch's three hunks must match exactly once, and the regenerated diff must
  equal the reviewed patch byte for byte;
- builds like the distro's stock plugin: zlib (`HAVE_ZLIB_H`, compressed `cmov`),
  `-fstack-protector-strong`, `-fstack-clash-protection`, `-fcf-protection`,
  `_FORTIFY_SOURCE=2`, full RELRO, non-executable stack, `-fvisibility=hidden` (only
  `vlc_entry__3_0_0f` is exported, all the VLC loader looks up). The build fails
  unless `readelf` confirms each property. Debug info carries no local paths;
- installs crash-safely: the plugin is copied beside the target and checked against
  the build hash, `plugins.dat` is dropped, the marker `playback01-candidate-c.json`
  is written atomically, then the plugin is renamed into place. A crash never leaves
  an unmarked patched plugin;
- treats a marker that does not verify (interrupted install, older patch or format)
  as a reason to rebuild. Without opt-in, `bundle-vlc.sh` refuses any runtime with a
  marker. The marker holds verification hashes only; compiler, command line and paths
  stay in the build directory's `build-info.json`.

`scripts/build-installer.sh` refuses to package a runtime holding the marker or an
interrupted staging file, and re-audits `resources/vlc` at the glibc 2.38 release
target. See [GLIBC-COMPATIBILITY.md](GLIBC-COMPATIBILITY.md) for the glibc target and
the FFmpeg 8 / normvol compatibility builds.

### Development build

Use the project's normal prerequisites and Git LFS inputs, plus an unpacked VLC 3.0.24
source tree matching `runtime-abi.json` and the matching SDK (for example a Fedora
container with `vlc-devel` 3.0.24). The scripts never download or install anything,
and never touch the system VLC or an installed Adam. Close Adam first. From the
repository root:

```bash
export ADAM_VLC_CANDIDATE_C_SOURCE=/path/to/vlc-3.0.24   # unmodified source tree
export ADAM_VLC_FFMPEG_LIBDIR="$PWD/electron/dist/vlc-ffmpeg-62"  # see FFmpeg below
bash scripts/bundle-vlc.sh          # --force rebuilds the whole stock bundle first
```

`ADAM_VLC_DEST` selects another `vlc` directory under `electron/dist/`. If any version,
hash or compatibility check fails, stop; do not relax it or substitute binaries. To
return to stock VLC, run `bash scripts/bundle-vlc.sh --force` without the variable.

For an app test, build the upstream Engine and Renderer from this tree, then launch
with the variables above still exported:

```bash
make -C drm libdrm_client.so android-stubs
bash scripts/build-engine.sh electron/dist/resources
(cd electron && npm run build:engine && bash build.sh)
```

### FFmpeg ABI for this VLC build

The staged VLC plugins need FFmpeg 8 SONAMEs; the tracked `third_party/ffmpeg` is
FFmpeg 9 (63/61), which cannot stand in for them:

| Plugin | Required FFmpeg SONAMEs |
|---|---|
| codec/libavcodec_plugin.so | libavcodec.so.62, libavutil.so.60 |
| demux/libavformat_plugin.so | libavformat.so.62, libavcodec.so.62, libavutil.so.60 |
| packetizer/libpacketizer_avparser_plugin.so | libavcodec.so.62, libavutil.so.60 |

Keep FFmpeg 9 for remux/export and build a minimal matching FFmpeg 8 with
`scripts/build-vlc-ffmpeg.sh`; `bundle-vlc.sh` copies it beside libVLC
(`ADAM_VLC_FFMPEG_LIBDIR`). The builder rejects a source tree with the wrong major ABI
before compiling. No cross-major symlinks are used.

```bash
git lfs pull --include='third_party/ffmpeg/**' --exclude=''
FFMPEG_SRC=/path/to/matching-ffmpeg-8-source \
ADAM_VLC_PLUGINS="$PWD/electron/dist/resources/vlc/plugins" \
bash scripts/build-vlc-ffmpeg.sh "$PWD/electron/dist/vlc-ffmpeg-62"
```

`scripts/check-vlc-ffmpeg.py` (run by `bundle-vlc.sh`) scans every bundled FFmpeg
consumer, resolves its transitive av/sw libraries with `ldd -r`, rejects missing
relocations and anything outside the bundled roots, and compares requested names
with the real ELF SONAME. A 63-to-62 alias or a host `/lib64` fallback fails.

## Validation tools

**Synthetic checks.** `scripts/validate-vlc-mp4.py` builds `scripts/tests/vlc_native_probe.c`
(public libVLC API only, never linked into Adam) against the SDK, verifies the runtime
marker, and runs six cases on a short unprotected fragmented ALAC fixture (about
6.25 s; longer than 3 s for the seek case). Every case checks that the probe mapped
this runtime's libvlc, libvlccore and MP4 plugin.

| Case | Passes when |
|---|---|
| natural | EndReached, no error, no lost buffers, final residual 0–500 ms, time never backwards |
| seek | as natural after a seek to 3 s (no residual check) |
| failure | an injected read failure ends in EndReached or EncounteredError |
| lifecycle | three play/pause/resume/stop/replace generations emit all events |
| nonseek | no seek callback (not seekable, not pace-controlled): EndReached, no error, time never backwards. VLC reports no length, so no residual; the first late buffers stock VLC also drops are tolerated |
| future | a copy whose final sample duration is 0xFFFFFFFF (`scripts/mp4_fixture.py`; the final trun must carry per-sample durations) reaches EndReached within length + 15.25 s + 5 s |

Every PASS condition raises `ValidationError` on failure, so `python3 -O` cannot skip
it. Malformed or incomplete probe output fails too. Raw PCR is not measured.

```bash
mkdir -p electron/dist/playback01-validation
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=6.25' \
  -c:a alac -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 -n electron/dist/playback01-validation/synthetic-alac.m4a
python3 scripts/validate-vlc-mp4.py \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --ffmpeg-libdir "$PWD/third_party/ffmpeg/lib" \
  --fixture "$PWD/electron/dist/playback01-validation/synthetic-alac.m4a"
```

**Actual Adam loader.** During MP4 playback in Adam, with the real Engine PID:

```bash
python3 scripts/vlc_runtime.py \
  --runtime "$PWD/electron/dist/resources/vlc" --pid "$(pgrep -n -x engine)"
```

It must print `"valid": true`: the Engine has mapped this runtime's libvlc,
libvlccore and MP4 plugin, not merely had environment variables set. Then let the
affected track play to its natural end and note the final position and duration.

**Unit tests** (no compiler, player or network): `python3 -m unittest discover -s
scripts/tests -p 'test_*.py'`, also under `python3 -O`.

## Evidence

Results are kept per patch version. A result for one patch hash is not evidence for
another.

### Current patch (`9eac9609…`, bounded, hardened build)

Automated, on the development stage built by `build-vlc-mp4.py` from the pinned
source (Fedora 44 SDK container, glibc 2.43):

| Check | Result |
|---|---|
| Unit tests (Python 3.14, also `-O`; Python 3.10) | 40/40 PASS |
| Plugin build, pin and hunk checks, crash-safe install, rebuild on a stale marker | PASS |
| ELF: RELRO + BIND_NOW, non-executable stack, stack protector, FORTIFY, zlib, only `vlc_entry__3_0_0f` exported, no local paths | PASS |
| `bundle-vlc.sh` on the stage: FFmpeg ABI 62/62/60, glibc ≤ 2.38 closure (any locale) | PASS |
| `validate-vlc-mp4.py`, all six cases | 6/6 PASS |
| Real Adam playback, actual Engine loader, original track | **PENDING** |

Synthetic comparison on the same runtime with only the MP4 plugin swapped. "stock"
is the Fedora VLC 3.0.24 plugin; "unbounded" is the previous patch. Fixtures: 6.25 s
ALAC, a two-track file (6.25 s selected, 9 s unselected), and audio + MPEG-4 video
(8 s; the audio-only runtime has no video decoder):

| Fixture | stock | unbounded | current |
|---|---|---|---|
| ALAC, seekable: final residual | 350 ms | 0 ms | 0 ms |
| ALAC, non-seekable: end | 6.04 s | 6.04 s | 6.04 s |
| Two tracks, seekable: end / final position | 6.39 s / 5900 ms | 6.39 s / 6250 ms | 6.39 s / 6250 ms |
| Audio + video, seekable: end | 6.39 s | 6.39 s | 6.39 s |
| Final duration 0xFFFFFFFF, seekable | ends 6.2 s | still Playing at 40 s (≈27 h) | ends 21.0 s |
| Same, non-seekable: CPU | 0.03 s | 0.96 s | 0.03 s |

Position was monotonic in every run.

### Previous patch (`b39a6cea…`, unbounded), independent nightly port

User-run on this branch before the bound was added: Candidate C, FFmpeg 8 and normvol
compatibility builds; FFmpeg ABI 62/62/60, dependency resolution and packaged glibc
≤ 2.38 checks; natural, seek, failure and lifecycle synthetic cases; Electron and
Engine builds; actual Engine loader (`valid: true`); DRM/FairPlay initialisation; real
ALAC playback; the originally affected track played to its natural end. All PASS. No
millisecond position measurement was taken on this branch.

### Previous patch, diagnosis branch (contains PR #9)

| Check | Result |
|---|---|
| Original ALAC A/B | length 271280 ms both; final position 268550 → 271181 ms; residual 2730 → 99 ms; Playing → EndReached ≈ 271.4 s both; loader PASS |
| Synthetic A/B | 8/8 PASS; max PCR step 2280000 → 250000 µs; no PCR or position regressions |
| Five ALAC tracks | 5/5 ending-time PASS; residuals 200/0/0/0/200 ms |

### Not covered

Not covered by any result above: A/V files whose video outlasts the audio, with a
video decoder present; seeking while the bounded catch-up runs; non-seekable
fragments longer than 15.25 s (these fall back to the stock lag); compressed `cmov`
playback; ASan/UBSan runs; bit-exact PCM or raw PCR timelines; codecs other than ALAC;
HTTP non-seekable transport; and target-system release compatibility (see
[GLIBC-COMPATIBILITY.md](GLIBC-COMPATIBILITY.md)).
