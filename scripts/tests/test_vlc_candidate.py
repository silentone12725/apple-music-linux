"""Pure static integration tests: no compiler, player, network or login."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch as mock_patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('vlc_build', ROOT / 'scripts/build-vlc-mp4.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CandidateTests(unittest.TestCase):
    def test_reviewed_patch_is_byte_identical(self):
        patch = ROOT / 'patches/vlc/3.0.24/playback01-candidate-c.patch'
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(),
                         '9eac960942eba7d147c662811c0a48013d797151eb16d9210c56edff18f3bb09')
        ref = json.loads((patch.parent / 'runtime-abi.json').read_text())
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(), ref['patchSHA256'])

    def test_hunks_are_applied_exactly_once(self):
        filler = ''.join(f'line {i}\n' for i in range(20))
        before = 'header\nold1\n' + filler + 'old2\nfooter\n'
        after = 'header\nnew1\n' + filler + 'new2\nfooter\n'
        patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='baseline/mp4.c', tofile='candidate/mp4.c'))
        self.assertEqual(sum(line.startswith('@@ ') for line in patch.splitlines()), 2)
        self.assertEqual(m.apply_candidate(before, patch), after)
        for source in [after, 'foreign source\n', before.replace('old2', 'other'),
                       before.replace('old1', 'new1'), before + before]:
            with self.assertRaises(ValueError):
                m.apply_candidate(source, patch)

    def test_reviewed_patch_applies_to_the_pinned_source_shape(self):
        patch = (ROOT / 'patches/vlc/3.0.24/playback01-candidate-c.patch').read_text()
        self.assertEqual(sum(line.startswith('@@ ') for line in patch.splitlines()), 3)
        for needle in ['b_exhausted_bound = false;', 'i_exhausted_bound );', 'DEMUX_TRACK_MAX_PRELOAD']:
            self.assertIn(needle, patch)


    def test_runtime_verification_rejects_foreign_plugin_and_core(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            runtime, patches = base / 'vlc', base / 'patches'
            (runtime / 'plugins/demux').mkdir(parents=True)
            patches.mkdir()
            (runtime / 'core.so').write_bytes(b'known core')
            plugin = runtime / 'plugins/demux/libmp4_plugin.so'
            plugin.write_bytes(b'Candidate C')
            (patches / 'playback01-candidate-c.patch').write_bytes(b'reviewed patch')
            reference = {'patchSHA256': m.digest(patches / 'playback01-candidate-c.patch'),
                         'runtimeHashes': {'core.so': m.digest(runtime / 'core.so')}}
            (patches / 'runtime-abi.json').write_text(json.dumps(reference))
            info = dict(reference, pluginSHA256=m.digest(plugin))
            (runtime / m.MARKER).write_text(json.dumps(info))
            with mock_patch.object(m, 'PATCH_DIR', patches):
                self.assertEqual(m.verify_runtime(runtime), info)
                plugin.write_bytes(b'foreign plugin')
                with self.assertRaises(ValueError):
                    m.verify_runtime(runtime)
                plugin.write_bytes(b'Candidate C')
                (runtime / 'core.so').write_bytes(b'foreign core')
                with self.assertRaises(ValueError):
                    m.verify_runtime(runtime)


if __name__ == '__main__':
    unittest.main()
