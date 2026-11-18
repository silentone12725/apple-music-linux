"""Synthetic-probe result validation: no compiler, player or runtime needed."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('validator', SCRIPTS / 'validate-vlc-mp4.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def natural():
    rows = [{'eventType': t, 'generation': 1, 'failed': False, 'mediaTimeMs': -1, 'lengthMs': -1}
            for t in (260, 10001, 265)]
    rows += [{'eventType': 10000, 'generation': 1, 'failed': False, 'mediaTimeMs': t, 'lengthMs': 5000}
             for t in (1000, 3000, 4900)]
    stats = [{'valid': True, 'decodedAudio': 10, 'playedAudioBuffers': 10, 'lostAudioBuffers': 0, 'demuxCorrupted': 0}]
    return {'ok': True, 'events': rows, 'dropped': 0, 'stats': stats}


def broken(change):
    data = copy.deepcopy(natural())
    change(data)
    return data


INVALID = {
    'ok false': broken(lambda d: d.update(ok=False)),
    'no events': broken(lambda d: d.update(events=[])),
    'dropped events': broken(lambda d: d.update(dropped=3)),
    'EndReached missing': broken(lambda d: d.update(events=[e for e in d['events'] if e['eventType'] != 265])),
    'stats missing': broken(lambda d: d.update(stats=[])),
    'stats invalid': broken(lambda d: d['stats'][0].update(valid=False)),
    'stats incomplete': broken(lambda d: d['stats'][0].pop('lostAudioBuffers')),
    'residual over limit': broken(lambda d: d['events'][-1].update(mediaTimeMs=2270)),
    'time backwards': broken(lambda d: d['events'][-2].update(mediaTimeMs=4950)),
}
LOADERS = {'loader path mismatch': {'valid': False, 'exitCode': 0},
           'probe exit non-zero': {'valid': True, 'exitCode': 2}}


class ValidatorTests(unittest.TestCase):
    def test_valid_natural_run_passes(self):
        m.validate(natural(), 'natural')
        m.check_run({'valid': True, 'exitCode': 0}, 'natural')

    def test_invalid_results_are_rejected(self):
        for name, data in INVALID.items():
            with self.subTest(name), self.assertRaises(m.ValidationError):
                m.validate(data, 'natural')
        for name, loader in LOADERS.items():
            with self.subTest(name), self.assertRaises(m.ValidationError):
                m.check_run(loader, 'natural')

    def test_optimized_python_still_rejects_invalid_results(self):
        # python -O strips asserts; every rejection must survive it.
        code = f"""
import importlib.util, sys
sys.path.insert(0, {str(SCRIPTS)!r}); sys.path.insert(0, {str(Path(__file__).parent)!r})
assert False, 'not optimized'
""" + """
import test_validate_vlc_mp4 as t
failed = []
for name, data in t.INVALID.items():
    try: t.m.validate(data, 'natural'); failed.append(name)
    except t.m.ValidationError: pass
for name, loader in t.LOADERS.items():
    try: t.m.check_run(loader, 'natural'); failed.append(name)
    except t.m.ValidationError: pass
t.m.validate(t.natural(), 'natural')
print('accepted:', failed); sys.exit(1 if failed else 0)
"""
        result = subprocess.run([sys.executable, '-O', '-B', '-c', code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
