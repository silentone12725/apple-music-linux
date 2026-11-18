# Independent PLAYBACK-01 MP4 fragment-clock port

**INDEPENDENT PLAYBACK-01 PR CHECKPOINT — REAL-WORLD VALIDATION PENDING**

Base: `silentone12725/apple-music-linux`, `nightly` at
`7f54c7d4581cbb0d7b1c20d5f22fccd6d809daae`, also the remote tip checked during preparation.
Independent-port checkpoint (2026-11-15): user-built Candidate C and patch/plugin
hash checks PASS; FFmpeg 8 and normvol compatibility builds PASS; FFmpeg ABI
62/62/60, dependency resolution and packaged GLIBC <=2.38 checks PASS.
Natural, Seek, Failure and Lifecycle synthetic regressions PASS. The actual output
is `electron/dist/playback01-validation/run-ophiglfc/summary.json` (not committed).
All four synthetic-probe loader records are valid with exit code 0; this is NOT
actual Adam Engine loader validation. Locale regression tests: 7/7 PASS.

Still pending: complete Engine/Renderer build on the clean nightly baseline,
actual Adam loader verification, original Apple Music track playback, and
release-level compatibility. Earlier diagnosis-baseline results below remain
historical evidence and are not counted as independent-port playback validation.

## Product change and PR #9 independence

`playback01-candidate-c.patch` is Candidate C with a bounded catch-up, SHA256
`9eac960942eba7d147c662811c0a48013d797151eb16d9210c56edff18f3bb09` (three hunks;
`build-vlc-mp4.py` requires each hunk's context to match exactly once and the
regenerated diff to equal the reviewed file byte for byte).
It changes the `DemuxMoof()` exhausted-fragment block: valid selected tracks with
runs bound presentation cursor/PCR advancement to the usual 250ms demux quantum;
retain the fragment until that bound is reached. Otherwise the decoder can finish
while the cursor lags, and final `DemuxFrag()` EOF PCR handling does not repair it.
The catch-up target never exceeds the cursor at the fragment's first exhaustion plus
`DEMUX_INCREMENT + DEMUX_TRACK_MAX_PRELOAD` (15.25s), the most seekable input can
queue ahead of the clock. The bound is fixed once per fragment in
`demux_sys_t.context` and cleared by `FragResetContext()` (new fragment and seek),
so a corrupt final sample duration cannot hold EndReached; beyond the bound the
stock EOF handling applies. The original block only considered invalid (`!b_ok`)
tracks, whose time never advances; non-seekable input selects every valid track
in `DemuxFrag()`, so dropping its `!b_selected && !b_seekable` clause is equivalent.
There is no fixed position offset, duration, decoder or audio-output change.
The earlier unbounded Candidate C (SHA256 `b39a6cea…`) is what the historical and
first independent real-playback results below measured.

Existing upstream call chain:

- `electron/main.mjs`: `_vlcDir` selects `dist/resources/vlc`; `engineLibEnv()`
  sets the child Engine's library/plugin paths.
- `engine/core/vlc/player.go`: `New()` calls `libvlc_new`; `LoadSource()` already
  calls `libvlc_media_new_callbacks`, and `Load()` creates HTTP/location media.
- `engine/cmd/handlers_vlc.go`: chooses those existing source paths and `Time()`
  reads the public media clock affected by the MP4 demux cursor.

Candidate C calls none of PR #9's cache writer, gapless precache, ALAC gate,
HTTP fallback, ownership, retry or advance code. Callback media already exists on
this base. Those Go/Renderer files remain **unchanged**. Cherry-pick conflicts
came from the larger diagnostics checkpoint, not a Candidate C function dependency.
Native Observer is optional evidence tooling: this PR adds no observer API,
Go/C bridge, renderer tracing or authentication code. Its separate synthetic C
probe uses public libVLC APIs only and is never linked into Adam.

`runtime-abi.json` deliberately pins six source units, the SRPM's internal revision,
VLC 3.0.24 SDK and exact validated libVLC/core hashes. A different distro binary
or source is rejected, not assumed compatible from its soname. This third-party
SDK/runtime eligibility constraint is not a dependency on PR #9. Stock packaging
remains default; Candidate C requires explicit opt-in even for a cached bundle.

For the already-staged runtime GLIBC correction, follow [GLIBC-COMPATIBILITY.md](GLIBC-COMPATIBILITY.md). Its concrete build/stage commands supersede the older environment examples below.

## User build

Use this worktree and existing upstream build prerequisites / Git LFS inputs.
Provide unpacked matching VLC source, headers and stock libraries, for example
through the existing SDK container. These scripts do not fetch or install them.
Do not reuse the diagnosis branch's Engine, renderer or temporary A/B build output.

```bash
cd /var/home/h97m/Projects/adam-next-playback01-pr
export VLC_SOURCE=/absolute/path/to/unpacked/vlc-3.0.24
export ADAM_VLC_LIBDIR="$(pkg-config --variable=libdir libvlc)"
export ADAM_VLC_PLUGINS="$ADAM_VLC_LIBDIR/vlc/plugins"
export ADAM_VLC_CANDIDATE_C_SOURCE="$VLC_SOURCE"
bash scripts/bundle-vlc.sh
```

The existing bundler stages to `electron/dist/resources/vlc`. `ADAM_VLC_DEST`
can select another `vlc` directory under this worktree's `electron/dist/`.
The helper validates source/ABI, copies source to a new build directory, applies
only the reviewed patch and links against the bundled core. It records argv,
hashes and logs, atomically replaces only the copied MP4 plugin, and invalidates
that copy's plugin cache. Other bundle dependency/glibc checks remain in place.
If a version/hash/compatibility check fails, stop rather than relax it or substitute
unknown binaries. No system VLC or daily Adam installation is modified.

For an app test, build the **upstream-baseline** Engine and Renderer here, with
this worktree's normal prerequisites already configured as in the main README:

```bash
make -C drm libdrm_client.so android-stubs
bash scripts/build-engine.sh electron/dist/resources
cd electron
npm run build:engine
cd ..
```

This PR changes no Go/Renderer source. Building them is required to obtain a clean
baseline app rather than copying the PR #9 binary. Normal lossless runtime setup
is still the upstream README's responsibility; no session material is copied.

## FFmpeg ABI compatibility for this VLC build

ELF inspection of the staged runtime found three FFmpeg consumers:

| Plugin | Required FFmpeg SONAMEs |
|---|---|
| codec/libavcodec_plugin.so | libavcodec.so.62, libavutil.so.60 |
| demux/libavformat_plugin.so | libavformat.so.62, libavcodec.so.62, libavutil.so.60 |
| packetizer/libpacketizer_avparser_plugin.so | libavcodec.so.62, libavutil.so.60 |

The tracked Adam FFmpeg 9 runtime uses 63/61. Different SONAME majors cannot replace
62/60. Keep FFmpeg 9 unchanged for remux/export; build a matching minimal FFmpeg 8
compatibility runtime using the existing build-vlc-ffmpeg.sh, then copy its entire
shared-library set beside libVLC. The existing Engine library-path order already
supports both ABIs. This avoids rebuilding/porting VLC's FFmpeg plugins to FFmpeg 9.
There are no fake cross-major symlinks and no Candidate C or application changes.

For the currently staged Candidate C runtime, close Adam and run these commands
inside the existing build environment. Set both source paths to real unpacked
sources. Use the same FFmpeg 8 source version as the container's VLC plugins; the
builder rejects wrong source major ABIs before compilation.

```bash
cd /var/home/h97m/Projects/adam-next-playback01-pr
# Restore existing tracked FFmpeg 9 assets if they are still Git LFS pointers.
git lfs pull --include='third_party/ffmpeg/**' --exclude=''
FFMPEG_SRC=/absolute/path/to/matching-ffmpeg-8-source \
ADAM_VLC_PLUGINS="$PWD/electron/dist/resources/vlc/plugins" \
bash scripts/build-vlc-ffmpeg.sh "$PWD/electron/dist/vlc-ffmpeg-62"
export ADAM_VLC_FFMPEG_LIBDIR="$PWD/electron/dist/vlc-ffmpeg-62"
export ADAM_VLC_CANDIDATE_C_SOURCE=/absolute/path/to/validated/vlc-3.0.24
bash scripts/bundle-vlc.sh
python3 scripts/check-vlc-ffmpeg.py \
  --plugins "$PWD/electron/dist/resources/vlc/plugins" \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --ffmpeg-libdir "$PWD/third_party/ffmpeg/lib"
LD_LIBRARY_PATH="$PWD/electron/dist/resources/vlc:$PWD/third_party/ffmpeg/lib" \
  ldd third_party/ffmpeg/bin/ffmpeg
```

No --force or Candidate C rebuild is needed: the existing plugin hash is verified.
Cached bundles now also stage compatibility libraries and run dependency/glibc
checks; they no longer return early after an earlier incomplete stage. For a fresh
bundle, build the compatibility libraries against the matching system plugin tree
first, and set ADAM_VLC_FFMPEG_LIBDIR for the initial bundler invocation.

The checker scans every bundled FFmpeg consumer, checks transitive av/sw libraries
with ldd -r, rejects missing relocations and dependencies outside the two bundled
roots, and compares requested names with the real ELF SONAME. The existing Pulse
support and glibc checks remain enabled. FFmpeg 9's ldd output must still resolve
63/61 and its matching sw libraries from third_party/ffmpeg/lib, with no missing
libraries. Neither a 63-to-62 alias nor host /lib64 fallback counts as success.

The user has now built and validated the independent compatibility runtime:
ABI 62/62/60 and dependency resolution PASS. The earlier LFS-pointer observation
was a preparation-time condition; no downloaded LFS assets are included in this
commit. FFmpeg 9 operation and actual application playback remain unverified.

## Focused checks and actual loader (user executes)

Supply a short unprotected fragmented ALAC (~6.25s, longer than 3s for Seek).
No historical doc source, private cache or A/B artifact is required. With an FFmpeg
build supporting lavfi and ALAC, a new synthetic fixture can be generated locally:

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

If the bundled minimal FFmpeg lacks generation features, provide a suitable public
synthetic fixture instead. Do not use protected audio. The script compiles
`scripts/tests/vlc_native_probe.c` and checks natural EndReached/tail position,
Seek, failure and three-generation Pause/Resume/Stop/Replace, then `nonseek` (no seek
callback: neither seekable nor pace-controlled; no length, so no residual check, and
the first late buffers stock VLC also drops are tolerated) and `future`: a copy of the
fixture whose final sample duration is 0xFFFFFFFF (`scripts/mp4_fixture.py`; the
final trun must carry per-sample durations) must reach EndReached within media length
+ 15.25s + 5s. Every case verifies
actual loaded libraries and writes new JSON/summary output. Every PASS condition is an
explicit check raising `ValidationError` (non-zero exit), so `python3 -O` cannot skip
it; malformed or incomplete probe JSON fails too. Raw PCR is explicitly
**NOT_MEASURED**; source-failure coverage is bounded, not all network/cache recovery.

Close other Adam instances. Launch/login/play only by the user through the normal
upstream workflow, keeping the opt-in variables above exported:

```bash
cd electron
bash build.sh
```

The existing launcher (including its existing sandbox option) is unchanged.
During ALAC playback, run from the worktree root with the real Engine PID:

```bash
python3 scripts/vlc_runtime.py \
  --runtime "$PWD/electron/dist/resources/vlc" --pid "$(pgrep -n -x engine)"
```

If several Engines exist, select the correct PID explicitly. The loader must map
this worktree's libvlc, libvlccore and MP4 plugin, not simply have environment
variables set. This clean branch has no diagnosis `_adamPlayback01` API. Observe
the existing UI/time endpoint and natural completion/advance; return the synthetic
summary, loader JSON and observed final position. No HAR, profile or auth log needed.

## Evidence and remaining limits

User-completed results on the **PR #9-containing diagnosis baseline**:

| Check | Historical result |
|---|---|
| Original ALAC A/B | Length271280ms both; position268550→271181ms, residual2730→99ms; Playing→EndReached~271.414s both; loader PASS, no native error |
| Synthetic A/B | 8/8 PASS; ALAC161 hold2250.8→251.0ms, max PCR step2280000→250000us; no PCR/position regressions; equal decode/play counts, no loss |
| Five ALAC tracks | 5/5 ending-time PASS; residuals200/0/0/0/200ms |
| Development integration | 4/4 focused checks and actual loader PASS |
| DEV original song | Length271280ms, position271080ms, residual200ms; lifecycle~271.426s; no native/poll errors/drops; next track played |

**These historical results do not validate the independent nightly port.**
The independent runtime build, ABI/GLIBC checks and four synthetic regressions
are now separately PASS as recorded above. Full application build, actual Adam
loader and real-world playback validation remain pending. The standalone fixture covers the existing seekable
callback transport, not every HTTP/nonseekable mode. Release gaps remain:
nonseekable historical failures, ASan/UBSan, full PCM/sample timeline, dynamic
selection, complex AV reorder, broader failures, full distro configure and other
MP4 codecs. MP4 demux is shared across codecs; this is not ALAC-only code.
The separate one-off stall/ALAC warning and Renderer undefined.id advance issue
remain deferred; no fixes for them are included.

## Proposed PR

Title: **fix(vlc): correct MP4 fragment end-of-stream clock progression**

> Fragmented ALAC can finish naturally while VLC's media position remains about
> 2.73 seconds short. Add the validated Candidate C MP4 demux correction as an
> explicit source/ABI-pinned development opt-in: advance exhausted selected
> fragments in bounded demux steps instead of holding the presentation cursor.
>
> This is independent of PR #9's cache, gapless, source-loading and retry changes.
> No Go/Renderer/DRM code or Native Observer is imported. Stock packaging remains
> default; standalone build, synthetic checks and actual-loader verification are
> included.
>
> Historical diagnosis-branch evidence (which includes PR #9): residual2730→99ms
> with unchanged~271.414s lifetime; 8/8 synthetic, 5/5 ALAC and 4/4 development
> checks passed. Independently on nightly, the user-built Candidate C, FFmpeg 8
> and normvol runtime passed ABI 62/62/60, packaged GLIBC <=2.38 and dependency
> checks, plus all four synthetic regressions. Locale regressions: 7/7 PASS.
> Full Engine/Renderer build, actual Adam loader and real-world playback remain
> pending. Release validation is required. Nonseekable, sanitizer, full PCM, complex AV and
> broad codec/release coverage remain pending; production raw PCR is not measured.
