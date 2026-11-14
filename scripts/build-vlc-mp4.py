#!/usr/bin/env python3
"""Build the validated Candidate C module into a DEVELOPMENT runtime only.
User-run compiler entry; never downloads source or touches system/installed VLC.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
PATCH_DIR = REPO / 'patches/vlc/3.0.24'
MARKER = 'playback01-candidate-c.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_candidate(original, patch):
    lines = patch.splitlines(True)
    if len(lines) < 4 or sum(line.startswith('@@ ') for line in lines) != 1:
        raise ValueError('expected the reviewed single-hunk Candidate C patch')
    old = ''.join(line[1:] for line in lines[3:] if line.startswith((' ', '-')))
    new = ''.join(line[1:] for line in lines[3:] if line.startswith((' ', '+')))
    if not old or original.count(old) != 1:
        raise ValueError('source is modified, instrumented, already patched or incompatible')
    candidate = original.replace(old, new, 1)
    actual = ''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True),
                                        fromfile='baseline/mp4.c', tofile='candidate/mp4.c'))
    if actual != patch:
        raise ValueError('Candidate C patch differs from the reviewed diff')
    return candidate


def check_hashes(root, hashes):
    for name, expected in hashes.items():
        if digest(root / name) != expected:
            raise ValueError(f'incompatible baseline: {name}')


def verify_runtime(runtime):
    reference = json.loads((PATCH_DIR / 'runtime-abi.json').read_text())
    if digest(PATCH_DIR / 'playback01-candidate-c.patch') != reference['patchSHA256']:
        raise ValueError('reviewed patch hash mismatch')
    check_hashes(runtime, reference['runtimeHashes'])
    info = json.loads((runtime / MARKER).read_text())
    if info['patchSHA256'] != reference['patchSHA256'] or info['runtimeHashes'] != reference['runtimeHashes']:
        raise ValueError('Candidate C manifest/ABI mismatch')
    if digest(runtime / 'plugins/demux/libmp4_plugin.so') != info['pluginSHA256']:
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
    check_hashes(source, reference['sourceHashes'])
    check_hashes(runtime, reference['runtimeHashes'])
    if (source / 'src/revision.txt').read_text().strip() != reference['sourceRevision']:
        raise ValueError('VLC source revision differs from the validated baseline')
    for package in ['vlc-plugin', 'libvlc']:
        if subprocess.check_output(['pkg-config', '--modversion', package], text=True).strip() != reference['version']:
            raise ValueError(f'{package}: matching VLC 3.0.24 SDK required')
    candidate = apply_candidate((source / 'modules/demux/mp4/mp4.c').read_text(), patch_file.read_text())
    if (runtime / MARKER).exists():
        verify_runtime(runtime)
        print(f'Candidate C already installed and hashes verified: {runtime}')
        return
    build_root = REPO / 'electron/dist/vlc-mp4-build'
    build_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='candidate-c-', dir=build_root))
    copied = work / 'source'
    shutil.copytree(source, copied, symlinks=True)
    (copied / 'modules/demux/mp4/mp4.c').write_text(candidate)
    plugin = work / 'libmp4_plugin.so'
    # Same minimal feature flags as the validated A/B build, without research
    # instrumentation. Link to the exact bundled core rather than an SDK copy.
    command = [os.environ.get('CC', 'gcc'), '-std=gnu11', '-O2', '-g', '-fPIC', '-shared',
               '-D_GNU_SOURCE', '-DHAVE_ATTRIBUTE_PACKED=1', '-DN_(str)=str', '-D_(str)=vlc_gettext(str)',
               '-DNDEBUG', '-DMODULE_STRING="mp4"', '-DMODULE_NAME=mp4', '-DPACKAGE_VERSION="3.0.24"',
               *[str(copied / name) for name in reference['sourceHashes']],
               *shlex.split(subprocess.check_output(['pkg-config', '--cflags', 'vlc-plugin'], text=True)),
               '-I' + str(copied / 'include'), '-I' + str(copied / 'modules'),
               '-I' + str(copied / 'modules/demux'), str(runtime / 'libvlccore.so.9.0.1'), '-lm', '-o', str(plugin)]
    (work / 'command.json').write_text(json.dumps(command, indent=2))
    with (work / 'build.log').open('x') as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    env = dict(os.environ, LD_LIBRARY_PATH=str(runtime))
    dependencies = subprocess.check_output(['ldd', str(plugin)], env=env, text=True)
    (work / 'ldd.txt').write_text(dependencies)
    if 'not found' in dependencies or not any('libvlccore.so.9 =>' in line and str(runtime) + '/' in line for line in dependencies.splitlines()):
        raise ValueError(f'plugin dependencies do not resolve to this runtime; see {work}/ldd.txt')
    # Atomic replacement affects this dev copy only; close Adam before building.
    target = runtime / 'plugins/demux/libmp4_plugin.so'
    shutil.copyfile(plugin, target.with_suffix('.so.new'))
    os.replace(target.with_suffix('.so.new'), target)
    for cache in (runtime / 'plugins').rglob('plugins.dat'):
        cache.unlink()
    info = dict(reference, pluginSHA256=digest(target), patchedSourceSHA256=digest(copied / 'modules/demux/mp4/mp4.c'),
                compiler=subprocess.check_output([command[0], '--version'], text=True).splitlines()[0],
                command=command, buildDirectory=str(work), instrumented=False, tests='NOT_RUN')
    (runtime / MARKER).write_text(json.dumps(info, indent=2) + '\n')
    verify_runtime(runtime)
    print(f'Candidate C staged: {runtime}\nBuild log: {work}/build.log\nRuntime/loader tests: NOT_RUN')


if __name__ == '__main__':
    main()
