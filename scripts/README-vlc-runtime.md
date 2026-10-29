# Linux VLC runtime dependency policy

Build prerequisites now include Python 3.9+, GNU readelf (binutils), and ldd
(glibc). This is a native Linux/glibc audit, not a cross-compilation tool.

`scripts/bundle-vlc.sh` uses `vlc-runtime.py --collect` for both new and reused
bundles. `scripts/build-installer.sh` invokes its verification-only mode against
the final staging directory, before producing adam.run. Neither changes the
application's library environment. Python is a build dependency, not a new app
runtime dependency.

## Policy

* Enumerate every ELF shared library in resources/vlc (including all selected
  plugin categories) and resources/ffmpeg/lib, not just three plugins.
* Read DT_NEEDED and symbol versions with readelf. Use the native loader through
  ldd to resolve actual paths, honoring RPATH/RUNPATH, with only the same VLC then
  FFmpeg search order used by engineLibEnv. Inherited LD_LIBRARY_PATH, LD_PRELOAD
  and LD_AUDIT are removed from the audit subprocesses.
* Validate private/bundled dependency paths in each root ELF's full loader
  snapshot, including indirect loads affected by ancestor DT_RPATH. Packaged
  filenames/SONAMEs, COPY entries and FFmpeg runtime families remain package-owned;
  an outside path overriding them fails even in collection mode. Loader results
  are not cached globally by SONAME. SYSTEM libraries retain their host closure.
* Reject directory symlinks throughout both runtime trees before ELF scanning or
  required-plugin checks; this includes internal directory links and loops.
  Normal in-tree ELF file symlinks remain supported.
* Resolve bundled dependencies recursively by inspecting every packaged ELF.
  Missing dependencies anywhere in each ldd closure fail with the affected ELF
  path and library name.
* Only the small, reviewed COPY table can be collected from the host. Copy only
  when actually required, dereference symlinks into the DT_NEEDED filename, then
  audit the new library too. Source-directory fallbacks cover private VLC
  libraries outside ldconfig; these directories never enter runtime search paths.
* FFmpeg libraries must already be packaged with the plugin's exact SONAMEs;
  never silently borrow the host's libavcodec. ADAM_VLC_FFMPEG_LIBDIR remains
  supported. Prefer scripts/build-vlc-ffmpeg.sh with matching distribution sources
  and --disable-autodetect over copying a distribution's full FFmpeg build.
* SYSTEM is an explicit target-host contract at each packaged ELF's direct
  dependency boundary. It includes glibc, compiler runtimes, compression, desktop
  audio/TLS/XML libraries and selected native audio codec ABIs. Their own closure
  belongs to the target distribution. These are **not** promised on every Linux
  installation: target packages/ABIs must be documented and tested by releases.
* Unknown external dependencies fail, even if ldd succeeds on the build host.
  Review their license and compatibility before extending COPY or SYSTEM; do not
  fix this by appending all ldd output to SYSTEM. A broad system FFmpeg with video,
  network and graphics integrations will deliberately fail this policy.
* A directly needed GNU x86_64 loader may appear in ldd as a bare absolute
  path instead of `name => path`. Accept it as a system-loader contract only
  when DT_NEEDED, the output basename and loader SONAME agree, and the resolved
  path equals the native Python executable's PT_INTERP. Interpreter identification
  runs without the candidate LD_LIBRARY_PATH. Mapped `=>` loader lines undergo
  the same checks. Ordinary bare library paths receive no exemption. Missing,
  mismatched or unidentifiable loaders fail; nothing copies the loader. This
  currently covers native glibc x86_64, not static Python, cross builds or other
  architecture loader spellings. Existing owned-library override checks remain.
* Never collect glibc or a dynamic loader. Reject core libraries found inside the
  package. Preserve ADAM_MAX_GLIBC (default 2.38; older release builds use 2.35),
  checking both VLC and packaged FFmpeg libraries on reuse and at final staging.
* Required: libvlc/libvlccore, callback access, MP4 demux, avcodec, and at least
  PulseAudio or ALSA output. Other selected plugins (including avformat fallback)
  are optional when absent. Once included, their dependencies must be complete;
  no silently unloadable optional plugins.

Existing COPY entries retain the prior project's redistribution decisions.
New EVC entries include baseline and main-profile SONAMEs; distributions that do
not link these libraries never copy or require them. Upstream notices from the
installed Fedora packages are in scripts/licenses and accompany collected EVC
binaries in resources/vlc/licenses:

* XEVD 0.8.0: https://github.com/mpeg5/xevd/blob/master/COPYING
* XEVE 0.7.1: https://github.com/mpeg5/xeve/blob/master/COPYING

These notices distinguish baseline and main-profile source folders. Packaging
checks do not certify patent rights or the licensing of arbitrary alternate
FFmpeg builds. Review the exact binaries used for a release.

## Verification

```sh
bash -n scripts/bundle-vlc.sh scripts/build-installer.sh
python3 -m unittest discover -s scripts/tests -v
git diff --check
python3 scripts/vlc-runtime.py electron/dist/resources/vlc third_party/ffmpeg/lib
python3 scripts/vlc-runtime.py /path/to/linux-unpacked/resources/vlc /path/to/linux-unpacked/resources/ffmpeg/lib
```

The ELF tests compile tiny shared libraries with gcc. They test indirect EVC
collection, not requiring absent EVC, symlink dereferencing, broken/escaping
symlinks, unknown and missing dependencies, system libraries not copied, RPATH
precedence, GLIBC rejection, source-versus-staged resolution, private VLC library
collection, plus the actual bundle script's first build and cache-hit validation.

## Limitations and manual release checks

ldd is for trusted locally built artifacts only. This checks ELF loading, not
dlopen-only dependencies, CPU instruction requirements, GLIBCXX/CXXABI ceilings,
codec functionality, or VLC/Electron execution. System-contract ABI availability
and versions must be validated on target distributions. A successful audit is not
a claim of universal Linux portability.

In Fedora 44 adam-build, run the build with an explicit /usr/lib64 and matching
plugin path. Keep the 2.38 GLIBC limit; a failure is a reason to rebuild libraries
on the supported baseline, not to relax the ceiling for an upstream release.
Inspect both avcodec/avformat and the selected audio output with the final staged
library paths. Check resources/vlc/licenses for any EVC libraries present.

Build in an isolated checkout, extract/install the resulting adam.run into a
separate test location, and leave the working installation untouched. On Bazzite
KDE, launch that version, check VLC plugin loading, and play ALAC Lossless and
Hi-Res tracks. Verify audio output and Electron startup. Repeat on supported
Ubuntu/Arch/Flatpak environments before making compatibility claims. EOF, Seek,
DRM and HTTP/HTTPS behavior are outside this change.
