#!/usr/bin/env python3
"""Read-only verification of mapped VLC libraries in a user-selected process."""
import argparse
import importlib.util
import json
from pathlib import Path


def vlc_paths(pid):
    try:
        lines = Path(f'/proc/{pid}/maps').read_text().splitlines()
    except FileNotFoundError:
        return set()
    return {line.split(maxsplit=5)[5] for line in lines if len(line.split(maxsplit=5)) == 6
            and any(name in line for name in ('/libvlc.so.', '/libvlccore.so.', '/libmp4_plugin.so'))}


def expected_paths(runtime):
    return {str((runtime / name).resolve()) for name in
            ['libvlc.so.5', 'libvlccore.so.9', 'plugins/demux/libmp4_plugin.so']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--pid', type=int, required=True, help='Engine PID, while MP4 is playing')
    args = parser.parse_args()
    if args.pid <= 1:
        parser.error('select the actual Engine PID')
    runtime = args.runtime.resolve()
    spec = importlib.util.spec_from_file_location('vlc_build', Path(__file__).with_name('build-vlc-mp4.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_runtime(runtime)
    paths = vlc_paths(args.pid)
    valid = paths == expected_paths(runtime)
    print(json.dumps({'valid': valid, 'paths': sorted(paths), 'expected': sorted(expected_paths(runtime))}, indent=2))
    if not valid:
        raise SystemExit('VLC loader not verified: select the Engine during MP4 playback; do not count this run as PASS.')


if __name__ == '__main__':
    main()
