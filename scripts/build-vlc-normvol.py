#!/usr/bin/env python3
"""USER RUN: rebuild the existing VLC 3.0.24 normvol module with older glibc."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('glibc', REPO / 'scripts/check-vlc-glibc.py')
glibc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(glibc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='unmodified VLC 3.0.24 source tree')
    source = parser.parse_args().source.resolve()
    glibc.check_build_env()
    runtime = REPO / 'electron/dist/resources/vlc'
    reference = json.loads((REPO / 'patches/vlc/3.0.24/runtime-abi.json').read_text())
    if (source / 'src/revision.txt').read_text().strip() != reference['sourceRevision']:
        raise ValueError('matching VLC 3.0.24 source required')
    core = runtime / 'libvlccore.so.9.0.1'
    out = REPO / 'electron/dist/vlc-normvol-glibc238'
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out) as work:
        plugin = Path(work) / 'libnormvol_plugin.so'
        command = ['gcc', '-std=gnu11', '-O2', '-fPIC', '-shared', '-D_GNU_SOURCE',
                   '-D__PLUGIN__', '-D_FILE_OFFSET_BITS=64', '-DHAVE_ATTRIBUTE_PACKED=1',
                   '-DN_(str)=str', '-D_(str)=vlc_gettext(str)', '-DNDEBUG',
                   '-DMODULE_STRING="normvol"', '-DMODULE_NAME=normvol', '-DPACKAGE_VERSION="3.0.24"',
                   '-I' + str(source / 'include'), str(source / 'modules/audio_filter/normvol.c'),
                   str(core), '-lm', '-Wl,-soname,libnormvol_plugin.so', '-o', str(plugin)]
        subprocess.run(command, check=True)
        report = glibc.audit(Path(work), '2.38')
        if report['errors'] or any(p['overLimit'] for p in report['bundled']):
            raise ValueError(report)
        dynamic = glibc.readelf('-d', str(plugin))
        if 'Shared library: [libvlccore.so.9]' not in dynamic:
            raise ValueError('normvol must link the existing libvlccore.so.9 ABI')
        shutil.copy2(plugin, out / plugin.name)
        (out / 'command.json').write_text(json.dumps(command, indent=2))
    print(f'Built only: {out}; staging is a separate user step')


if __name__ == '__main__':
    main()
