#!/usr/bin/env python3
"""Audit bundled GLIBC requirements and the current host's dependency closure."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def version(value):
    return tuple(map(int, value.split('.')))


def needs_section(text):
    # Only the needs section; definitions/symbols sections may come before or after it.
    sections = re.split(r'^(?=Version \w+ section)', text, flags=re.M)
    return ''.join(s for s in sections if s.startswith('Version needs section'))


def required_versions(text):
    # Definitions exported by libc itself are not requirements.
    return sorted(set(re.findall(r'Name: GLIBC_([0-9.]+)', needs_section(text))), key=version)


def readelf(*args):
    # binutils localizes section headers and labels; parse only the C locale output.
    env = dict(os.environ, LC_ALL='C', LANG='C')
    env.pop('LANGUAGE', None)
    return subprocess.check_output(['readelf', *args], env=env, text=True)


def maximum(path):
    text = readelf('--dynamic', '--version-info', '--wide', str(path))
    # An ELF with DT_VERNEED must yield parsed needs entries; otherwise fail closed.
    if '(VERNEED)' in text and not re.search(r'Name: \S+', needs_section(text)):
        raise ValueError(f'{path}: version needs present but not parsed')
    values = required_versions(text)
    return values[-1] if values else None


def checked_maximum(path, errors, label):
    try:
        return maximum(path)
    except (ValueError, subprocess.CalledProcessError) as error:
        errors.append(f'{label}: GLIBC requirements unreadable: {error}')
        return None


# Release packages must run on glibc 2.38 systems (and the Flatpak runtime).
RELEASE_CEILING = '2.38'


def target_limit():
    # ADAM_MAX_GLIBC above the release ceiling selects a development-only target.
    return os.environ.get('ADAM_MAX_GLIBC') or RELEASE_CEILING


def is_development(limit):
    return version(limit) > version(RELEASE_CEILING)


def check_build_env(limit=None):
    # A host newer than the target links symbols the target lacks; the artifact audit
    # would reject the result, so stop before compiling.
    limit = limit or target_limit()
    value = subprocess.check_output(['getconf', 'GNU_LIBC_VERSION'], text=True).strip()
    if not value.startswith('glibc '):
        raise ValueError(f'cannot read the build host glibc version: {value!r}')
    host = value.split()[1]
    if version(host) > version(limit):
        raise ValueError(f'build host has {value}, newer than the glibc {limit} target. Release: use the '
                         f'compatibility container. Development only: ADAM_MAX_GLIBC={host}')
    if is_development(limit):
        print(f'WARNING: development glibc {limit} target, not release compatible', file=sys.stderr)
    print(value)


def audit(root, limit, library_dirs=(), closure=False):
    bundled, external, errors, seen = [], {}, [], set()
    env = dict(os.environ, LC_ALL='C', LANG='C', LD_LIBRARY_PATH=os.pathsep.join(map(str, [root, *library_dirs])))
    env.pop('LD_PRELOAD', None)
    env.pop('LANGUAGE', None)
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.resolve() in seen:
            continue
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        seen.add(path.resolve())
        value = checked_maximum(path, errors, path.relative_to(root))
        bundled.append({'path': str(path.relative_to(root)), 'required': value,
                        'overLimit': bool(value and version(value) > version(limit))})
        if closure:
            result = subprocess.run(['ldd', str(path)], env=env, capture_output=True, text=True)
            output = result.stdout + result.stderr
            for line in output.splitlines():
                if 'not found' in line:
                    errors.append(f'{path.relative_to(root)}: {line.strip()}')
            if result.returncode and 'not a dynamic executable' not in output:
                errors.append(f'{path.relative_to(root)}: ldd exit {result.returncode}')
            providers = re.findall(r'=> (/\S+)', output)
            providers += re.findall(r'^\s*(/\S+)\s+\(', output, re.M)
            for provider in providers:
                resolved = Path(provider).resolve()
                if not resolved.is_relative_to(root) and str(resolved) not in external:
                    value = checked_maximum(resolved, errors, resolved)
                    external[str(resolved)] = {'required': value,
                        'overLimit': bool(value and version(value) > version(limit))}
    if not bundled:
        errors.append('no ELF files found')
    return {'limit': limit, 'bundled': bundled, 'externalProviders': external, 'errors': errors,
            'externalNote': 'Host providers are not shipped artifacts. Validate their SONAME/symbol closure on the target OS too.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--library-dir', type=Path, action='append', default=[])
    parser.add_argument('--max', default=target_limit(),
                        help=f'GLIBC ceiling (default ADAM_MAX_GLIBC or the {RELEASE_CEILING} release target)')
    parser.add_argument('--closure', action='store_true', help='also resolve every ELF transitive dependency using ldd')
    parser.add_argument('--check-build-env', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+', args.max):
        parser.error(f'invalid GLIBC ceiling {args.max!r}')
    if args.check_build_env:
        check_build_env(args.max)
    else:
        if not args.runtime:
            parser.error('--runtime required')
        report = audit(args.runtime.resolve(), args.max, [p.resolve() for p in args.library_dir], args.closure)
        report['target'] = 'development' if is_development(args.max) else 'release'
        print(json.dumps(report, indent=2))
        if report['target'] == 'development':
            print(f'WARNING: audited against development glibc {args.max}; '
                  f'NOT a release ({RELEASE_CEILING}) compatibility PASS', file=sys.stderr)
        raise SystemExit(int(bool(report['errors'] or any(p['overLimit'] for p in report['bundled']))))


if __name__ == '__main__':
    main()
