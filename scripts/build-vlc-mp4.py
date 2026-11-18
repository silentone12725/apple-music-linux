#!/usr/bin/env python3
"""Build the validated Candidate C module into a DEVELOPMENT runtime only.
User-run compiler entry; never downloads source or touches system/installed VLC.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
PATCH_DIR = REPO / 'patches/vlc/3.0.24'
MARKER = 'playback01-candidate-c.json'
PLUGIN = 'plugins/demux/libmp4_plugin.so'
# Runtime verification fields only: no local paths, compiler or command line.
MARKER_FIELDS = ('version', 'sourceRevision', 'sourceHashes', 'headerHashes', 'runtimeHashes', 'patchSHA256')
# Hardening comparable to the distro-built stock plugin (FORTIFY 2 for older target glibc).
HARDENING = ['-fstack-protector-strong', '-fstack-clash-protection', '-fcf-protection',
             '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=2', '-fvisibility=hidden',
             '-Wl,-z,relro', '-Wl,-z,now', '-Wl,-z,noexecstack']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_candidate(original, patch):
    lines = patch.splitlines(True)
    if len(lines) < 4 or not lines[0].startswith('--- ') or not lines[1].startswith('+++ ') \
            or not lines[2].startswith('@@ '):
        raise ValueError('expected the reviewed Candidate C unified diff')
    hunks = []
    for line in lines[2:]:
        if line.startswith('@@ '):
            hunks.append([])
        else:
            hunks[-1].append(line)
    candidate = original
    for hunk in hunks:
        old = ''.join(line[1:] for line in hunk if line.startswith((' ', '-')))
        new = ''.join(line[1:] for line in hunk if line.startswith((' ', '+')))
        # Every hunk's context must match exactly once: no fuzz, offsets or reapplication.
        if not old or candidate.count(old) != 1:
            raise ValueError('source is modified, instrumented, already patched or incompatible')
        candidate = candidate.replace(old, new, 1)
    actual = ''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True),
                                        fromfile='baseline/mp4.c', tofile='candidate/mp4.c'))
    if actual != patch:
        raise ValueError('Candidate C patch differs from the reviewed diff')
    return candidate


def check_hashes(root, hashes):
    for name, expected in hashes.items():
        if digest(root / name) != expected:
            raise ValueError(f'incompatible baseline: {name}')


def pins(reference):
    return {**reference['sourceHashes'], **reference['headerHashes']}


def readelf(*args):
    env = dict(os.environ, LC_ALL='C', LANG='C')
    env.pop('LANGUAGE', None)
    return subprocess.check_output(['readelf', *args], env=env, text=True)


def hardening_problems(text):
    """Problems in `readelf -lW -dW --dyn-syms -W` output of the built plugin."""
    problems = []
    if 'GNU_RELRO' not in text:
        problems.append('no RELRO segment')
    if not re.search(r'\(FLAGS\)\s.*BIND_NOW|\(FLAGS_1\)\s.*\bNOW\b', text):
        problems.append('no BIND_NOW')
    stack = re.search(r'GNU_STACK(?:\s+\S+){5}\s+(\S+)', text)
    if not stack or 'E' in stack[1]:
        problems.append('executable or missing GNU_STACK')
    if 'Shared library: [libz.so.1]' not in text:
        problems.append('zlib (cmov) support not linked')
    symbols = [line.split() for line in text.splitlines() if re.match(r'\s*\d+:\s', line)]
    imported = {row[7].split('@')[0] for row in symbols if len(row) > 7 and row[6] == 'UND'}
    exported = {row[7].split('@')[0] for row in symbols
                if len(row) > 7 and row[6] != 'UND' and row[4] in ('GLOBAL', 'WEAK')}
    if '__stack_chk_fail' not in imported:
        problems.append('no stack protector')
    if not any(name.startswith('__') and name.endswith('_chk') and name != '__stack_chk_fail' for name in imported):
        problems.append('no _FORTIFY_SOURCE checks')
    if not any(name.startswith('vlc_entry__') for name in exported):
        problems.append('VLC module entry not exported')
    extra = sorted(name for name in exported if not name.startswith('vlc_entry'))
    if extra:
        problems.append('internal symbols exported: ' + ', '.join(extra[:5]))
    return problems


def atomic_write(path, text):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def marker_info(reference, plugin, patched):
    info = {name: reference[name] for name in MARKER_FIELDS}
    info.update(pluginSHA256=digest(plugin), patchedSourceSHA256=digest(patched), instrumented=False)
    return info


def install(runtime, plugin, info):
    """Marker first, then plugin: a crash never leaves an unmarked Candidate C plugin."""
    target = runtime / PLUGIN
    staged = target.with_name(target.name + '.new')
    shutil.copyfile(plugin, staged)
    with staged.open('rb') as stream:
        os.fsync(stream.fileno())
    if digest(staged) != info['pluginSHA256']:
        raise ValueError('staged MP4 plugin differs from the build output')
    for cache in (runtime / 'plugins').rglob('plugins.dat'):
        cache.unlink()
    # From here the marker claims Candidate C; until the swap, verify_runtime fails and
    # bundle-vlc.sh refuses the runtime as stock, so the next build repairs it.
    atomic_write(runtime / MARKER, json.dumps(info, indent=2) + '\n')
    os.replace(staged, target)
    fsync_directory(target.parent)
    return verify_runtime(runtime)


def installed(runtime):
    if not (runtime / MARKER).exists():
        return False
    try:
        verify_runtime(runtime)
        return True
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'Candidate C marker does not verify ({error}); rebuilding.')
        return False


def verify_runtime(runtime):
    reference = json.loads((PATCH_DIR / 'runtime-abi.json').read_text())
    if digest(PATCH_DIR / 'playback01-candidate-c.patch') != reference['patchSHA256']:
        raise ValueError('reviewed patch hash mismatch')
    check_hashes(runtime, reference['runtimeHashes'])
    info = json.loads((runtime / MARKER).read_text())
    if any(info.get(name) != reference[name] for name in MARKER_FIELDS):
        raise ValueError('Candidate C manifest/ABI mismatch')
    if digest(runtime / PLUGIN) != info['pluginSHA256']:
        raise ValueError('installed MP4 plugin differs from the Candidate C build')
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='unmodified validated VLC 3.0.24 source tree')
    parser.add_argument('--runtime', type=Path, required=True, help='already bundled runtime under electron/dist/')
    args = parser.parse_args()
    source, runtime = args.source.resolve(), args.runtime.resolve()
    if not runtime.is_relative_to(REPO / 'electron/dist'):
        raise ValueError('development destination must be under this repo/electron/dist/')
    reference = json.loads((PATCH_DIR / 'runtime-abi.json').read_text())
    patch_file = PATCH_DIR / 'playback01-candidate-c.patch'
    if digest(patch_file) != reference['patchSHA256']:
        raise ValueError('Candidate C patch hash mismatch')
    check_hashes(source, pins(reference))
    check_hashes(runtime, reference['runtimeHashes'])
    if (source / 'src/revision.txt').read_text().strip() != reference['sourceRevision']:
        raise ValueError('VLC source revision differs from the validated baseline')
    for package in ['vlc-plugin', 'libvlc']:
        if subprocess.check_output(['pkg-config', '--modversion', package], text=True).strip() != reference['version']:
            raise ValueError(f'{package}: matching VLC 3.0.24 SDK required')
    if installed(runtime):
        print(f'Candidate C already installed and hashes verified: {runtime}')
        return
    build_root = REPO / 'electron/dist/vlc-mp4-build'
    build_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='candidate-c-', dir=build_root))
    copied = work / 'source'
    shutil.copytree(source, copied, symlinks=True)
    # Verify and patch the snapshot that is compiled, not the tree hashed above.
    check_hashes(copied, pins(reference))
    patched = copied / 'modules/demux/mp4/mp4.c'
    patched.write_text(apply_candidate(patched.read_text(), patch_file.read_text()))
    plugin = work / 'libmp4_plugin.so'
    # Stock feature set (zlib for compressed moov) without research instrumentation.
    # Link to the exact bundled core rather than an SDK copy.
    command = [os.environ.get('CC', 'gcc'), '-std=gnu11', '-O2', '-g', '-fPIC', '-shared', *HARDENING,
               f'-ffile-prefix-map={work}=candidate-c',  # no local paths in debug info
               '-D_GNU_SOURCE', '-DHAVE_ATTRIBUTE_PACKED=1', '-DHAVE_ZLIB_H', '-DN_(str)=str', '-D_(str)=vlc_gettext(str)',
               '-DNDEBUG', '-DMODULE_STRING="mp4"', '-DMODULE_NAME=mp4', '-DPACKAGE_VERSION="3.0.24"',
               *[str(copied / name) for name in reference['sourceHashes']],
               *shlex.split(subprocess.check_output(['pkg-config', '--cflags', 'vlc-plugin'], text=True)),
               '-I' + str(copied / 'include'), '-I' + str(copied / 'modules'),
               '-I' + str(copied / 'modules/demux'), str(runtime / 'libvlccore.so.9.0.1'), '-lz', '-lm', '-o', str(plugin)]
    # Local build metadata stays with the build, never in the runtime marker.
    (work / 'build-info.json').write_text(json.dumps({
        'compiler': subprocess.check_output([command[0], '--version'], text=True).splitlines()[0],
        'command': command, 'runtime': str(runtime)}, indent=2))
    with (work / 'build.log').open('x') as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT, cwd=work)
    problems = hardening_problems(readelf('-lW', '-dW', '--dyn-syms', '-W', str(plugin)))
    if problems:
        raise ValueError('plugin hardening check failed: ' + '; '.join(problems))
    env = dict(os.environ, LD_LIBRARY_PATH=str(runtime))
    dependencies = subprocess.check_output(['ldd', str(plugin)], env=env, text=True)
    (work / 'ldd.txt').write_text(dependencies)
    if 'not found' in dependencies or not any('libvlccore.so.9 =>' in line and str(runtime) + '/' in line for line in dependencies.splitlines()):
        raise ValueError(f'plugin dependencies do not resolve to this runtime; see {work}/ldd.txt')
    # Replacement affects this dev copy only; close Adam before building.
    install(runtime, plugin, marker_info(reference, plugin, patched))
    print(f'Candidate C staged: {runtime}\nBuild log: {work}/build.log\nRuntime/loader tests: NOT_RUN')


if __name__ == '__main__':
    main()
