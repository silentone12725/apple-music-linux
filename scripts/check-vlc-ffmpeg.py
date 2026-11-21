#!/usr/bin/env python3
"""Verify all bundled VLC FFmpeg consumers and their transitive SONAME closure."""
import argparse
import os
from pathlib import Path
import re
import subprocess

FFMPEG = re.compile(r'lib(?:avcodec|avformat|avutil|avfilter|avdevice|swresample|swscale|postproc)\.so\.\d+$')


def dynamic(path):
    # NEEDED/SONAME labels and loader errors are localized by binutils/glibc.
    return subprocess.check_output(['readelf', '-d', str(path)],
                                   env=dict(os.environ, LC_ALL='C', LANG='C'), text=True)


def needed(path):
    return re.findall(r'\(NEEDED\).*Shared library: \[([^]]+)\]', dynamic(path))


def consumers(plugins):
    return {p: [n for n in needed(p) if FFMPEG.fullmatch(n)]
            for p in sorted(plugins.rglob('*.so'))}


def check_resolved(name, target, roots):
    resolved = target.resolve()
    if not any(resolved.is_relative_to(root.resolve()) for root in roots):
        raise ValueError(f'{name} resolves outside the bundled VLC/FFmpeg directories: {target}')
    match = re.search(r'\(SONAME\).*Library soname: \[([^]]+)\]', dynamic(resolved))
    if not match or match[1] != name:
        raise ValueError(f'{name} does not match the actual ELF SONAME: {target}')


def verify(plugins, runtime, ffmpeg):
    users = {p: names for p, names in consumers(plugins).items() if names}
    if not users:
        raise ValueError('no VLC FFmpeg consumers found; check the plugin directory')
    env = dict(os.environ, LC_ALL='C', LANG='C', LD_LIBRARY_PATH=str(runtime.resolve()) + os.pathsep + str(ffmpeg.resolve()))
    env.pop('LD_PRELOAD', None)
    for plugin, direct in users.items():
        output = subprocess.check_output(['ldd', '-r', str(plugin)], env=env, text=True, stderr=subprocess.STDOUT)
        errors = [line for line in output.splitlines() if 'not found' in line or 'undefined symbol:' in line]
        if errors:
            detail = '; '.join(errors[:4])
            if len(errors) > 4:
                detail += f'; (+{len(errors) - 4} more)'
            raise ValueError(f'{plugin.name}: unresolved ELF dependency/relocation: ' + detail)
        resolved = {}
        for line in output.splitlines():
            match = re.match(r'\s*(\S+)\s+=>\s+(.+?)\s+\(0x[0-9a-fA-F]+\)', line)
            if match and FFMPEG.fullmatch(match[1]):
                resolved[match[1]] = Path(match[2])
            missing = re.match(r'\s*(\S+)\s+=>\s+not found', line)
            if missing and FFMPEG.fullmatch(missing[1]):
                raise ValueError(f'{plugin.name}: missing {missing[1]}')
        for name in direct:
            if name not in resolved:
                raise ValueError(f'{plugin.name}: unresolved {name}')
        for name, target in resolved.items():
            check_resolved(name, target, [runtime, ffmpeg])
        print(f'{plugin.name}: PASS ({", ".join(sorted(resolved))})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugins', type=Path, required=True)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--ffmpeg-libdir', type=Path)
    parser.add_argument('--needed-only', action='store_true')
    args = parser.parse_args()
    if not args.plugins.is_dir():
        parser.error('plugin directory is missing')
    if args.needed_only:
        names = sorted({n for values in consumers(args.plugins).values() for n in values})
        if not names:
            raise SystemExit('no FFmpeg SONAME requirements found')
        print('\n'.join(names))
    else:
        if args.runtime is None or args.ffmpeg_libdir is None:
            parser.error('--runtime and --ffmpeg-libdir are required for verification')
        verify(args.plugins, args.runtime, args.ffmpeg_libdir)


if __name__ == '__main__':
    main()
