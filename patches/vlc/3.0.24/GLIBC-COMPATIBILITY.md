# Independent port: GLIBC compatibility build

Checkpoint 2026-11-15: user compilation of FFmpeg 8 and normvol PASS;
Candidate C build/hash checks, ABI 62/62/60 and dependency resolution PASS;
packaged GLIBC <=2.38 PASS (69 bundled ELFs, no outliers or unresolved entries
in `electron/dist/glibc-audit-after.json`). Four synthetic regressions PASS in
`electron/dist/playback01-validation/run-ophiglfc`. Locale tests: 7/7 PASS.
These local JSON/build artifacts are deliberately not committed. Actual Adam
loader, complete Engine/Renderer build, real playback and release-level target
compatibility remain pending. Codex did not compile, launch or play the app.

## Complete pre-build audit (2026-11-15)

The local pre-build audit covered 69 unique bundled ELFs and all 38 external
providers resolved by ldd (including the loader); raw host-specific JSON is not
part of this commit.
No missing dependencies were observed on the current host. All bundled outliers:

| Origin | ELF (relative to runtime) | Requirement / triggering symbol |
|---|---|---|
| Fedora VLC plugin | plugins/audio_filter/libnormvol_plugin.so | GLIBC_2.43 / sqrtf |
| Newly built FFmpeg 8 | libavcodec.so.62 | GLIBC_2.43 / atan2f |
| Newly built FFmpeg 8 | libswscale.so.9 | GLIBC_2.43 / atan2f |

All other 66 bundled ELFs satisfy the ceiling. libvlc.so.5, libvlccore.so.9 and
Candidate C libmp4_plugin.so require at most GLIBC_2.38. Thus this runtime is NOT
claimed to run on GLIBC 2.35, even though new replacement artifacts are built there.

normvol is byte-for-byte identical (cmp) to the existing adam-vlc-dev container's
`/usr/lib64/vlc/plugins/audio_filter/libnormvol_plugin.so`, owned by
`vlc-plugins-base-3.0.24-1.fc44.x86_64`. Its NEEDED libraries are libvlccore.so.9,
libm.so.6 and libc.so.6; its SONAME is libnormvol_plugin.so. Keep the filter and
rebuild its unchanged VLC 3.0.24 source against the existing core ABI. Do not
substitute Ubuntu's older VLC headers/core. The helper takes the unmodified VLC
3.0.24 source tree with `--source` and checks its revision against `runtime-abi.json`.

External host-provider outliers (not copied into the VLC runtime):

| Provider | Current host requirement |
|---|---|
| libasound.so.2 | GLIBC_2.43 |
| libgnutls.so.30 | GLIBC_2.43 |
| libgpg-error.so.0 | GLIBC_2.42 |
| libmp3lame.so.0 | GLIBC_2.43 |
| libopus.so.0 | GLIBC_2.43 |

These are additional target-environment checks, not evidence that the shipped
ELFs directly require those GLIBC versions. A GLIBC <=2.38 target must provide
compatible SONAMEs AND symbol versions for the entire closure. Host ldd alone
cannot establish that. Do not bundle the rolling host's copies, or copy its libc.
The scanner reports external providers separately; its exit status rejects bundled
outliers and unresolved dependencies. Inspect external outliers explicitly before
claiming complete target compatibility. No runtime validation was disabled.

## User commands: isolated build environment

Ubuntu 22.04 uses GLIBC 2.35:
https://packages.ubuntu.com/jammy/libc6
Distrobox creation syntax: https://distrobox.it/usage/distrobox-create/
This new container is separate from adam-vlc-dev. Run on the host:

```bash
distrobox create --name adam-vlc-glibc238 --image docker.io/library/ubuntu:22.04 --yes
distrobox enter adam-vlc-glibc238
```

Inside the NEW container only (not on Bazzite):

```bash
sudo apt-get update
sudo apt-get install -y build-essential nasm pkg-config patchelf binutils python3 zlib1g-dev ca-certificates
cd /var/home/h97m/Projects/adam-next-playback01-pr
getconf GNU_LIBC_VERSION
python3 scripts/check-vlc-glibc.py --check-build-env
FFMPEG_SRC="$PWD/electron/dist/ffmpeg-source/ffmpeg-8.0.3" \
ADAM_VLC_PLUGINS="$PWD/electron/dist/resources/vlc/plugins" \
bash scripts/build-vlc-ffmpeg.sh "$PWD/electron/dist/vlc-ffmpeg-62-glibc238"
python3 scripts/build-vlc-normvol.py --source <unmodified VLC 3.0.24 source tree>
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-ffmpeg-62-glibc238
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-normvol-glibc238
exit
```

The release target is glibc 2.38 (`RELEASE_CEILING` in `check-vlc-glibc.py`). Both
builders reject a build host newer than the target, since its objects would need
that host's symbols. On a newer distribution (Fedora, Arch, Ubuntu 24.04+), a
development-only build sets `ADAM_MAX_GLIBC` to the host version: the builders and
`bundle-vlc.sh` then audit against that ceiling, label the report
`"target": "development"` and warn that it is not a release compatibility PASS.
The scanner itself always runs. `build-vlc-normvol.py` writes to
`electron/dist/vlc-normvol-glibc<target>` so a development build never replaces
the release one. A cached bundle is re-audited on every `bundle-vlc.sh` run (about
2 s for this runtime: 107 `readelf` and 69 `ldd` calls, measured), so a development
bundle fails the default 2.38 run; `build-installer.sh` also re-audits the packaged
`resources/vlc` at 2.38 whatever `ADAM_MAX_GLIBC` is. No audit result is cached.
FFmpeg preflight still strictly checks
source major ABIs 62/62/60 against the staged plugins; it checks produced SONAMEs
and every output ELF's GLIBC requirements before copying. `check-vlc-glibc.py` runs
`readelf` in the C locale whatever the user's locale, and fails closed: a `readelf`
failure, or an ELF with `DT_VERNEED` whose version-needs entries cannot be parsed,
is an audit error rather than "no GLIBC requirement". The normvol helper
builds only that module, checks its GLIBC and core ABI, and leaves staging separate.
The existing Candidate C patch, MP4 module, core and FFmpeg 9 remain unchanged.

## Stage replacements and validate (host)

Keep Adam closed. These commands update only this worktree's staged runtime and
use the newly built complete FFmpeg 8 set, never third_party/ffmpeg:

```bash
cd /var/home/h97m/Projects/adam-next-playback01-pr
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-ffmpeg-62-glibc238
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-normvol-glibc238
cp -a electron/dist/vlc-ffmpeg-62-glibc238/lib*.so.* electron/dist/resources/vlc/
cp electron/dist/vlc-normvol-glibc238/libnormvol_plugin.so electron/dist/resources/vlc/plugins/audio_filter/
rm -f electron/dist/resources/vlc/plugins/plugins.dat
python3 scripts/check-vlc-glibc.py \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --library-dir "$PWD/third_party/ffmpeg/lib" --closure \
  > electron/dist/glibc-audit-after.json
python3 scripts/check-vlc-ffmpeg.py \
  --plugins "$PWD/electron/dist/resources/vlc/plugins" \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --ffmpeg-libdir "$PWD/third_party/ffmpeg/lib"
```

Stop on any failed command. Review all `overLimit` fields, including external
providers. The full scanner reads only VERSION NEEDS (not exported libc version
definitions), scans every ELF regardless of filename, deduplicates symlinks and
resolves each dependency closure. It never allows --max above 2.38. Cached and
fresh bundle-vlc.sh runs now use this scanner too. No --force is needed for these
replacements; Candidate C is not rebuilt or reselected.

Repeat the closure command on the actual GLIBC 2.38 target with its installed
runtime dependencies. If a SONAME or symbol is missing, record that provider and
stop; do not alias another ABI. The 2.35 build container cannot run the existing
2.38 core and therefore is not the runtime-validation environment.

## Four short synthetic regressions and actual loader (user only)

Use the existing matching SDK container, after staging succeeds:

```bash
distrobox enter adam-vlc-dev
cd /var/home/h97m/Projects/adam-next-playback01-pr
mkdir -p electron/dist/playback01-validation
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=6.25' \
  -c:a alac -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 -n electron/dist/playback01-validation/synthetic-alac.m4a
python3 scripts/validate-vlc-mp4.py \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --ffmpeg-libdir "$PWD/third_party/ffmpeg/lib" \
  --fixture "$PWD/electron/dist/playback01-validation/synthetic-alac.m4a"
exit
```

If that fixture already exists, reuse it and skip generation (the -n flag protects
it). The four cases are natural ending, seek, source failure, and lifecycle;
each checks actual loaded core/MP4 paths. No Apple Music or protected audio.
User compilation, replacement artifact GLIBC/ABI and four synthetic regressions
are now PASS. Target-system release compatibility and FFmpeg 9 operation remain
unverified; synthetic probe loader success does not establish Adam loader success.

## Checks actually executed for this change

- Python unittest discovery: 11 tests PASS (Candidate C pure tests, FFmpeg ABI,
  FFmpeg source-header ABI, GLIBC requirement parsing/numeric ordering/build guard).
- Bash syntax for both modified shell scripts: PASS.
- Python AST syntax for both new helpers: PASS.
- Scoped git diff --check: PASS.
- Full current-runtime scan: correctly FAILS with all three bundled GLIBC_2.43
  outliers, reports all 38 external providers and no unresolved dependencies.
- Actual host build guard: correctly rejects glibc 2.44 before compilation.
- Attempt to set scanner ceiling to 2.43: correctly rejected.

Only the independent worktree was edited; no commit or push was made. The original
worktree, Candidate C patch/module, application sources and runtime artifacts were
not modified. The user subsequently rebuilt and staged compatible replacements, with the
passing independent-port results recorded at the top of this document.
