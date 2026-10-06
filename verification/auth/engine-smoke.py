#!/usr/bin/env python3
"""Check packaged startup/restart; optionally restore a private copy of a session.

Usage: python3 verification/auth/engine-smoke.py [--session-directory DIR]
The supplied session is copied, never modified. No tokens appear in output.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--session-directory', type=Path)
parser.add_argument('--require-ready', action='store_true', help='require a restored authenticated FairPlay session')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
resources = repo / 'electron/dist/linux-unpacked/resources'
context = ssl._create_unverified_context()
with tempfile.TemporaryDirectory(prefix='aml-engine-smoke-') as temporary:
    work = Path(temporary)
    files = work / 'files'
    if args.session_directory:
        shutil.copytree(args.session_directory, files)
    config = {'storefront': 'us', 'drm-binary-path': str(repo / 'drm/drm-native'), 'drm-base-dir': str(files)}
    (work / 'config.yaml').write_text('\n'.join(f'{k}: {json.dumps(v)}' for k, v in config.items()) + '\n')
    env = dict(os.environ, LD_LIBRARY_PATH=f'{resources}/vlc:{resources}/ffmpeg/lib',
               VLC_PLUGIN_PATH=f'{resources}/vlc/plugins', GODEBUG='netdns=go')
    with (work / 'engine.log').open('w') as log:
        for attempt in range(2):
            proc = subprocess.Popen([str(resources / 'engine'), '--api', '20125'], cwd=work, env=env, stdout=log, stderr=log)
            try:
                status = None
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise RuntimeError('engine exited during startup/restoration')
                    try:
                        with urllib.request.urlopen('https://127.0.0.1:20125/api/v1/drm/status', context=context, timeout=1) as response:
                            status = json.load(response)
                        state = status['state']
                        if not args.session_directory or state['authentication'] == 'failed' or state['fairplay'] == 'ready':
                            break
                    except urllib.error.URLError:
                        pass
                    time.sleep(.2)
                else:
                    raise RuntimeError('startup/restoration did not finish within 40 seconds')
                assert status['backend']['selected'] == 'native'
                if args.require_ready:
                    assert state['authentication'] == 'logged_in', 'saved account did not restore'
                    assert state['fairplay'] == 'ready', 'restored FairPlay is not ready'
                    assert status.get('capabilities', {}).get('cbcs') is True
                if not args.session_directory:
                    assert status['state']['authentication'] != 'logged_in'
                    assert not status.get('capabilities', {}).get('cbcs', False)
                request = urllib.request.Request('https://127.0.0.1:20125/api/v1/drm/challenge', data=b'{"reply":"123456"}',
                                                 headers={'Content-Type': 'application/json'}, method='POST')
                try:
                    urllib.request.urlopen(request, context=context)
                    raise AssertionError('unrequested code accepted')
                except urllib.error.HTTPError as error:
                    assert error.code == 409
                time.sleep(.5)
                assert proc.poll() is None
                print(f'PASS: startup {attempt + 1}, native backend, restoration handled, unrequested code rejected')
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=10)
            assert proc.returncode == 0, f'engine shutdown failed ({proc.returncode})'
            assert (files / 'engine-session.lock').exists()
    print('PASS: graceful shutdown/restart, flock file retained')
