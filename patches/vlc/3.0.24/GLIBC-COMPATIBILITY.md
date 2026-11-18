# GLIBC compatibility for the bundled VLC runtime

Release packages must run on glibc 2.38 systems and the Flatpak runtime. This page
covers the glibc target, the development-only mode for newer distributions, and the
FFmpeg 8 / normvol rebuilds that brought the Candidate C development runtime under
the target. The patch itself is described in [README.md](README.md).

## Release and development targets

`scripts/check-vlc-glibc.py` audits every ELF under a runtime, whatever its filename,
deduplicating symlinks. It reads only version **needs**, not the version definitions
libc exports. With `--closure` it also resolves each ELF's dependencies with `ldd`.
`readelf` always runs in the C locale. A `readelf` failure, or an ELF with
`DT_VERNEED` whose entries cannot be parsed, is an audit error, never "no
requirement". The exit status fails on bundled ELFs over the ceiling and on
unresolved dependencies. External providers (host libraries `ldd` resolves outside
the runtime) are reported separately: they are not shipped, but a target system must
provide compatible SONAMEs and symbol versions for the whole closure.

- **Release target: 2.38** (`RELEASE_CEILING`), the default everywhere. `bundle-vlc.sh`
  audits with it, and `build-installer.sh` re-audits the packaged `resources/vlc` at
  2.38 whatever the environment says.
- **Development target.** On a newer distribution (Fedora, Arch, Ubuntu 24.04+), set
  `ADAM_MAX_GLIBC` to the host version. The builders and `bundle-vlc.sh` then audit
  against that ceiling, label the report `"target": "development"` and warn that it is
  not a release compatibility PASS. The scanner still runs.
- **Build host.** `build-vlc-ffmpeg.sh` and `build-vlc-normvol.py` refuse a build host
  newer than the selected target: objects built there would need its symbols. Release
  rebuilds therefore run in an older environment (below).

A cached bundle is re-audited on every `bundle-vlc.sh` run, so a bundle built for a
development target fails the next default run and cannot reach a release package.
No audit result is cached. The full recheck takes about 2 s for this runtime
(measured: 107 `readelf` and 69 `ldd` calls).

## Audit of the development runtime (2026-11-15)

The Candidate C development runtime staged from Fedora's VLC 3.0.24 had 69 unique
bundled ELFs and 38 external providers, with no missing dependencies on that host.
The bundled outliers above 2.38 were:

| Origin | ELF (relative to runtime) | Requirement / triggering symbol |
|---|---|---|
| Fedora VLC plugin | plugins/audio_filter/libnormvol_plugin.so | GLIBC_2.43 / sqrtf |
| FFmpeg 8 built on the host | libavcodec.so.62 | GLIBC_2.43 / atan2f |
| FFmpeg 8 built on the host | libswscale.so.9 | GLIBC_2.43 / atan2f |

The other 66 met the ceiling; libvlc, libvlccore and the Candidate C MP4 plugin need
at most GLIBC_2.38. These three were rebuilt in an older environment (below), after
which the packaged-runtime audit passed at 2.38. This runtime is not claimed to run on
glibc 2.35: its libVLC core itself needs 2.38.

normvol is kept, not dropped: the Fedora plugin is rebuilt from the unchanged VLC
3.0.24 source against the same libvlccore ABI (NEEDED: libvlccore.so.9, libm.so.6,
libc.so.6). Do not substitute an older distribution's VLC headers or core.

External providers over 2.38 on that host (not copied into the runtime):

| Provider | Host requirement |
|---|---|
| libasound.so.2 | GLIBC_2.43 |
| libgnutls.so.30 | GLIBC_2.43 |
| libgpg-error.so.0 | GLIBC_2.42 |
| libmp3lame.so.0 | GLIBC_2.43 |
| libopus.so.0 | GLIBC_2.43 |

On a glibc 2.38 target these come from the target's own packages. Never bundle a
rolling host's copies or its libc. Check them on the target system before claiming
complete target compatibility.

## Rebuild in an older environment

An Ubuntu 22.04 (glibc 2.35) container, separate from the VLC SDK container
([distrobox](https://distrobox.it/usage/distrobox-create/)):

```bash
distrobox create --name adam-vlc-glibc238 --image docker.io/library/ubuntu:22.04 --yes
distrobox enter adam-vlc-glibc238
```

Inside that container, from the repository root:

```bash
sudo apt-get update
sudo apt-get install -y build-essential nasm pkg-config patchelf binutils python3 zlib1g-dev ca-certificates
python3 scripts/check-vlc-glibc.py --check-build-env
FFMPEG_SRC=/path/to/ffmpeg-8-source \
ADAM_VLC_PLUGINS="$PWD/electron/dist/resources/vlc/plugins" \
bash scripts/build-vlc-ffmpeg.sh "$PWD/electron/dist/vlc-ffmpeg-62-glibc238"
python3 scripts/build-vlc-normvol.py --source /path/to/vlc-3.0.24
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-ffmpeg-62-glibc238
python3 scripts/check-vlc-glibc.py --runtime electron/dist/vlc-normvol-glibc238
```

`build-vlc-ffmpeg.sh` checks the source's major ABI (62/62/60) against the staged
plugins before compiling, then the produced SONAMEs and the output's glibc needs
before copying. `build-vlc-normvol.py` takes the unmodified source with `--source`,
checks its revision against `runtime-abi.json`, builds only that module and writes to
`electron/dist/vlc-normvol-glibc<target>`, so a development build never replaces the
release one. Staging is a separate step.

## Stage the replacements

With Adam closed, on the host, from the repository root:

```bash
cp -a electron/dist/vlc-ffmpeg-62-glibc238/lib*.so.* electron/dist/resources/vlc/
cp electron/dist/vlc-normvol-glibc238/libnormvol_plugin.so electron/dist/resources/vlc/plugins/audio_filter/
rm -f electron/dist/resources/vlc/plugins/plugins.dat
python3 scripts/check-vlc-glibc.py \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --library-dir "$PWD/third_party/ffmpeg/lib" --closure
python3 scripts/check-vlc-ffmpeg.py \
  --plugins "$PWD/electron/dist/resources/vlc/plugins" \
  --runtime "$PWD/electron/dist/resources/vlc" \
  --ffmpeg-libdir "$PWD/third_party/ffmpeg/lib"
```

Stop on any failure, and review every `overLimit` field, external providers included.
Then run the synthetic checks and the actual-loader check from [README.md](README.md).
Finally, repeat the closure audit on a real glibc 2.38 target with its own runtime
dependencies. If a SONAME or symbol is missing there, record it and stop; do not
alias another ABI. The 2.35 build container cannot run the 2.38 core, so it is not a
runtime-validation environment.
