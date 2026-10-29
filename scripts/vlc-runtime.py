#!/usr/bin/env python3
"""Audit trusted build-produced ELF files; never run on untrusted downloads."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

# Reviewed redistribution set. This is intentionally NOT an arbitrary closure copier.
COPY = {
    'libvlc_pulse.so.0': None, 'libsoxr.so.0': None, 'libdvbpsi.so.10': None,
    'libaribb24.so.0': None, 'liba52.so.0': None,
    'libxevdb.so.0': 'xevd', 'libxeveb.so.0': 'xeve',
    'libxevd.so.0': 'xevd', 'libxeve.so.0': 'xeve',
}
# Host contracts at the direct ELF dependency boundary. Their own closure is
# supplied by the target distribution, not copied out of the build host.
SYSTEM = set('''libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1
libresolv.so.2 libutil.so.1 libgcc_s.so.1 libstdc++.so.6 libatomic.so.1 libgomp.so.1
libz.so.1 libbz2.so.1.0 libbz2.so.1 liblzma.so.5 libzstd.so.1
libpulse.so.0 libasound.so.2 libgnutls.so.30 libxml2.so.2 libxml2.so.16
libdbus-1.so.3 libudev.so.1 libsystemd.so.0 libX11.so.6 libxcb.so.1
libpng16.so.16 libGL.so.1 libEGL.so.1 libdrm.so.2 libwayland-client.so.0
libmpg123.so.0 libFLAC.so.12 libFLAC.so.14 libvorbis.so.0 libvorbisenc.so.2
libogg.so.0 libopus.so.0 libsamplerate.so.0 libspeexdsp.so.1
libgcrypt.so.20 libgpg-error.so.0 libidn.so.12 libidn2.so.0
libproxy.so.1 libintl.so.8'''.split())
CORE = re.compile(r'^(?:ld(?:64)?[-.]|lib(?:c|m|pthread|dl|rt|resolv|util)\.so\.)')
LIB = re.compile(r'.*\.so(?:\..*)?$')


def run(*args, env=None):
    result = subprocess.run(args, text=True, capture_output=True, env=env)
    if result.returncode:
        raise RuntimeError(f"{' '.join(map(str, args))}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def reject_directory_symlinks(root):
    if root.is_symlink():
        raise RuntimeError(f'directory symlink is not allowed: {root}')
    if not root.is_dir():
        raise RuntimeError(f'missing library directory: {root}')

    def scan_error(error):
        raise RuntimeError(f'cannot scan runtime tree: {error}')

    # Do not follow links, including internal links or loops. Check directories
    # before filtering ELF filenames so required-plugin checks cannot bypass this.
    for current, directories, filenames in os.walk(root, followlinks=False, onerror=scan_error):
        for name in directories + filenames:
            path = Path(current) / name
            if path.is_symlink():
                if path.is_dir():
                    raise RuntimeError(f'directory symlink is not allowed: {path}')
                if not path.exists():
                    raise RuntimeError(f'dangling library symlink: {path}')


def files(root):
    reject_directory_symlinks(root)
    candidates = sorted(p for p in root.rglob('*') if LIB.fullmatch(p.name))
    for path in candidates:
        if path.is_symlink() and not path.exists():
            raise RuntimeError(f'dangling library symlink: {path}')
        if path.is_file() and not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError(f'library symlink escapes package: {path}')
    return [p for p in candidates if p.is_file()]


def inside(path, roots):
    return any(path.resolve().is_relative_to(r.resolve()) for r in roots)


def resolve_system_loader(needed, output, resolved, env):
    # Native GNU x86_64 only. Other architectures remain fail-closed until
    # their interpreter names/output have explicit coverage; never copy a loader.
    name = 'ld-linux-x86-64.so.2'
    if name not in needed:
        return set()
    # Identify the native interpreter independently of the candidate's search
    # paths. A familiar basename alone does not establish system-loader identity.
    native_env = {k: v for k, v in env.items() if k != 'LD_LIBRARY_PATH'}
    program = run('readelf', '-lW', str(Path(sys.executable).resolve()), env=native_env)
    match = re.search(r'Requesting program interpreter: ([^\]]+)\]', program)
    if not match or Path(match[1]).name != name:
        raise RuntimeError(f'cannot confirm native GNU loader for DT_NEEDED {name}')
    interpreter = Path(match[1]).resolve(strict=True)
    candidates = {Path(path) for path in re.findall(
        r'^\s*(/\S+)\s+\(0x[0-9a-f]+\)\s*$', output, re.M)
        if Path(path).name == name}
    if name in resolved:
        candidates.add(Path(resolved[name]))
    if not candidates:
        raise RuntimeError(f'cannot resolve DT_NEEDED {name}: no matching system loader line')
    for candidate in candidates:
        if candidate.name != name or candidate.resolve(strict=True) != interpreter:
            raise RuntimeError(f'unverified system loader {name}: {candidate} (native interpreter: {interpreter})')
    dynamic = run('readelf', '-dW', str(interpreter), env=native_env)
    if re.findall(r'\(SONAME\).*?\[(.*?)\]', dynamic) != [name]:
        raise RuntimeError(f'system loader SONAME does not match DT_NEEDED {name}: {interpreter}')
    resolved[name] = str(interpreter)
    return {name}


def audit(vlc, ffmpeg, collect=False, max_glibc='2.38', source_dirs=()):
    roots = [vlc.resolve(), ffmpeg.resolve()]
    # Match engineLibEnv's VLC-before-FFmpeg order; do not inherit host overrides.
    env = {k: v for k, v in os.environ.items()
           if k not in ('LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT')}
    env.update(LC_ALL='C', LD_LIBRARY_PATH=os.pathsep.join(map(str, roots)))
    notices = Path(__file__).resolve().parent / 'licenses'
    host_contracts = set()
    while True:
        changed = False
        errors = []
        objects = files(vlc) + files(ffmpeg)
        # Reject core libraries before spawning tools with the bundle's search
        # path: a bundled libc could otherwise break the audit tools themselves.
        for obj in objects:
            if CORE.match(obj.name):
                raise RuntimeError(f'{obj}: core system library must not be bundled')
        # Static ELF metadata may be shared; loader resolutions must remain
        # specific to each root (ancestor DT_RPATH can change indirect loads).
        dynamics = {obj: run('readelf', '-dW', str(obj), env=env) for obj in objects}
        owned = {obj.name for obj in objects}
        for dynamic in dynamics.values():
            owned.update(re.findall(r'\(SONAME\).*?\[(.*?)\]', dynamic))
        for obj in objects:
            try:
                license_name = COPY.get(obj.name)
                if license_name and obj.parent.resolve() == vlc.resolve():
                    notice = notices / f'{license_name}-COPYING'
                    packaged_notice = vlc / 'licenses' / notice.name
                    if collect:
                        packaged_notice.parent.mkdir(exist_ok=True)
                        shutil.copyfile(notice, packaged_notice)
                    elif not packaged_notice.is_file():
                        errors.append(f'{obj}: missing redistribution notice {packaged_notice}')
                dynamic = dynamics[obj]
                needed = re.findall(r'\(NEEDED\).*?\[(.*?)\]', dynamic)
                versions = run('readelf', '-VW', str(obj), env=env)
                required = [tuple(map(int, v.split('.'))) for v in re.findall(r'GLIBC_([0-9.]+)', versions)]
                if required and max(required) > tuple(map(int, max_glibc.split('.'))):
                    errors.append(f'{obj}: requires GLIBC_{".".join(map(str, max(required)))} (limit {max_glibc})')
                if not needed:
                    continue
                # ldd uses the actual loader, including DT_RPATH / DT_RUNPATH.
                # It is used only for trusted locally-built objects.
                output = run('ldd', str(obj), env=env)
                for line in output.splitlines():
                    if 'not found' in line:
                        errors.append(f'{obj}: unresolved dependency: {line.strip()}')
                resolved = dict(re.findall(r'^\s*(\S+)\s+=>\s+(/.*?)\s+\(0x[0-9a-f]+\)', output, re.M))
                system_loaders = resolve_system_loader(needed, output, resolved, env)
                for name in dict.fromkeys([*needed, *resolved]):
                    # SYSTEM libraries own their external closure. Still inspect
                    # every private/bundled dependency in this root's snapshot,
                    # even when reached indirectly through another library.
                    private = name in COPY or name in owned or re.match(
                        r'^lib(?:avcodec|avformat|avutil|avfilter|avdevice|swresample|swscale)\.so(?:\.|$)', name)
                    if name not in needed and not private:
                        continue
                    target = resolved.get(name)
                    if target is None and collect and name in COPY:
                        # Private VLC support libraries may live outside ldconfig.
                        # These paths are collection sources, never runtime paths.
                        target = next((str(d / name) for d in source_dirs
                                       if (d / name).is_file()), None)
                    if target is None:
                        errors.append(f'{obj}: cannot resolve DT_NEEDED {name}')
                        continue
                    target = Path(target)
                    if inside(target, roots):
                        continue
                    if name in owned:
                        errors.append(f'{obj}: bundle provides {name} but loader uses {target}; check RPATH')
                        continue
                    if name in system_loaders:
                        host_contracts.add(name)
                        continue
                    if name in COPY:
                        if not collect:
                            errors.append(f'{obj}: {name} resolves outside package: {target}')
                            continue
                        dest = vlc / name
                        if dest.exists() or dest.is_symlink():
                            errors.append(f'{obj}: {name} exists in bundle but loader uses {target}; check RPATH')
                            continue
                        license_name = COPY[name]
                        if license_name:
                            notice = notices / f'{license_name}-COPYING'
                            if not notice.is_file():
                                raise RuntimeError(f'missing redistribution notice: {notice}')
                            (vlc / 'licenses').mkdir(exist_ok=True)
                            shutil.copyfile(notice, vlc / 'licenses' / notice.name)
                        shutil.copyfile(target.resolve(strict=True), dest)
                        print(f'collect: {obj.name} -> {name} from {target}')
                        changed = True
                    elif name in SYSTEM:
                        host_contracts.add(name)
                    else:
                        errors.append(f'{obj}: unreviewed external dependency {name} -> {target}; bundle a compatible licensed build or review system policy')
            except (RuntimeError, OSError) as error:
                errors.append(f'{obj}: {error}')
        if changed:
            continue  # newly copied libraries must pass the same closure/ABI audit
        if errors:
            raise RuntimeError('\n'.join(sorted(set(errors))))
        print('VLC runtime verified; target-system contracts: ' + ', '.join(sorted(host_contracts)))
        return


def check_plugins(vlc):
    reject_directory_symlinks(vlc)
    for name in ('access/libimem_plugin.so', 'demux/libmp4_plugin.so',
                 'codec/libavcodec_plugin.so'):
        if not (vlc / 'plugins' / name).is_file():
            raise RuntimeError(f'missing required VLC plugin: {name}')
    if not any((vlc / 'plugins/audio_output' / name).is_file()
               for name in ('libpulse_plugin.so', 'libalsa_plugin.so')):
        raise RuntimeError('missing required VLC audio output (PulseAudio or ALSA)')
    for name in ('libvlc.so.5', 'libvlccore.so.9'):
        if not (vlc / name).is_file():
            raise RuntimeError(f'missing required VLC library: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--source-dir', action='append', type=Path, default=[])
    parser.add_argument('--max-glibc', default=os.environ.get('ADAM_MAX_GLIBC', '2.38'))
    parser.add_argument('vlc', type=Path)
    parser.add_argument('ffmpeg', type=Path)
    args = parser.parse_args()
    try:
        reject_directory_symlinks(args.ffmpeg)
        check_plugins(args.vlc)
        audit(args.vlc, args.ffmpeg, args.collect, args.max_glibc, args.source_dir)
    except (RuntimeError, OSError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
