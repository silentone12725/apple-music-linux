#!/usr/bin/env python3
"""Audit bundled GLIBC requirements and the current host's dependency closure."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def version(value):
    return tuple(map(int, value.split('.')))


def required_versions(text):
    # Definitions exported by libc itself are not requirements.
    needs = text.split('Version needs section', 1)
    return sorted(set(re.findall(r'Name: GLIBC_([0-9.]+)', needs[1] if len(needs) == 2 else '')), key=version)


def maximum(path):
    values = required_versions(subprocess.check_output(['readelf', '--version-info', str(path)], text=True))
    return values[-1] if values else None


def check_build_env():
    value = subprocess.check_output(['getconf', 'GNU_LIBC_VERSION'], text=True).strip()
    if not value.startswith('glibc ') or version(value.split()[1]) > (2, 38):
        raise ValueError(f'build requires glibc <= 2.38, found {value}; use the compatibility container')
    print(value)


def audit(root, limit, library_dirs=(), closure=False):
    bundled, external, errors, seen = [], {}, [], set()
    env = dict(os.environ, LC_ALL='C', LD_LIBRARY_PATH=os.pathsep.join(map(str, [root, *library_dirs])))
    env.pop('LD_PRELOAD', None)
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.resolve() in seen:
            continue
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        seen.add(path.resolve())
        value = maximum(path)
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
                    value = maximum(resolved)
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
    parser.add_argument('--max', default='2.38')
    parser.add_argument('--closure', action='store_true', help='also resolve every ELF transitive dependency using ldd')
    parser.add_argument('--check-build-env', action='store_true')
    args = parser.parse_args()
    if version(args.max) > (2, 38):
        parser.error('the GLIBC ceiling cannot exceed 2.38')
    if args.check_build_env:
        check_build_env()
    else:
        if not args.runtime:
            parser.error('--runtime required')
        report = audit(args.runtime.resolve(), args.max, [p.resolve() for p in args.library_dir], args.closure)
        print(json.dumps(report, indent=2))
        raise SystemExit(int(bool(report['errors'] or any(p['overLimit'] for p in report['bundled']))))


if __name__ == '__main__':
    main()
