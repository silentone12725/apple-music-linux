#!/usr/bin/env python3
"""USER RUN: short synthetic checks of the newly staged production plugin."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
from mp4_fixture import set_final_duration
from vlc_runtime import expected_paths, vlc_paths

# DEMUX_INCREMENT + DEMUX_TRACK_MAX_PRELOAD: the most the EOS clock may run past the media.
EOS_BOUND_MS = 250 + 15000


class ValidationError(Exception):
    pass


def require(condition, message):
    # Explicit check: PASS/FAIL must not depend on asserts that python -O strips.
    if not condition:
        raise ValidationError(message)


def validate(data, mode, end_limit_ms=None):
    try:
        check_probe_output(data, mode, end_limit_ms)
    except (KeyError, TypeError, IndexError) as error:
        raise ValidationError(f'{mode}: malformed probe output: {error!r}') from error


def check_probe_output(data, mode, end_limit_ms=None):
    require(data['ok'] is True, f'{mode}: probe reported ok=false')
    require(data['events'], f'{mode}: no events recorded')
    require(not data['dropped'], f'{mode}: {data["dropped"]} events dropped')
    rows = data['events']
    ids = {e['eventType'] for e in rows}
    if mode == 'lifecycle':
        for gen in [1, 2, 3]:
            sequence = [e['eventType'] for e in rows if e['generation'] == gen]
            require({260, 261, 262, 10002} <= set(sequence), f'lifecycle generation {gen}: events missing')
            require(260 in sequence[sequence.index(261) + 1:], f'lifecycle generation {gen}: resume Playing event missing')
    elif mode == 'failure':
        require(10007 in ids, 'failure: injected read failure not recorded')
        require(any(e['failed'] for e in rows), 'failure: no failed state recorded')
        require(265 in ids or 266 in ids, 'failure: neither EndReached nor EncounteredError')
    elif mode == 'future':
        # Corrupt final sample duration: playback must still end, within the EOS bound.
        require(end_limit_ms is not None, 'future: no end limit supplied')
        require(266 not in ids, 'future: EncounteredError reported')
        require(265 in ids, 'future: EndReached missing; EOS clock not bounded')
        end = next(e['atMs'] for e in rows if e['eventType'] == 265)
        require(end <= end_limit_ms, f'future: EndReached at {end:.0f} ms, limit {end_limit_ms} ms')
    else:
        require(265 in ids, f'{mode}: EndReached missing')
        require(266 not in ids, f'{mode}: EncounteredError reported')
        require(not any(e['failed'] for e in rows), f'{mode}: source failure recorded')
        require(10001 in ids, f'{mode}: source EOF not reached')
        stats = data['stats']
        require(stats and stats[0]['valid'], f'{mode}: playback statistics missing or invalid')
        require(stats[0]['decodedAudio'] > 0 and stats[0]['playedAudioBuffers'] > 0, f'{mode}: no audio decoded/played')
        # Stock VLC 3.0.24 drops the first late buffers of non-pace-controlled input too.
        require(stats[0]['lostAudioBuffers'] == 0 or mode == 'nonseek', f'{mode}: lost audio buffers')
        require(stats[0]['demuxCorrupted'] == 0, f'{mode}: demux corruption reported')
        if mode == 'seek':
            require(10005 in ids, 'seek: seek request not recorded')
        else:
            # Non-seekable input reports no length; its time is buffering-adjusted, so no residual.
            positions = [e for e in rows if e['eventType'] == 10000 and e['mediaTimeMs'] > 0
                         and (e['lengthMs'] > 0 or mode == 'nonseek')]
            require(positions, f'{mode}: no position samples')
            if mode != 'nonseek':
                residual = positions[-1]['lengthMs'] - positions[-1]['mediaTimeMs']
                require(0 <= residual <= 500, f'{mode}: final residual {residual} ms outside 0..500')
            require(all(b['mediaTimeMs'] >= a['mediaTimeMs'] for a, b in zip(positions, positions[1:])),
                    f'{mode}: media time went backwards')
    # Public media time is not an independent PCR measurement.
    # This standalone production probe does not measure raw PCR.


def check_run(loader, mode):
    require(loader['valid'], f'{mode}: VLC loader paths differ from the runtime under test')
    require(loader['exitCode'] == 0, f'{mode}: native probe exit code {loader["exitCode"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--ffmpeg-libdir', type=Path, required=True, help='same FFmpeg lib directory used by the app')
    parser.add_argument('--fixture', type=Path, required=True, help='existing short unprotected equal-valid.m4a')
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    spec = importlib.util.spec_from_file_location('vlc_build', REPO / 'scripts/build-vlc-mp4.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_runtime(runtime)
    if not args.ffmpeg_libdir.is_dir():
        raise ValueError('matching app FFmpeg library directory is missing')
    if subprocess.check_output(['pkg-config', '--modversion', 'libvlc'], text=True).strip() != '3.0.24':
        raise ValueError('matching libVLC 3.0.24 SDK required for probe build')
    root = REPO / 'electron/dist/playback01-validation'
    root.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    command = ['gcc', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
               str(REPO / 'scripts/tests/vlc_native_probe.c'), '-o', str(out / 'probe'),
               *shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'libvlc'], text=True))]
    with (out / 'probe-build.log').open('x') as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    env = dict(os.environ, PLAYBACK01_NATIVE_PROBE='1', LD_LIBRARY_PATH=str(runtime) + os.pathsep + str(args.ffmpeg_libdir.resolve()),
               VLC_PLUGIN_PATH=str(runtime / 'plugins'))
    env.pop('LD_PRELOAD', None)
    future = out / ('future' + args.fixture.suffix)
    future.write_bytes(set_final_duration(args.fixture.read_bytes(), 0xFFFFFFFF))
    summary, end_limit_ms = {}, None
    for mode in ['natural', 'seek', 'failure', 'lifecycle', 'nonseek', 'future']:
        fixture, timeout = args.fixture.resolve(), 15
        if mode == 'future':
            fixture, timeout = future, end_limit_ms // 1000 + 5
        argv = [str(out / 'probe'), str(fixture), str(timeout)] + ([] if mode in ('natural', 'future') else [mode])
        paths = set()
        with (out / f'{mode}.json').open('x') as stdout, (out / f'{mode}.log').open('x') as stderr:
            proc = subprocess.Popen(argv, env=env, stdout=stdout, stderr=stderr)
            deadline = time.monotonic() + timeout + 35
            try:
                while proc.poll() is None:
                    paths.update(vlc_paths(proc.pid))
                    if time.monotonic() > deadline:
                        raise RuntimeError('probe timeout: ' + mode)
                    time.sleep(.05)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
        loader = {'valid': paths == expected_paths(runtime), 'paths': sorted(paths), 'exitCode': proc.returncode}
        (out / f'{mode}-loader.json').write_text(json.dumps(loader, indent=2))
        check_run(loader, mode)
        data = json.loads((out / f'{mode}.json').read_text())
        validate(data, mode, end_limit_ms)
        if mode == 'natural':
            # Media length plus the EOS bound, with 5 s for start-up and output drain.
            end_limit_ms = max(e['lengthMs'] for e in data['events']) + EOS_BOUND_MS + 5000
        summary[mode] = 'PASS'
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(f'{len(summary)} development integration cases PASS: {out}\nRaw PCR: NOT_MEASURED (production plugin).')


if __name__ == '__main__':
    main()
