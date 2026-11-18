"""Synthetic-probe result validation: no compiler, player or runtime needed."""
import copy
import importlib.util
from pathlib import Path
import struct
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import mp4_fixture as fixture  # noqa: E402
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


def future(end_ms):
    rows = [{'eventType': 260, 'generation': 1, 'failed': False, 'atMs': 10, 'mediaTimeMs': -1, 'lengthMs': -1}]
    if end_ms is not None:
        rows.append({'eventType': 265, 'generation': 1, 'failed': False, 'atMs': end_ms, 'mediaTimeMs': -1, 'lengthMs': -1})
    return {'ok': True, 'events': rows, 'dropped': 0, 'stats': []}


def box(kind, body):
    return struct.pack('>I4s', 8 + len(body), kind) + body


def fragment(flags, durations):
    entries = b''.join(struct.pack('>II', d, 100) for d in durations)  # duration + size
    trun = box(b'trun', struct.pack('>I', flags) + struct.pack('>Ii', len(durations), 0) + entries)
    return box(b'moof', box(b'traf', box(b'tfhd', bytes(8)) + trun)) + box(b'mdat', b'x')


class FixtureTests(unittest.TestCase):
    def test_only_the_final_sample_duration_changes(self):
        data = box(b'ftyp', b'isom') + fragment(0x301, [4096, 4096]) + fragment(0x301, [4096, 1275])
        changed = fixture.set_final_duration(data, 0xFFFFFFFF)
        diff = [i for i, (a, b) in enumerate(zip(data, changed)) if a != b]
        self.assertEqual(len(changed), len(data))
        self.assertEqual(len(diff), 4)
        self.assertEqual(struct.unpack_from('>I', changed, diff[0])[0], 0xFFFFFFFF)
        self.assertEqual(data[:diff[0]].count(b'\x00\x00\x04\xfb'), 0)  # the 1275 entry itself

    def test_unsupported_fixtures_are_rejected(self):
        for data in [box(b'ftyp', b'isom'), fragment(0x201, [4096]), b'\x00\x00\x00\x10moof']:
            with self.subTest(data=data[:12]), self.assertRaises(ValueError):
                fixture.set_final_duration(data, 1)


class ValidatorTests(unittest.TestCase):
    def test_future_mode_requires_bounded_end(self):
        m.validate(future(20000), 'future', 26500)
        for data, limit in [(future(None), 26500), (future(40000), 26500), (future(20000), None)]:
            with self.subTest(limit=limit), self.assertRaises(m.ValidationError):
                m.validate(data, 'future', limit)

    def test_nonseek_accepts_unknown_length_but_not_backwards_time(self):
        data = natural()
        for e in data['events']:
            e['lengthMs'] = 0 if e['eventType'] == 10000 else e['lengthMs']
        data['stats'][0]['lostAudioBuffers'] = 3
        m.validate(data, 'nonseek')
        with self.assertRaises(m.ValidationError):
            m.validate(data, 'natural')
        data['stats'][0]['demuxCorrupted'] = 1
        with self.assertRaises(m.ValidationError):
            m.validate(data, 'nonseek')
        data['stats'][0]['demuxCorrupted'] = 0
        data['events'][-2]['mediaTimeMs'] = 4950
        with self.assertRaises(m.ValidationError):
            m.validate(data, 'nonseek')

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
